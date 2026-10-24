import mongoose from 'mongoose';
import { config } from '../config.js';
import { AuditLog, User } from '../models.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ mod: 'audit' });

const HOUR = 60 * 60_000;
const ACTION = /^[a-z][a-z0-9_.]{0,39}$/;
const MAX_DETAIL = 500;
const clip = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** The parts of a request an entry needs: who is asking, from where, and the id to find the request in the log. */
export const fromReq = (req) => ({ actorId: req.userId || null, ip: req.ip || '', requestId: req.id || '' });

/**
 * Add an entry. Fields: action (required, like "user.suspended"), actorId / actorEmail, targetId / targetEmail,
 * ip, requestId, detail (short text; never put secrets in it). A missing email is looked up from the id.
 *
 * Never throws: a problem with the audit log must not undo or block what the person was doing. A failure is
 * logged as an error together with the whole entry, so it can still be found. Returns true when it was saved.
 */
export async function record(entry) {
  try {
    if (!ACTION.test(String(entry?.action ?? ''))) throw new Error(`not a valid action name: ${entry?.action}`);
    const emailOf = async (id, given) => {
      if (given) return String(given);
      if (!id || !mongoose.isValidObjectId(id)) return '';
      return (await User.findById(id).select('email').lean())?.email || '';
    };
    const [actorEmail, targetEmail] = await Promise.all([emailOf(entry.actorId, entry.actorEmail), emailOf(entry.targetId, entry.targetEmail)]);
    await AuditLog.create({
      action: entry.action,
      actorId: entry.actorId || null,
      actorEmail,
      targetId: entry.targetId || null,
      targetEmail,
      ip: clip(entry.ip, 64),
      requestId: clip(entry.requestId, 64),
      detail: clip(entry.detail, MAX_DETAIL),
    });
    return true;
  } catch (err) {
    log.error({ err: err.message, entry: { ...entry, detail: clip(entry?.detail, MAX_DETAIL) } }, 'could not save an audit entry');
    return false;
  }
}

const asId = (value, label) => {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) throw bad(`${label} is not a valid id`);
  return value;
};
const asDate = (value, label) => {
  if (value === undefined || value === '') return null;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw bad(`${label} must be a date like 2026-10-22 or 2026-10-22T09:30:00Z`);
  return new Date(ms);
};

/**
 * A page of entries, newest first. Filters: actor / target (account ids), email (the address of either side),
 * action, from / to (dates). All are checked, so bad input is a clear 400.
 */
export async function listAudit(query = {}) {
  // Checked on what was sent, before any defaults: a repeated parameter arrives as a list, which is refused.
  const { actor, target, email, action, from, to, page, limit } = query;
  for (const value of [actor, target, email, action, from, to, page, limit]) {
    if (value !== undefined && typeof value !== 'string') throw bad('Each filter can be given only once');
  }
  const filter = {};
  const actorId = asId(actor, 'actor');
  const targetId = asId(target, 'target');
  if (actorId) filter.actorId = actorId;
  if (targetId) filter.targetId = targetId;
  if (email) {
    const address = clip(email, 320).toLowerCase();
    filter.$or = [{ actorEmail: address }, { targetEmail: address }];
  }
  if (action) {
    if (!ACTION.test(action)) throw bad('That is not a valid action name');
    filter.action = action;
  }
  const since = asDate(from, 'from');
  const until = asDate(to, 'to');
  if (since || until) filter.at = { ...(since ? { $gte: since } : {}), ...(until ? { $lte: until } : {}) };

  const size = Math.min(200, Math.max(1, Number(limit) || 50));
  const pageNo = Math.max(1, Math.floor(Number(page)) || 1);
  const [total, rows] = await Promise.all([
    AuditLog.countDocuments(filter).maxTimeMS(5000),
    AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip((pageNo - 1) * size).limit(size).maxTimeMS(5000).lean(),
  ]);
  return {
    entries: rows.map((r) => ({
      id: r._id,
      at: r.at,
      action: r.action,
      actor: r.actorId || r.actorEmail ? { id: r.actorId, email: r.actorEmail } : null, // null = the command line
      target: r.targetId || r.targetEmail ? { id: r.targetId, email: r.targetEmail } : null,
      ip: r.ip,
      requestId: r.requestId,
      detail: r.detail,
    })),
    total,
    page: pageNo,
    pages: Math.max(1, Math.ceil(total / size)),
    limit: size,
  };
}

/** Delete entries older than AUDIT_RETENTION_DAYS (0 = keep forever). Returns how many were removed. */
export async function purgeAudit({ now = Date.now(), days = config.auditRetentionDays } = {}) {
  if (!days) return 0;
  const result = await AuditLog.deleteMany({ at: { $lt: new Date(now - days * 24 * HOUR) } });
  if (result.deletedCount) log.info({ removed: result.deletedCount }, 'purged old audit entries');
  return result.deletedCount;
}

/** Run the clean-up now and then every hour. Returns { stop }. */
export function startAuditPurge() {
  const run = () => purgeAudit().catch((err) => log.error({ err: err.message }, 'audit clean-up failed'));
  run();
  const timer = setInterval(run, HOUR);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
