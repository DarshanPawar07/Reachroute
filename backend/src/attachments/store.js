import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { Attachment, Campaign, EmailCampaign } from '../models.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { HEAD_BYTES, detectType } from './types.js';

const log = logger.child({ mod: 'attachments' });
export const MB = 1024 * 1024;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const UNFINISHED = ['preparing', 'running', 'paused'];

/** What one message may carry, by channel. WhatsApp sends one file with its text; an email may carry a few. */
export const RULES = {
  whatsapp: { maxFiles: 1, maxTotalBytes: null, sizeLimit: 'waAttachmentMb' },
  // Mail servers stop at about 25 MB and files grow by a third when mailed, so the files together stay at 15 MB.
  email: { maxFiles: 5, maxTotalBytes: 15 * MB, sizeLimit: 'emailAttachmentMb' },
};

let bucket = null;
export const getBucket = () => (bucket ||= new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'attachments' }));

const fmtMb = (bytes) => `${Math.round((bytes / MB) * 10) / 10} MB`;

/**
 * Write an uploaded file into GridFS as it arrives (never all in memory), counting its size and fingerprint, and refusing it
 * early when it is too big or is not what its ending says. Returns { gridId, size, sha256, type: { ext, mime, kind } }.
 */
export async function ingest(stream, { filename, maxBytes }) {
  const hash = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  let type = null;
  let held = [];
  const guard = new Transform({
    transform(chunk, _encoding, cb) {
      try {
        size += chunk.length;
        if (size > maxBytes) throw bad(`That file is too large. The limit is ${fmtMb(maxBytes)}.`, 413);
        hash.update(chunk);
        if (type) return cb(null, chunk);
        held.push(chunk);
        head = Buffer.concat([head, chunk]);
        if (head.length < HEAD_BYTES) return cb();
        type = detectType(filename, head.subarray(0, HEAD_BYTES)); // known now: let what was held go on
        const out = Buffer.concat(held);
        held = [];
        cb(null, out);
      } catch (err) {
        cb(err);
      }
    },
    flush(cb) {
      try {
        if (size === 0) throw bad('That file is empty.');
        if (!type) {
          type = detectType(filename, head); // a small file: everything is still held
          this.push(Buffer.concat(held));
          held = [];
        }
        cb();
      } catch (err) {
        cb(err);
      }
    },
  });
  const upload = getBucket().openUploadStream(`attachment-${randomUUID()}`, { chunkSizeBytes: 255 * 1024 });
  try {
    await pipeline(stream, guard, upload);
  } catch (err) {
    await upload.abort().catch(() => {});
    throw err;
  }
  return { gridId: upload.id, size, sha256: hash.digest('hex'), type };
}

export const removeStoredFile = (gridId) => getBucket().delete(gridId).catch(() => {});

// ------------------------------------------------------------------ reading a file for sending

const cache = new Map(); // attachment id -> { promise, bytes, at }
const CACHE_MAX_BYTES = 96 * MB;
const CACHE_TTL_MS = 10 * 60_000;
let cacheBytes = 0;

export const forgetAttachment = (id) => {
  const hit = cache.get(String(id));
  if (hit) {
    cacheBytes -= hit.bytes;
    cache.delete(String(id));
  }
};
export const clearAttachmentCache = () => {
  cache.clear();
  cacheBytes = 0;
};

const missing = () => Object.assign(new Error('An attachment of this campaign is no longer available'), { code: 'ATTACHMENT_MISSING' });

async function readFile(doc) {
  const chunks = [];
  const stream = getBucket().openDownloadStream(doc.gridId);
  try {
    for await (const chunk of stream) chunks.push(chunk);
  } catch (err) {
    if (/FileNotFound/i.test(err.name + err.message)) throw missing();
    throw err;
  }
  const buffer = Buffer.concat(chunks);
  if (createHash('sha256').update(buffer).digest('hex') !== doc.sha256) {
    log.error({ attachmentId: String(doc._id) }, 'stored file does not match its fingerprint');
    throw Object.assign(new Error('An attachment of this campaign is damaged'), { code: 'ATTACHMENT_MISSING' });
  }
  return buffer;
}

/**
 * The bytes of one attachment of this account, with its name and type: { buffer, name, mime, kind }.
 * Files are remembered for a few minutes, so a campaign to thousands of people reads each file from the database once.
 * Throws code ATTACHMENT_MISSING when the file was deleted.
 */
export async function loadAttachment(userId, attachmentId) {
  const key = String(attachmentId);
  const now = Date.now();
  let hit = cache.get(key);
  if (hit && now - hit.at > CACHE_TTL_MS) {
    forgetAttachment(key);
    hit = null;
  }
  const doc = await Attachment.findOne({ _id: attachmentId, userId }).lean(); // also proves the file belongs to this account
  if (!doc) {
    forgetAttachment(key);
    throw missing();
  }
  if (!hit) {
    const entry = { at: now, bytes: doc.size, promise: null };
    entry.promise = readFile(doc);
    cache.set(key, entry);
    cacheBytes += doc.size;
    entry.promise.catch(() => forgetAttachment(key)); // a failed read is not kept
    while (cacheBytes > CACHE_MAX_BYTES && cache.size > 1) forgetAttachment(cache.keys().next().value); // oldest first
    hit = entry;
  }
  return { buffer: await hit.promise, name: doc.name, mime: doc.mime, kind: doc.kind };
}

// ------------------------------------------------------------------ the library

export async function usageOf(userId) {
  const [row] = await Attachment.aggregate([{ $match: { userId: new mongoose.Types.ObjectId(String(userId)) } }, { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$size' } } }]);
  return { count: row?.count || 0, bytes: row?.bytes || 0 };
}

export const present = (a) => ({ id: a._id, name: a.name, kind: a.kind, mime: a.mime, size: a.size, createdAt: a.createdAt, lastUsedAt: a.lastUsedAt });

/** Ids from a form field: a JSON list, a comma separated list, or an array. Duplicates are dropped. */
export function parseIds(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  let list = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.startsWith('[')) {
      try {
        list = JSON.parse(text);
      } catch {
        throw bad('attachmentIds must be a list of attachment ids');
      }
    } else {
      list = text.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) throw bad('attachmentIds must be a list of attachment ids');
  if (list.length > 20) throw bad('Too many attachments');
  const ids = [];
  for (const id of list) {
    if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) throw bad('One of the attachment ids is not valid');
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Check the attachments chosen for a campaign against this channel's rules and this account's limits.
 * Returns the snapshot stored on the campaign: [{ attachmentId, name, size, mime, kind }].
 */
export async function resolveForCampaign(userId, raw, channel, limits) {
  const ids = parseIds(raw);
  if (!ids.length) return [];
  const rule = RULES[channel];
  if (ids.length > rule.maxFiles) {
    throw bad(channel === 'whatsapp' ? 'A WhatsApp message can carry one file. Choose just one attachment.' : `An email can carry up to ${rule.maxFiles} attachments.`);
  }
  const docs = await Attachment.find({ _id: { $in: ids }, userId }).lean();
  if (docs.length !== ids.length) throw bad('One of the attachments was not found. Upload it again.', 404);
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const ordered = ids.map((id) => byId.get(id));
  const perFile = limits[rule.sizeLimit] * MB;
  for (const d of ordered) {
    if (d.size > perFile) throw bad(`"${d.name}" is ${fmtMb(d.size)}. The largest ${channel === 'whatsapp' ? 'WhatsApp' : 'email'} attachment on your plan is ${fmtMb(perFile)}.`);
  }
  if (rule.maxTotalBytes && ordered.reduce((sum, d) => sum + d.size, 0) > rule.maxTotalBytes) {
    throw bad(`The attachments together are too big for one email. Keep them under ${fmtMb(rule.maxTotalBytes)} in total.`);
  }
  return ordered.map((d) => ({ attachmentId: d._id, name: d.name, size: d.size, mime: d.mime, kind: d.kind }));
}

export async function markUsed(refs) {
  if (refs.length) await Attachment.updateMany({ _id: { $in: refs.map((r) => r.attachmentId) } }, { $set: { lastUsedAt: new Date() } });
}

/** Ids of the attachments that a campaign still waiting or sending will need. */
async function neededIds() {
  const [a, b] = await Promise.all([
    Campaign.distinct('attachments.attachmentId', { status: { $in: UNFINISHED } }),
    EmailCampaign.distinct('attachments.attachmentId', { status: { $in: UNFINISHED } }),
  ]);
  return new Set([...a, ...b].map(String));
}

/** Delete one of an account's files. Refused (409) while an unfinished campaign still has to send it. */
export async function deleteAttachment(userId, id) {
  const doc = await Attachment.findOne({ _id: id, userId }).lean();
  if (!doc) throw bad('Attachment not found', 404);
  const [w, e] = await Promise.all([
    Campaign.countDocuments({ userId, status: { $in: UNFINISHED }, 'attachments.attachmentId': doc._id }),
    EmailCampaign.countDocuments({ userId, status: { $in: UNFINISHED }, 'attachments.attachmentId': doc._id }),
  ]);
  if (w + e) throw bad(`${w + e} unfinished campaign${w + e === 1 ? ' still needs' : 's still need'} this file. Finish or cancel ${w + e === 1 ? 'it' : 'them'} first.`, 409);
  await Attachment.deleteOne({ _id: doc._id });
  await removeStoredFile(doc.gridId);
  forgetAttachment(doc._id);
  return { name: doc.name, size: doc.size };
}

/**
 * Housekeeping: delete files nobody has used for ATTACHMENT_RETENTION_DAYS (and no unfinished campaign needs), and
 * stored files that have no record (an upload that was cut off) once they are an hour old.
 */
export async function purgeAttachments({ now = Date.now() } = {}) {
  let stale = 0;
  let orphans = 0;
  if (config.attachmentRetentionDays > 0) {
    const cutoff = new Date(now - config.attachmentRetentionDays * DAY);
    const needed = await neededIds();
    const old = await Attachment.find({ $or: [{ lastUsedAt: { $lt: cutoff } }, { lastUsedAt: null, createdAt: { $lt: cutoff } }] }).select('_id gridId').limit(500).lean();
    for (const doc of old) {
      if (needed.has(String(doc._id))) continue;
      await Attachment.deleteOne({ _id: doc._id });
      await removeStoredFile(doc.gridId);
      forgetAttachment(doc._id);
      stale += 1;
    }
  }
  const files = mongoose.connection.db.collection('attachments.files');
  const candidates = await files.find({ uploadDate: { $lt: new Date(now - HOUR) } }, { projection: { _id: 1 } }).limit(1000).toArray();
  if (candidates.length) {
    const known = new Set((await Attachment.find({ gridId: { $in: candidates.map((c) => c._id) } }).select('gridId').lean()).map((a) => String(a.gridId)));
    for (const file of candidates) {
      if (known.has(String(file._id))) continue;
      await removeStoredFile(file._id);
      orphans += 1;
    }
  }
  if (stale || orphans) log.info({ stale, orphans }, 'attachment clean-up');
  return { stale, orphans };
}

/** Run the clean-up now and then every hour. Returns { stop }. */
export function startAttachmentPurge() {
  const run = () => purgeAttachments().catch((err) => log.error({ err: err.message }, 'attachment clean-up failed'));
  const first = setTimeout(run, 60_000); // not during start-up
  const timer = setInterval(run, HOUR);
  first.unref();
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
