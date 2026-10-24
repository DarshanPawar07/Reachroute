import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Backup and restore against a THROW-AWAY MongoDB database (the name must contain "test"). Example:
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/bulk_messenger_test npm test
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';

const mongoose = (await import('mongoose')).default;
const models = await import('../src/models.js');
const backup = await import('../src/backup/backup.js');
const { Template, ContactList } = models;

let root;
const userId = new mongoose.Types.ObjectId();
const T = { skip, timeout: 30_000 };

before(async () => {
  if (!URI) return;
  await mongoose.connect(URI);
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bm-backup-'));
});

after(async () => {
  if (!URI) return;
  await Template.deleteMany({ userId });
  await ContactList.deleteMany({ userId });
  await mongoose.disconnect();
  await fsp.rm(root, { recursive: true, force: true });
});

const seed = async () => {
  await Template.deleteMany({});
  await Template.collection.insertMany([
    { userId, kind: 'whatsapp', name: 'One', message: 'Hi {{name}} — ünïcode ✓', createdAt: new Date('2026-01-02T03:04:05.678Z'), updatedAt: new Date('2026-01-02T03:04:05.678Z') },
    { userId, kind: 'email', name: 'Two', subject: 's', body: 'line1\nline2 "quoted"', bodyFormat: 'text', createdAt: new Date(), updatedAt: new Date() },
  ]);
};
const ONLY = ['templates'];

test('the default list covers every collection of the app except locks', T, () => {
  const names = backup.defaultCollections();
  assert.ok(names.includes('users') && names.includes('recipients') && names.includes('emailrecipients') && names.includes('templates'));
  assert.ok(!names.includes('locks'));
});

test('a backup is written, checked, and listed', T, async () => {
  await seed();
  const { dir, manifest } = await backup.createBackup({ root, collections: ONLY });
  assert.equal(manifest.collections.length, 1);
  assert.equal(manifest.collections[0].name, 'templates');
  assert.equal(manifest.collections[0].documents, 2);
  assert.match(path.basename(dir), /^\d{8}-\d{6}Z$/);
  assert.equal((await fsp.readdir(root)).filter((n) => n.endsWith('.partial')).length, 0, 'no unfinished folder is left');
  assert.ok((await backup.verifyBackup(dir)).collections.length === 1);
  const list = await backup.listBackups(root);
  assert.equal(list[0].dir, dir);
  assert.equal(list[0].documents, 2);
});

test('restore brings back identical documents, with dates and ids intact', T, async () => {
  await seed();
  const before = await Template.collection.find({}).sort({ name: 1 }).toArray();
  const { dir } = await backup.createBackup({ root, collections: ONLY, now: new Date(Date.now() + 1000) });
  await Template.deleteMany({});
  const { restored } = await backup.restoreBackup(dir);
  assert.deepEqual(restored, [{ name: 'templates', documents: 2 }]);
  const after = await Template.collection.find({}).sort({ name: 1 }).toArray();
  assert.deepEqual(after, before);
  assert.ok(after[0]._id instanceof mongoose.Types.ObjectId);
  assert.ok(after[0].createdAt instanceof Date);
});

test('restore refuses to mix into data that is already there, unless told to replace it', T, async () => {
  await seed();
  const { dir } = await backup.createBackup({ root, collections: ONLY, now: new Date(Date.now() + 2000) });
  await Template.collection.insertOne({ userId, kind: 'whatsapp', name: 'Extra', message: 'x', createdAt: new Date(), updatedAt: new Date() });
  await assert.rejects(backup.restoreBackup(dir), /already contain data: templates/);
  assert.equal(await Template.countDocuments({}), 3, 'nothing changed');
  await backup.restoreBackup(dir, { replace: true });
  assert.equal(await Template.countDocuments({}), 2, 'the extra document is gone');
  await assert.rejects(backup.restoreBackup(dir, { replace: true, only: ['nope'] }), /no collection named nope/);
});

test('a damaged or incomplete backup is detected and never restored', T, async () => {
  await seed();
  const { dir } = await backup.createBackup({ root, collections: ONLY, now: new Date(Date.now() + 3000) });
  const file = path.join(dir, 'templates.ndjson.gz');
  const bytes = await fsp.readFile(file);
  bytes[bytes.length - 12] ^= 0xff;
  await fsp.writeFile(file, bytes);
  await assert.rejects(backup.verifyBackup(dir), /templates: .*(changed or damaged|cannot be read)/);
  await Template.deleteMany({});
  await assert.rejects(backup.restoreBackup(dir), /Backup check failed/);
  assert.equal(await Template.countDocuments({}), 0, 'nothing was restored');

  await fsp.rm(file);
  await assert.rejects(backup.verifyBackup(dir), /file is missing/);
  await fsp.rm(path.join(dir, 'manifest.json'));
  await assert.rejects(backup.verifyBackup(dir), /not a complete backup/);
  assert.ok(!(await backup.listBackups(root)).some((b) => b.dir === dir), 'a folder without a manifest is not a backup');
});

test('a manifest cannot point outside the backup folder', T, async () => {
  await seed();
  const { dir, manifest } = await backup.createBackup({ root, collections: ONLY, now: new Date(Date.now() + 4000) });
  manifest.collections[0].file = '../../evil.ndjson.gz';
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(backup.verifyBackup(dir), /file name that is not allowed/);
});

test('old backups are removed, the newest are kept, stale unfinished folders go too', T, async () => {
  const prune = await fsp.mkdtemp(path.join(os.tmpdir(), 'bm-prune-'));
  try {
    await seed();
    const base = Date.now() + 10_000;
    const made = [];
    for (let i = 0; i < 4; i++) made.push((await backup.createBackup({ root: prune, collections: ONLY, now: new Date(base + i * 1000) })).dir);
    const stale = path.join(prune, '20200101-000000Z.partial');
    await fsp.mkdir(stale);
    await fsp.utimes(stale, new Date('2020-01-01'), new Date('2020-01-01'));
    const fresh = path.join(prune, '20990101-000000Z.partial');
    await fsp.mkdir(fresh);

    const { removed } = await backup.pruneBackups(prune, { keep: 2 });
    assert.equal(removed.length, 3);
    const left = (await backup.listBackups(prune)).map((b) => b.dir);
    assert.deepEqual(left, [made[3], made[2]]);
    await assert.rejects(fsp.stat(stale));
    await fsp.stat(fresh); // a backup that may still be running is not touched
    await assert.rejects(backup.pruneBackups(prune, { keep: 0 }), /at least 1/);
  } finally {
    await fsp.rm(prune, { recursive: true, force: true });
  }
});

test('an empty collection backs up and restores as empty', T, async () => {
  await ContactList.deleteMany({});
  const { dir, manifest } = await backup.createBackup({ root, collections: ['contactlists'], now: new Date(Date.now() + 20_000) });
  assert.equal(manifest.collections[0].documents, 0);
  assert.deepEqual((await backup.restoreBackup(dir)).restored, [{ name: 'contactlists', documents: 0 }]);
});
