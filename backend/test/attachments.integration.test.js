import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Attachments (upload, library, limits, campaigns, deleting, clean-up) against a THROW-AWAY MongoDB database (name must contain "test").
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
process.env.SMTP_HOST = '';
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const { config } = await import('../src/config.js');
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const S = await import('../src/attachments/store.js');
const { User, SmtpSettings, EmailCampaign, EmailRecipient, Attachment, AuditLog } = models;

config.requireTermsAcceptance = false;
config.requireEmailVerification = false;
config.allowPrivateSmtp = true;
config.maxActiveCampaigns = 50;
const original = { wa: config.waAttachmentMb, email: config.emailAttachmentMb, storage: config.attachmentStorageMb, days: config.attachmentRetentionDays, max: config.maxActiveCampaigns };

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 60_000 };
const tag = `att${Date.now().toString(36)}`;
const made = [];
let server;
let base;
let counter = 0;

before(async () => {
  if (!URI) return;
  await mongoose.connect(URI);
  await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
  server = http.createServer(buildApp({ ...createLimiters(), register: (_req, _res, next) => next() }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!URI) return;
  config.waAttachmentMb = original.wa;
  config.emailAttachmentMb = original.email;
  config.attachmentStorageMb = original.storage;
  config.attachmentRetentionDays = original.days;
  config.maxActiveCampaigns = original.max;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const ids = made.map((u) => u.id);
  const files = await Attachment.find({ userId: { $in: ids } }).select('gridId').lean();
  for (const f of files) await S.removeStoredFile(f.gridId);
  await Promise.all([
    User.deleteMany({ _id: { $in: ids } }),
    SmtpSettings.deleteMany({ userId: { $in: ids } }),
    Attachment.deleteMany({ userId: { $in: ids } }),
    EmailCampaign.deleteMany({ userId: { $in: ids } }),
    EmailRecipient.deleteMany({ userId: { $in: ids } }),
    AuditLog.deleteMany({ actorId: { $in: ids } }),
  ]);
  await mongoose.disconnect();
});

async function call(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: form || (json === undefined ? undefined : JSON.stringify(json)) });
  const raw = Buffer.from(await res.arrayBuffer());
  let body = {};
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, raw, headers: res.headers };
}
const say = (r) => JSON.stringify(r.body);

async function newUser() {
  const email = `u${counter++}.${tag}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201, say(res));
  const user = { email, token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
  made.push(user);
  return user;
}

/** A user whose own SMTP settings are saved and whose "from" address counts as proven. */
async function emailUser() {
  const u = await newUser();
  const fromEmail = `from.${tag}.${counter}@example.com`;
  const saved = await call('PUT', '/api/email/settings', { token: u.token, json: { host: 'smtp.example.com', port: 587, user: 'me', pass: 'secret-password', fromEmail, fromName: 'Me' } });
  assert.equal(saved.status, 200, say(saved));
  await SmtpSettings.updateOne({ userId: u.id }, { $set: { verifiedEmail: fromEmail, verifiedAt: new Date() } });
  return u;
}

const pdfBytes = (size = 200, fill = 'a') => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size, fill)]);
const upload = (u, bytes, name = 'offer.pdf') => {
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), name);
  return call('POST', '/api/attachments', { token: u.token, form: fd });
};
const emailForm = (ids) => {
  const fd = new FormData();
  fd.append('name', 'with files');
  fd.append('subject', 'Hi');
  fd.append('body', 'Hello {{name}}');
  fd.append('consentConfirmed', 'true');
  if (ids !== undefined) fd.append('attachmentIds', typeof ids === 'string' ? ids : JSON.stringify(ids));
  fd.append('file', new Blob([`name,email\nAsha,asha.${tag}@example.com\n`], { type: 'text/csv' }), 'c.csv');
  return fd;
};
const startEmail = (u, ids) => call('POST', '/api/email/campaigns', { token: u.token, form: emailForm(ids) });

test('upload, list, download, and the same file twice', T, async () => {
  const u = await newUser();
  const bytes = pdfBytes(5000, 'q');
  const up = await upload(u, bytes, 'My Offer.pdf');
  assert.equal(up.status, 201, say(up));
  assert.equal(up.body.attachment.name, 'My Offer.pdf');
  assert.equal(up.body.attachment.kind, 'document');
  assert.equal(up.body.attachment.size, bytes.length);
  assert.equal(up.body.duplicate, false);

  const list = await call('GET', '/api/attachments', { token: u.token });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.usage.files, 1);
  assert.equal(list.body.usage.bytes, bytes.length);
  assert.equal(list.body.limits.whatsappFileMb, config.waAttachmentMb);

  const down = await call('GET', `/api/attachments/${up.body.attachment.id}/download`, { token: u.token });
  assert.equal(down.status, 200);
  assert.equal(down.headers.get('content-type'), 'application/pdf');
  assert.ok(down.raw.equals(bytes), 'the file comes back unchanged');

  const again = await upload(u, bytes, 'copy.pdf');
  assert.equal(again.status, 200, say(again));
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.attachment.id, up.body.attachment.id);
  assert.equal((await call('GET', '/api/attachments', { token: u.token })).body.items.length, 1);

  const plan = await call('GET', '/api/account/plan', { token: u.token });
  assert.equal(plan.body.usage.attachments, 1);
  assert.equal(plan.body.usage.storageBytes, bytes.length);

  assert.equal((await call('GET', '/api/attachments')).status, 401);
  assert.equal((await call('POST', '/api/attachments')).status, 401);
});

test('other accounts cannot see, download, delete or use the file', T, async () => {
  const owner = await newUser();
  const other = await newUser();
  const up = await upload(owner, pdfBytes(300, 'z'));
  const id = up.body.attachment.id;
  assert.equal((await call('GET', '/api/attachments', { token: other.token })).body.items.length, 0);
  assert.equal((await call('GET', `/api/attachments/${id}/download`, { token: other.token })).status, 404);
  assert.equal((await call('DELETE', `/api/attachments/${id}`, { token: other.token })).status, 404);
  assert.equal((await call('GET', '/api/attachments/not-an-id/download', { token: owner.token })).status, 404);
  await assert.rejects(S.loadAttachment(other.id, id), (e) => e.code === 'ATTACHMENT_MISSING');
  assert.equal((await S.loadAttachment(owner.id, id)).kind, 'document');
});

test('wrong kinds of files, fake files and empty files are refused, and nothing is left stored', T, async () => {
  const u = await newUser();
  const files = mongoose.connection.db.collection('attachments.files');
  const before = await files.countDocuments();
  const exe = await upload(u, Buffer.from('MZ\x90\x00 program'), 'setup.exe');
  assert.equal(exe.status, 400, say(exe));
  assert.match(exe.body.error, /cannot be sent/);
  const fake = await upload(u, Buffer.from('just text, not a pdf at all'), 'fake.pdf');
  assert.equal(fake.status, 400, say(fake));
  assert.match(fake.body.error, /does not look like a real \.pdf/);
  const empty = await upload(u, Buffer.alloc(0), 'empty.pdf');
  assert.equal(empty.status, 400, say(empty));
  const none = await call('POST', '/api/attachments', { token: u.token, form: new FormData() });
  assert.equal(none.status, 400, say(none));
  assert.equal(await files.countDocuments(), before, 'no half-uploaded files remain');
  assert.equal(await Attachment.countDocuments({ userId: u.id }), 0);
});

test('the size limit and the storage limit are enforced while the file arrives', T, async () => {
  config.waAttachmentMb = 1;
  config.emailAttachmentMb = 1;
  config.attachmentStorageMb = 2;
  try {
    const u = await newUser();
    const files = mongoose.connection.db.collection('attachments.files');
    const before = await files.countDocuments();
    const big = await upload(u, pdfBytes(1.5 * 1024 * 1024));
    assert.equal(big.status, 413, say(big));
    assert.match(big.body.error, /limit is 1 MB/);
    assert.equal(await files.countDocuments(), before, 'a refused file is not kept');

    assert.equal((await upload(u, pdfBytes(900 * 1024, 'a'), 'one.pdf')).status, 201);
    assert.equal((await upload(u, pdfBytes(900 * 1024, 'b'), 'two.pdf')).status, 201);
    const third = await upload(u, pdfBytes(900 * 1024, 'c'), 'three.pdf'); // 2 MB storage: only about 0.2 MB is left
    assert.equal(third.status, 413, say(third));
    const list = await call('GET', '/api/attachments', { token: u.token });
    assert.equal(list.body.items.length, 2);
    assert.equal(list.body.usage.limitBytes, 2 * 1024 * 1024);
  } finally {
    config.waAttachmentMb = original.wa;
    config.emailAttachmentMb = original.email;
    config.attachmentStorageMb = original.storage;
  }
});

test('an email campaign keeps its attachments, and the rules are checked', T, async () => {
  const u = await emailUser();
  const a = (await upload(u, pdfBytes(400, 'a'), 'a.pdf')).body.attachment;
  const b = (await upload(u, pdfBytes(400, 'b'), 'b.pdf')).body.attachment;

  const ok = await startEmail(u, [a.id, b.id]);
  assert.equal(ok.status, 201, say(ok));
  assert.deepEqual(ok.body.campaign.attachments.map((x) => x.name), ['a.pdf', 'b.pdf']);
  assert.equal(ok.body.campaign.attachments[0].attachmentId, a.id);
  assert.ok((await Attachment.findById(a.id)).lastUsedAt, 'use is remembered');

  assert.equal((await startEmail(u)).body.campaign.attachments.length, 0, 'attachments are optional');
  assert.equal((await startEmail(u, `${a.id}`)).status, 201, 'a plain id works too');

  const bad = await startEmail(u, ['507f1f77bcf86cd799439011']);
  assert.equal(bad.status, 404, say(bad));
  assert.equal((await startEmail(u, 'nope')).status, 400);

  const stranger = await newUser();
  const theirs = (await upload(stranger, pdfBytes(400, 'x'), 'x.pdf')).body.attachment;
  assert.equal((await startEmail(u, [theirs.id])).status, 404, 'someone else\'s file cannot be attached');

  // more than five
  const six = [a.id, b.id];
  for (let i = 0; i < 4; i++) six.push((await upload(u, pdfBytes(300, String(i)), `f${i}.pdf`)).body.attachment.id);
  const tooMany = await startEmail(u, six);
  assert.equal(tooMany.status, 400, say(tooMany));
  assert.match(tooMany.body.error, /up to 5/);

  // a file bigger than the email limit (it was accepted at upload because the WhatsApp limit is higher)
  const big = (await upload(u, pdfBytes(1.2 * 1024 * 1024, 'm'), 'mid.pdf')).body.attachment;
  config.emailAttachmentMb = 1;
  try {
    const refused = await startEmail(u, [big.id]);
    assert.equal(refused.status, 400, say(refused));
    assert.match(refused.body.error, /largest email attachment on your plan/);
  } finally {
    config.emailAttachmentMb = original.email;
  }
});

test('a WhatsApp message takes one file, and the total size of an email is capped', T, async () => {
  const u = await newUser();
  const a = (await upload(u, pdfBytes(300, 'a'), 'a.pdf')).body.attachment;
  const b = (await upload(u, pdfBytes(300, 'b'), 'b.pdf')).body.attachment;
  const limits = { waAttachmentMb: 16, emailAttachmentMb: 10 };
  assert.deepEqual(await S.resolveForCampaign(u.id, [], 'whatsapp', limits), []);
  const one = await S.resolveForCampaign(u.id, [a.id], 'whatsapp', limits);
  assert.equal(one.length, 1);
  assert.equal(one[0].name, 'a.pdf');
  await assert.rejects(S.resolveForCampaign(u.id, [a.id, b.id], 'whatsapp', limits), /one file/);

  // together over 15 MB: made-up sizes on the records are enough to test the rule
  await Attachment.updateMany({ _id: { $in: [a.id, b.id] } }, { $set: { size: 9 * 1024 * 1024 } });
  await assert.rejects(S.resolveForCampaign(u.id, [a.id, b.id], 'email', limits), /together are too big/);
  await assert.rejects(S.resolveForCampaign(u.id, [a.id], 'whatsapp', { ...limits, waAttachmentMb: 8 }), /largest WhatsApp attachment on your plan/);
});

test('a file cannot be deleted while an unfinished campaign needs it', T, async () => {
  const u = await emailUser();
  const a = (await upload(u, pdfBytes(400, 'd'), 'keep.pdf')).body.attachment;
  const campaign = (await startEmail(u, [a.id])).body.campaign;
  const { gridId } = await Attachment.findById(a.id).lean();

  const refused = await call('DELETE', `/api/attachments/${a.id}`, { token: u.token });
  assert.equal(refused.status, 409, say(refused));
  assert.match(refused.body.error, /1 unfinished campaign still needs this file/);
  assert.equal(await Attachment.countDocuments({ _id: a.id }), 1);

  assert.equal((await call('POST', `/api/email/campaigns/${campaign.id || campaign._id}/cancel`, { token: u.token })).status, 200);
  const gone = await call('DELETE', `/api/attachments/${a.id}`, { token: u.token });
  assert.equal(gone.status, 200, say(gone));
  assert.equal(await Attachment.countDocuments({ _id: a.id }), 0);
  assert.equal(await mongoose.connection.db.collection('attachments.files').countDocuments({ _id: gridId }), 0, 'the stored file is removed too');
  await assert.rejects(S.loadAttachment(u.id, a.id), (e) => e.code === 'ATTACHMENT_MISSING');
  assert.equal(await AuditLog.countDocuments({ actorId: u.id, action: 'attachment.delete' }), 1);
});

test('the sending code gets the exact bytes, and notices a file that was changed or lost', T, async () => {
  const u = await newUser();
  const bytes = pdfBytes(3000, 'k');
  const a = (await upload(u, bytes, 'real.pdf')).body.attachment;
  S.clearAttachmentCache();
  const loaded = await S.loadAttachment(u.id, a.id);
  assert.ok(loaded.buffer.equals(bytes));
  assert.equal(loaded.mime, 'application/pdf');
  assert.equal(loaded.name, 'real.pdf');
  assert.equal((await S.loadAttachment(u.id, a.id)).buffer, loaded.buffer, 'the second read comes from memory');

  // the stored record no longer matches the bytes: refuse to send it
  S.clearAttachmentCache();
  await Attachment.updateOne({ _id: a.id }, { $set: { sha256: 'f'.repeat(64) } });
  await assert.rejects(S.loadAttachment(u.id, a.id), (e) => e.code === 'ATTACHMENT_MISSING');

  // the stored file itself is gone
  const doc = await Attachment.findById(a.id).lean();
  await S.removeStoredFile(doc.gridId);
  S.clearAttachmentCache();
  await assert.rejects(S.loadAttachment(u.id, a.id), (e) => e.code === 'ATTACHMENT_MISSING');
});

test('clean-up removes old unused files and cut-off uploads, never a file an unfinished campaign needs', T, async () => {
  const u = await emailUser();
  const unused = (await upload(u, pdfBytes(300, '1'), 'unused.pdf')).body.attachment;
  const needed = (await upload(u, pdfBytes(300, '2'), 'needed.pdf')).body.attachment;
  const recent = (await upload(u, pdfBytes(300, '3'), 'recent.pdf')).body.attachment;
  await startEmail(u, [needed.id]);
  const longAgo = new Date(Date.now() - 200 * 86_400_000);
  await Attachment.updateMany({ _id: { $in: [unused.id, needed.id] } }, { $set: { createdAt: longAgo, lastUsedAt: longAgo } });

  // a stored file with no record (an upload that was cut off), made old enough
  const orphanId = await new Promise((resolve, reject) => {
    const s = S.getBucket().openUploadStream('orphan');
    s.on('finish', () => resolve(s.id));
    s.on('error', reject);
    s.end(Buffer.from('lost'));
  });
  await mongoose.connection.db.collection('attachments.files').updateOne({ _id: orphanId }, { $set: { uploadDate: new Date(Date.now() - 3 * 3_600_000) } });

  config.attachmentRetentionDays = 90;
  try {
    const result = await S.purgeAttachments();
    assert.ok(result.stale >= 1 && result.orphans >= 1, JSON.stringify(result));
  } finally {
    config.attachmentRetentionDays = original.days;
  }
  assert.equal(await Attachment.countDocuments({ _id: unused.id }), 0, 'old and unused: removed');
  assert.equal(await Attachment.countDocuments({ _id: needed.id }), 1, 'an unfinished campaign still needs it');
  assert.equal(await Attachment.countDocuments({ _id: recent.id }), 1, 'recent: kept');
  assert.equal(await mongoose.connection.db.collection('attachments.files').countDocuments({ _id: orphanId }), 0, 'orphan removed');
  assert.ok(await S.loadAttachment(u.id, recent.id));
});

test('with retention switched off nothing old is removed', T, async () => {
  const u = await newUser();
  const a = (await upload(u, pdfBytes(300, '9'), 'old.pdf')).body.attachment;
  await Attachment.updateOne({ _id: a.id }, { $set: { createdAt: new Date(Date.now() - 900 * 86_400_000), lastUsedAt: null } });
  config.attachmentRetentionDays = 0;
  try {
    await S.purgeAttachments();
  } finally {
    config.attachmentRetentionDays = original.days;
  }
  assert.equal(await Attachment.countDocuments({ _id: a.id }), 1);
});
