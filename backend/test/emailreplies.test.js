import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanReplyText, isAutoReply, looksLikeOptOut } from '../src/email/mailText.js';
import { describeImapError, flattenHeaders } from '../src/email/mailText.js';

test('the quoted earlier mail and the signature are cut away', () => {
  assert.equal(cleanReplyText('Yes, interested!\n\nOn Mon, 3 Nov 2026 at 10:15, Asha <a@x.com> wrote:\n> Hello\n> offer'), 'Yes, interested!');
  assert.equal(cleanReplyText('Sounds good\n--\nDarshan\nPune'), 'Sounds good');
  assert.equal(cleanReplyText('Thanks\n> quoted line\nmore'), 'Thanks\nmore');
  assert.equal(cleanReplyText('Call me\n\n-----Original Message-----\nFrom: a'), 'Call me');
  assert.equal(cleanReplyText('Hi\nFrom: Asha <a@x.com>\nSent: Monday\nTo: me\nSubject: Offer'), 'Hi');
  assert.equal(cleanReplyText(null), '');
  assert.equal(cleanReplyText('x'.repeat(5000)).length, 2000);
});

test('short stop requests are opt-outs; long or normal replies are not', () => {
  for (const t of ['unsubscribe', 'Please remove me from this list', 'STOP', 'stop.', 'do not email me again', "don't contact me", 'Take me off your list, thanks']) assert.equal(looksLikeOptOut(t), true, t);
  for (const t of ['', 'Can you stop by on Friday to talk about the offer?', 'Interested, send details', 'I want to unsubscribe '.padEnd(400, 'x')]) assert.equal(looksLikeOptOut(t), false, t);
});

test('robots are not replies from a person', () => {
  assert.equal(isAutoReply({ from: 'mailer-daemon@x.com' }), true);
  assert.equal(isAutoReply({ from: 'noreply@x.com' }), true);
  assert.equal(isAutoReply({ from: 'a@x.com', subject: 'Automatic reply: away' }), true);
  assert.equal(isAutoReply({ from: 'a@x.com', subject: 'Out of office until Monday' }), true);
  assert.equal(isAutoReply({ from: 'a@x.com', headers: { 'auto-submitted': 'auto-replied' } }), true);
  assert.equal(isAutoReply({ from: 'a@x.com', headers: { precedence: 'bulk' } }), true);
  assert.equal(isAutoReply({ from: 'a@x.com', headers: { 'list-unsubscribe': '<mailto:x>' } }), true);
  assert.equal(isAutoReply({ from: 'a@x.com', headers: { 'content-type': 'multipart/report; report-type=delivery-status' } }), true);
  assert.equal(isAutoReply({ from: 'a@x.com', headers: { 'auto-submitted': 'no' }, subject: 'Re: Offer' }), false);
  assert.equal(isAutoReply({ from: 'asha@x.com', subject: 'Re: Offer', headers: {} }), false);
});

test('mail headers are flattened to plain text', () => {
  const map = new Map([
    ['auto-submitted', 'auto-replied'],
    ['content-type', { value: 'multipart/report', params: {} }],
    ['list-id', { text: '<list.x.com>' }],
    ['subject', 'ignored'],
  ]);
  assert.deepEqual(flattenHeaders(map), { 'auto-submitted': 'auto-replied', 'content-type': 'multipart/report', 'list-id': '<list.x.com>' });
  assert.deepEqual(flattenHeaders(undefined), {});
});

test('mailbox problems are explained in plain words, without the password', () => {
  assert.match(describeImapError({ authenticationFailed: true }), /refused the login/);
  assert.match(describeImapError({ code: 'ENOTFOUND' }), /not found/);
  assert.match(describeImapError({ code: 'ECONNREFUSED' }), /refused the connection/);
  assert.match(describeImapError({ code: 'ETIMEDOUT' }), /in time/);
  assert.match(describeImapError({ code: 'IMAP_MODULES_MISSING' }), /npm install/);
  assert.match(describeImapError({ message: 'self-signed certificate' }), /certificate/);
  assert.match(describeImapError(new Error('boom')), /boom/);
});
