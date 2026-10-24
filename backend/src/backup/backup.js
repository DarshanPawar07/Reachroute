import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import readline from 'node:readline';
import mongoose from 'mongoose';
import { Attachment, Lock } from '../models.js'; // importing the models registers every collection

/**
 * Backups that need nothing installed: each collection is streamed into a gzip file of one JSON document per line
 * (MongoDB Extended JSON, so dates, ids and numbers come back exactly), with a manifest of counts and checksums.
 * Works on any MongoDB, Atlas free tier included.
 *
 * A backup folder looks like  backups/20261021-134500Z/  with  <collection>.ndjson.gz  and  manifest.json.
 * It is written as "<name>.partial" and renamed only when complete, so a crashed backup is never mistaken for a good one.
 * Collections are read one after another, not in one snapshot: a message sent during the backup can appear in one file
 * and not another. Restoring is safe, but run it while nothing is sending when you can.
 */

const EJSON = mongoose.mongo.BSON?.EJSON ?? (await import('bson')).EJSON;

const FORMAT_VERSION = 1;
const FOLDER = /^\d{8}-\d{6}Z$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const STALE_PARTIAL_MS = 24 * 60 * 60_000;
const RESTORE_BATCH = 500;
// Short-lived locks (nothing worth keeping) and the attachment records: the files themselves live in GridFS and are not part of
// a backup (they can be large and can be uploaded again), so keeping only their records would list files that no longer exist.
const EXCLUDED = new Set([Lock.collection.name, Attachment.collection.name]);

const fail = (message) => Object.assign(new Error(message), { backup: true });

/** Every collection the app uses (except locks). */
export const defaultCollections = () => [...new Set(Object.values(mongoose.models).map((m) => m.collection.name))].filter((n) => !EXCLUDED.has(n)).sort();

const folderName = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');

// ---------------------------------------------------------------- writing

async function dumpCollection(db, name, file) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let documents = 0;
  async function* lines() {
    for await (const doc of db.collection(name).find({}, { batchSize: 1000 })) {
      documents += 1;
      yield `${EJSON.stringify(doc, { relaxed: false })}\n`;
    }
  }
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(Readable.from(lines()), zlib.createGzip({ level: 6 }), meter, fs.createWriteStream(file));
  return { name, file: path.basename(file), documents, bytes, sha256: hash.digest('hex') };
}

/**
 * Write a new backup under `root` and check it by reading it back.
 * `collections` limits what is saved (default: everything the app uses).
 */
export async function createBackup({ root, collections = defaultCollections(), now = new Date() }) {
  if (mongoose.connection.readyState !== 1) throw fail('Not connected to the database.');
  for (const name of collections) if (!NAME.test(name)) throw fail(`"${name}" is not a usable collection name.`);
  const db = mongoose.connection.db;
  const name = folderName(now);
  const finalDir = path.join(root, name);
  const partialDir = `${finalDir}.partial`;
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(partialDir); // fails if two backups start in the same second: better than mixing them

  try {
    const entries = [];
    for (const collection of collections) entries.push(await dumpCollection(db, collection, path.join(partialDir, `${collection}.ndjson.gz`)));
    const manifest = { version: FORMAT_VERSION, createdAt: now.toISOString(), database: db.databaseName, collections: entries };
    await fsp.writeFile(path.join(partialDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fsp.rename(partialDir, finalDir);
    await verifyBackup(finalDir);
    return { dir: finalDir, manifest };
  } catch (err) {
    await fsp.rm(partialDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------- reading

export async function readManifest(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw fail(`${dir} is not a complete backup (manifest.json is missing or unreadable).`);
  }
  if (manifest.version !== FORMAT_VERSION || !Array.isArray(manifest.collections)) throw fail('This backup was made by a different version and cannot be read.');
  for (const e of manifest.collections) {
    if (!NAME.test(e.name) || e.file !== `${e.name}.ndjson.gz`) throw fail('The manifest lists a file name that is not allowed.');
  }
  return manifest;
}

/** Read a collection file once: its checksum, size and number of documents. */
async function inspectFile(file) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let documents = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  const counter = new Writable({
    write(chunk, _enc, cb) {
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) documents += 1; // one document per line
      cb();
    },
  });
  await pipeline(fs.createReadStream(file), meter, zlib.createGunzip(), counter);
  return { documents, bytes, sha256: hash.digest('hex') };
}

/** Check every file against the manifest. Returns the manifest, or throws with every problem found. */
export async function verifyBackup(dir) {
  const manifest = await readManifest(dir);
  const problems = [];
  for (const e of manifest.collections) {
    try {
      const got = await inspectFile(path.join(dir, e.file));
      if (got.sha256 !== e.sha256 || got.bytes !== e.bytes) problems.push(`${e.name}: the file was changed or damaged`);
      else if (got.documents !== e.documents) problems.push(`${e.name}: expected ${e.documents} documents, found ${got.documents}`);
    } catch (err) {
      problems.push(`${e.name}: ${err.code === 'ENOENT' ? 'file is missing' : `cannot be read (${err.message})`}`);
    }
  }
  if (problems.length) throw fail(`Backup check failed: ${problems.join('; ')}.`);
  return manifest;
}

/**
 * Put a backup back. By default every collection to restore must be empty (so nothing is overwritten by accident);
 * `replace: true` clears them first. `only` restores just those collections. The backup is checked before anything changes.
 */
export async function restoreBackup(dir, { replace = false, only = null } = {}) {
  if (mongoose.connection.readyState !== 1) throw fail('Not connected to the database.');
  const manifest = await verifyBackup(dir);
  const wanted = only ? new Set(only) : null;
  if (wanted) {
    const known = new Set(manifest.collections.map((e) => e.name));
    const unknown = [...wanted].filter((n) => !known.has(n));
    if (unknown.length) throw fail(`The backup has no collection named ${unknown.join(', ')}.`);
  }
  const entries = manifest.collections.filter((e) => !wanted || wanted.has(e.name));
  const db = mongoose.connection.db;

  if (!replace) {
    const occupied = [];
    for (const e of entries) if (await db.collection(e.name).findOne({}, { projection: { _id: 1 } })) occupied.push(e.name);
    if (occupied.length) throw fail(`These collections already contain data: ${occupied.join(', ')}. Restore into an empty database, or use replace to clear them first.`);
  }

  const restored = [];
  for (const e of entries) {
    const collection = db.collection(e.name);
    if (replace) await collection.deleteMany({});
    let count = 0;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      await collection.insertMany(batch, { ordered: false });
      count += batch.length;
      batch = [];
    };
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, e.file)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      batch.push(EJSON.parse(line, { relaxed: false }));
      if (batch.length >= RESTORE_BATCH) await flush();
    }
    await flush();
    restored.push({ name: e.name, documents: count });
  }
  return { restored };
}

// ---------------------------------------------------------------- housekeeping

/** Complete backups under `root`, newest first. */
export async function listBackups(root) {
  let names;
  try {
    names = await fsp.readdir(root);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const found = [];
  for (const name of names.filter((n) => FOLDER.test(n)).sort().reverse()) {
    try {
      const m = await readManifest(path.join(root, name));
      found.push({ name, dir: path.join(root, name), createdAt: m.createdAt, collections: m.collections.length, documents: m.collections.reduce((n, e) => n + e.documents, 0) });
    } catch {
      /* a folder without a valid manifest is not a backup */
    }
  }
  return found;
}

/** Keep the newest `keep` complete backups and remove the rest, plus unfinished ones left by a crash over a day ago. */
export async function pruneBackups(root, { keep, now = Date.now() }) {
  if (!Number.isInteger(keep) || keep < 1) throw fail('keep must be at least 1.');
  const removed = [];
  const backups = await listBackups(root);
  for (const b of backups.slice(keep)) {
    await fsp.rm(b.dir, { recursive: true, force: true });
    removed.push(b.name);
  }
  for (const name of await fsp.readdir(root).catch(() => [])) {
    if (!name.endsWith('.partial')) continue;
    const stat = await fsp.stat(path.join(root, name)).catch(() => null);
    if (stat && now - stat.mtimeMs > STALE_PARTIAL_MS) {
      await fsp.rm(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return { removed };
}
