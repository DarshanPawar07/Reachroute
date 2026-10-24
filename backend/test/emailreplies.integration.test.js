import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Reading email replies from a mailbox (a fake in-memory one), against a THROW-AWAY MongoDB database (name must contain "test").
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
const { User, SmtpSettings, EmailCampaign, EmailRecipient, EmailReply, EmailOptOut, ImapSettings, Notification } = models;
const imap = await import('../src/email/imap.js');

config.requireTermsAcceptance = false;
config.requireEmailVerification = false;
config.allowPrivateSmtp = true;

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 60_000 };
const tag = `rep${Date.now().toString(36)}`;
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
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const ids = made.map((u) => u.id);
  await Promise.all([
    User.deleteMany({ _id: { $in: ids } }),
    SmtpSettings.deleteMany({ userId: { $in: ids } }),
    EmailCampaign.deleteMany({ userId: { $in: ids } }),
    EmailRecipient.deleteMany({ userId: { $in: ids } }),
    EmailReply.deleteMany({ userId: { $in: ids } }),
    EmailOptOut.deleteMany({ userId: { $in: ids } }),
    ImapSettings.deleteMany({ userId: { $in: ids } }),
    Notification.deleteMany({ userId: { $in: ids } }),
  ]);
  imap.setImapClientFactory(null);
  imap.setMessageParser(null);
  await mongoose.disconnect();
});

async function call(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: form || (json === undefined ? undefined : JSON.stringify(json)) });
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8'); // unlike res.text(), this keeps a byte order mark
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, text, headers: res.headers };
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

async function emailUser() {
  const u = await newUser();
  const fromEmail = `from.${tag}.${counter}@example.com`;
  const saved = await call('PUT', '/api/email/settings', { token: u.token, json: { host: 'smtp.example.com', port: 587, user: 'me', pass: 'secret-password', fromEmail, fromName: 'Me' } });
  assert.equal(saved.status, 200, say(saved));
  await SmtpSettings.updateOne({ userId: u.id }, { $set: { verifiedEmail: fromEmail, verifiedAt: new Date() } });
  return u;
}


// A mailbox in memory. `box.mail` is the list of { uid, msg }; `box.fail` makes every call fail like a bad login.
function fakeMailbox({ uidValidity = 7 } = {}) {
  const box = { uidValidity, mail: [], fail: null, calls: 0, reads: [] };
  box.add = (msg) => {
    const uid = box.mail.length + 1;
    box.mail.push({ uid, msg });
    return uid;
  };
  imap.setImapClientFactory(async () => ({
    async test() {
      if (box.fail) throw box.fail;
      return { uidValidity: box.uidValidity, uidNext: box.mail.length + 1 };
    },
    async read({ uidValidity: seen, afterUid, limit }) {
      box.calls++;
      if (box.fail) throw box.fail;
      const state = { uidValidity: box.uidValidity, uidNext: box.mail.length + 1 };
      box.reads.push({ seen, afterUid });
      if (afterUid == null || seen !== box.uidValidity) return { ...state, baseline: true, messages: [] };
      const messages = box.mail.filter((m) => m.uid > afterUid).slice(0, limit).map((m) => ({ uid: m.uid, source: JSON.stringify(m.msg) }));
      return { ...state, baseline: false, messages };
    },
  }));
  return box;
}
imap.setMessageParser(async (source) => {
  const m = JSON.parse(source);
  if (m.bad) throw new Error('unreadable message');
  return { ...m, date: m.date ? new Date(m.date) : new Date(), headers: m.headers || {} };
});

const mail = (from, text, extra = {}) => ({ messageId: `<${tag}.${counter++}@mail>`, from: { address: from, name: '' }, subject: 'Re: Hi', text, ...extra });
const saveImap = (u) => call('PUT', '/api/email/imap', { token: u.token, json: { host: 'imap.example.com', port: 993, user: 'me@example.com', pass: 'mailbox-password' } });
const settingsOf = (u) => ImapSettings.findOne({ userId: u.id });

/** A user with a campaign whose people were all "sent". */
async function sentCampaign(extra = {}) {
  const u = await emailUser();
  const res = await call('POST', '/api/email/campaigns', {
    token: u.token,
    form: (() => {
      const fd = new FormData();
      fd.append('name', 'Replies');
      fd.append('subject', 'Hi {{name}}');
      for (const [k, v] of Object.entries(extra)) fd.append(k, v);
      fd.append('body', 'Hello');
      fd.append('consentConfirmed', 'true');
      fd.append('file', new Blob([`name,email\nAsha,asha.${tag}.${counter}@example.com\nBen,ben.${tag}.${counter}@example.com\n`], { type: 'text/csv' }), 'c.csv');
      return fd;
    })(),
  });
  assert.equal(res.status, 201, say(res));
  await EmailRecipient.updateMany({ campaignId: res.body.campaign._id }, { $set: { status: 'sent', sentAt: new Date() } });
  const rows = await EmailRecipient.find({ campaignId: res.body.campaign._id }).sort({ name: 1 }).lean();
  return { u, campaign: res.body.campaign, asha: rows[0], ben: rows[1] };
}

test('saving proves the login first; a wrong login saves nothing', T, async () => {
  const u = await newUser();
  const box = fakeMailbox();
  box.fail = Object.assign(new Error('bad'), { authenticationFailed: true });
  const bad = await saveImap(u);
  assert.equal(bad.status, 400, say(bad));
  assert.match(bad.body.error, /refused the login/);
  assert.equal(await ImapSettings.countDocuments({ userId: u.id }), 0);

  box.fail = null;
  const ok = await saveImap(u);
  assert.equal(ok.status, 200, say(ok));
  assert.equal(ok.body.settings.hasPassword, true);
  assert.equal(JSON.stringify(ok.body).includes('mailbox-password'), false);
  const row = await settingsOf(u);
  assert.notEqual(row.passEncrypted, 'mailbox-password');
  assert.ok(row.passEncrypted.length > 20);
  const got = await call('GET', '/api/email/imap', { token: u.token });
  assert.equal(got.body.settings.user, 'me@example.com');
  assert.equal(JSON.stringify(got.body).includes(row.passEncrypted), false);
});

test('bad IMAP input is refused', T, async () => {
  const u = await newUser();
  fakeMailbox();
  for (const json of [{ host: 'https://x.com', user: 'a', pass: 'p' }, { host: 'imap.example.com', port: 0, user: 'a', pass: 'p' }, { host: 'imap.example.com', user: '', pass: 'p' }, { host: 'imap.example.com', user: 'a' }]) {
    const res = await call('PUT', '/api/email/imap', { token: u.token, json });
    assert.equal(res.status, 400, say(res));
  }
  assert.equal(await ImapSettings.countDocuments({ userId: u.id }), 0);
});

test('mail from before the reader was switched on is never read; a reply after it is stored', T, async () => {
  const { u, asha } = await sentCampaign();
  const box = fakeMailbox();
  box.add(mail(asha.email, 'old mail before setup'));
  assert.equal((await saveImap(u)).status, 200);

  let check = await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(check.status, 200, say(check));
  assert.equal(check.body.stored, 0);
  assert.equal((await settingsOf(u)).lastUid, 1); // the starting point, nothing read
  assert.equal(await EmailReply.countDocuments({ userId: u.id }), 0);

  box.add(mail(asha.email, 'Yes, interested!\n\nOn Mon, Ben wrote:\n> Hello'));
  check = await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(check.body.stored, 1, say(check));
  const list = await call('GET', '/api/email/replies', { token: u.token });
  assert.equal(list.body.replies.length, 1);
  assert.equal(list.body.replies[0].text, 'Yes, interested!');
  assert.equal(list.body.replies[0].campaignName, 'Replies');
  assert.equal(list.body.unread, 1);
  assert.equal(list.body.replies[0].optOut, false);

  // The same mailbox is not read twice.
  check = await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(check.body.stored, 0);
  assert.equal(await EmailReply.countDocuments({ userId: u.id }), 1);

  const note = await Notification.findOne({ userId: u.id, type: 'email-replies' });
  assert.ok(note, 'the owner is told about the new reply');
});

test('only people the account emailed are kept; robots, itself and strangers are not', T, async () => {
  const { u, asha } = await sentCampaign();
  const box = fakeMailbox();
  assert.equal((await saveImap(u)).status, 200);
  await call('POST', '/api/email/imap/check', { token: u.token });
  const own = (await SmtpSettings.findOne({ userId: u.id })).fromEmail;
  box.add(mail(`stranger.${tag}@example.com`, 'hello, who is this'));
  box.add(mail(asha.email, 'I am away', { subject: 'Automatic reply: away', headers: { 'auto-submitted': 'auto-replied' } }));
  box.add(mail(own, 'a note to myself'));
  box.add(mail(`mailer-daemon@example.com`, 'delivery failed'));
  box.add(mail(asha.email, 'Please send the brochure'));
  const check = await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(check.body.stored, 1, say(check));
  const rows = await EmailReply.find({ userId: u.id }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, asha.email);
});

test('a short "stop" reply puts the person on the do-not-email list', T, async () => {
  const { u, campaign, asha } = await sentCampaign();
  const box = fakeMailbox();
  assert.equal((await saveImap(u)).status, 200);
  await call('POST', '/api/email/imap/check', { token: u.token });
  box.add(mail(asha.email, 'Please unsubscribe me'));
  const check = await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(check.body.optOuts, 1, say(check));
  const stop = await EmailOptOut.findOne({ userId: u.id, email: asha.email });
  assert.ok(stop);
  assert.equal(stop.reason, 'unsubscribed');
  const row = await EmailRecipient.findById(asha._id).lean();
  assert.equal(row.feedback, 'unsubscribed');

  const detail = await call('GET', `/api/email/campaigns/${campaign._id}`, { token: u.token });
  assert.equal(detail.body.campaign.replies.total, 1);
  assert.equal(detail.body.campaign.replies.optOuts, 1);
  assert.equal(detail.body.campaign.feedback.unsubscribed, 1);
});

test('replies are counted per campaign and per A/B subject line', T, async () => {
  const { u, campaign } = await sentCampaign({ subjectB: 'Offer for {{name}}', splitB: '50' });
  const people = await EmailRecipient.find({ campaignId: campaign._id }).lean();
  const a = people.find((p) => p.variant === 'A');
  const b = people.find((p) => p.variant === 'B');
  assert.ok(a && b);
  const box = fakeMailbox();
  assert.equal((await saveImap(u)).status, 200);
  await call('POST', '/api/email/imap/check', { token: u.token });
  box.add(mail(b.email, 'Great offer'));
  box.add(mail(b.email, 'One more question'));
  await call('POST', '/api/email/imap/check', { token: u.token });

  const detail = await call('GET', `/api/email/campaigns/${campaign._id}`, { token: u.token });
  assert.equal(detail.body.campaign.replies.total, 2);
  assert.equal(detail.body.campaign.replies.people, 1);
  assert.equal(detail.body.campaign.variants.B.replies, 2);
  assert.equal(detail.body.campaign.variants.A.replies || 0, 0);

  const per = await call('GET', '/api/email/replies/campaigns', { token: u.token });
  assert.equal(per.body.campaigns[0].replies, 2);
});

test('mark read, unread count and delete work, and only for the owner', T, async () => {
  const { u, asha } = await sentCampaign();
  const other = await newUser();
  const box = fakeMailbox();
  assert.equal((await saveImap(u)).status, 200);
  await call('POST', '/api/email/imap/check', { token: u.token });
  box.add(mail(asha.email, 'one'));
  box.add(mail(asha.email, 'two'));
  await call('POST', '/api/email/imap/check', { token: u.token });

  assert.equal((await call('GET', '/api/email/replies/unread-count', { token: u.token })).body.unread, 2);
  assert.equal((await call('GET', '/api/email/replies', { token: other.token })).body.replies.length, 0);
  const list = (await call('GET', '/api/email/replies', { token: u.token })).body.replies;
  const denied = await call('DELETE', `/api/email/replies/${list[0]._id}`, { token: other.token });
  assert.equal(denied.status, 404);
  const read = await call('POST', '/api/email/replies/read', { token: u.token, json: { id: list[0]._id } });
  assert.equal(read.body.unread, 1);
  const del = await call('DELETE', `/api/email/replies/${list[1]._id}`, { token: u.token });
  assert.equal(del.status, 200);
  assert.equal(del.body.unread, 0);
});

test('a failing mailbox is remembered, backed off, and recovers', T, async () => {
  const u = await newUser();
  const box = fakeMailbox();
  assert.equal((await saveImap(u)).status, 200);
  await call('POST', '/api/email/imap/check', { token: u.token });

  box.fail = Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
  const check = await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(check.status, 422, say(check));
  let row = await settingsOf(u);
  assert.equal(row.errorCount, 1);
  assert.match(row.lastError, /in time/);
  assert.ok(row.nextCheckAt.getTime() > Date.now() + 60_000, 'waits longer after a failure');
  assert.equal(row.leaseUntil, null);

  box.fail = null;
  const ok = await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(ok.status, 200, say(ok));
  row = await settingsOf(u);
  assert.equal(row.errorCount, 0);
  assert.equal(row.lastError, '');
});

test('a changed mailbox (new UID validity) starts again from now instead of re-reading', T, async () => {
  const { u, asha } = await sentCampaign();
  const box = fakeMailbox({ uidValidity: 1 });
  assert.equal((await saveImap(u)).status, 200);
  await call('POST', '/api/email/imap/check', { token: u.token });
  box.add(mail(asha.email, 'first'));
  await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(await EmailReply.countDocuments({ userId: u.id }), 1);

  box.uidValidity = 2; // the provider rebuilt the mailbox; every old message is "new"
  await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(await EmailReply.countDocuments({ userId: u.id }), 1);
  assert.equal((await settingsOf(u)).uidValidity, 2);
});

test('one bad message does not block the others; the poller claims a mailbox only once', T, async () => {
  const { u, asha } = await sentCampaign();
  const box = fakeMailbox();
  assert.equal((await saveImap(u)).status, 200);
  await call('POST', '/api/email/imap/check', { token: u.token });
  box.mail.push({ uid: 2, msg: { bad: true } }); // the test parser throws on this one
  box.mail.push({ uid: 3, msg: mail(asha.email, 'still arrives') });
  const check = await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(check.body.stored, 1, say(check));
  assert.equal((await settingsOf(u)).lastUid, 3);

  // A mailbox that is being read right now is not read a second time.
  await ImapSettings.updateOne({ userId: u.id }, { $set: { leaseUntil: new Date(Date.now() + 60_000), nextCheckAt: new Date(Date.now() - 1000) } });
  const busy = await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(busy.body.busy, true);
  const before = await settingsOf(u);
  const poller = imap.startReplyPoller({ tickMs: 3_600_000 });
  await poller.tick(); // may read other accounts that are due, never this one
  poller.stop();
  const after = await settingsOf(u);
  assert.equal(String(after.lastCheckedAt), String(before.lastCheckedAt));
  assert.ok(after.leaseUntil, 'still held by the first reader');
});

test('the background poller reads mailboxes that are due', T, async () => {
  const { u, asha } = await sentCampaign();
  const box = fakeMailbox();
  assert.equal((await saveImap(u)).status, 200);
  await call('POST', '/api/email/imap/check', { token: u.token });
  box.add(mail(asha.email, 'picked up by the poller'));
  await ImapSettings.updateOne({ userId: u.id }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
  const poller = imap.startReplyPoller({ tickMs: 3_600_000 });
  await poller.tick();
  poller.stop();
  assert.equal(await EmailReply.countDocuments({ userId: u.id }), 1);
});

test('pausing stops reading; removing deletes the saved password', T, async () => {
  const u = await newUser();
  fakeMailbox();
  assert.equal((await saveImap(u)).status, 200);
  const off = await call('POST', '/api/email/imap/enabled', { token: u.token, json: { enabled: false } });
  assert.equal(off.body.settings.enabled, false);
  const due = await ImapSettings.findOneAndUpdate({ userId: u.id }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } }, { returnDocument: 'after' });
  assert.equal(due.enabled, false);
  const check = await call('POST', '/api/email/imap/check', { token: u.token });
  assert.equal(check.status, 404);
  const gone = await call('DELETE', '/api/email/imap', { token: u.token });
  assert.equal(gone.status, 200);
  assert.equal(await ImapSettings.countDocuments({ userId: u.id }), 0);
});
