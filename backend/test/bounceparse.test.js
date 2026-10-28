import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseBounce } from '../src/email/bounceParse.js';

const daemon = { address: 'mailer-daemon@googlemail.com' };
const dsn = (...blocks) => `Reporting-MTA: dns; mx.example.net\r\n\r\n${blocks.join('\r\n\r\n')}\r\n`;
const block = ({ who, action = 'failed', status, diag }) =>
  `Final-Recipient: rfc822; ${who}\r\nAction: ${action}\r\nStatus: ${status}\r\n${diag ? `Diagnostic-Code: smtp; ${diag}\r\n` : ''}`;

test('a mailbox that does not exist is a hard bounce', () => {
  const r = parseBounce({ from: daemon, subject: 'Delivery Status Notification (Failure)', dsn: dsn(block({ who: 'Gone@Example.com', status: '5.1.1', diag: '550 5.1.1 The email account that you tried to reach does not exist.' })) });
  assert.equal(r.isBounce, true);
  assert.deepEqual(r.hard.map((h) => h.email), ['gone@example.com']);
  assert.match(r.hard[0].detail, /does not exist/);
});

test('Outlook style: a long diagnostic continues on the next line', () => {
  const text = 'Final-Recipient: rfc822;\r\n  nobody@contoso.com\r\nAction: failed\r\nStatus: 5.1.10\r\nDiagnostic-Code: smtp; 550 5.1.10 RESOLVER.ADR.RecipientNotFound;\r\n  Recipient not found by SMTP address lookup\r\n';
  const r = parseBounce({ from: { address: 'postmaster@contoso.com' }, subject: 'Undeliverable: Hello', dsn: text });
  assert.deepEqual(r.hard.map((h) => h.email), ['nobody@contoso.com']);
});

test('things that say nothing about the address are not hard bounces', () => {
  const cases = [
    ['5.2.2', '552 5.2.2 mailbox full'],
    ['5.7.1', '550 5.7.1 message rejected as spam'],
    ['5.7.26', '550 5.7.26 unauthenticated sender, DMARC'],
    ['5.3.4', '552 5.3.4 message too large'],
    ['4.4.1', '451 4.4.1 connection timed out'],
    ['5.1.8', '553 5.1.8 sender address rejected'],
    ['5.1.1', '550 5.1.1 blocked by policy reputation'],
  ];
  for (const [status, diag] of cases) {
    const r = parseBounce({ from: daemon, subject: 'Mail delivery failed', dsn: dsn(block({ who: 'a@example.com', status, diag })) });
    assert.equal(r.isBounce, true, status);
    assert.equal(r.hard.length, 0, `${status} ${diag} must not stop the address`);
    assert.equal(r.ignored.length, 1);
  }
});

test('a delayed notice is not a failure', () => {
  const r = parseBounce({ from: daemon, subject: 'Delivery Status Notification (Delay)', dsn: dsn(block({ who: 'a@example.com', action: 'delayed', status: '4.4.1', diag: '' })) });
  assert.equal(r.hard.length, 0);
});

test('several recipients in one report: each is judged on its own', () => {
  const r = parseBounce({
    from: daemon,
    subject: 'Undelivered Mail Returned to Sender',
    dsn: dsn(block({ who: 'dead@example.com', status: '5.1.1', diag: '550 user unknown' }), block({ who: 'full@example.com', status: '5.2.2', diag: '552 mailbox full' }), block({ who: 'dead2@example.org', status: '5.1.2', diag: '550 domain not found' })),
  });
  assert.deepEqual(r.hard.map((h) => h.email).sort(), ['dead2@example.org', 'dead@example.com']);
  assert.deepEqual(r.ignored.map((i) => i.email), ['full@example.com']);
});

test('without a status code, only an explicit "no such user" is trusted', () => {
  assert.equal(parseBounce({ from: daemon, subject: 'x', dsn: dsn(block({ who: 'a@example.com', status: '', diag: '550 No such user here' })) }).hard.length, 1);
  assert.equal(parseBounce({ from: daemon, subject: 'x', dsn: dsn(block({ who: 'a@example.com', status: '', diag: '550 something went wrong' })) }).hard.length, 0);
});

test('a bounce written as plain text, with no report attached', () => {
  const text = 'This is the mail system at host mx.example.net.\n\nI am sorry to have to inform you that your message could not be delivered to one or more recipients.\n\n<ghost@example.com>: host mx.example.net said: 550 5.1.1 <ghost@example.com>: Recipient address rejected: User unknown in virtual mailbox table\n';
  const r = parseBounce({ from: { address: 'MAILER-DAEMON@mail.example.org' }, subject: 'Undelivered Mail Returned to Sender', text }, { ownEmail: 'me@mydomain.com' });
  assert.equal(r.isBounce, true);
  assert.deepEqual(r.hard.map((h) => h.email), ['ghost@example.com']);
});

test('the sender\'s own address and the robot are never reported', () => {
  const text = 'Delivery to the following recipient failed permanently:\n\n     real@example.com\n\nTechnical details: 550 5.1.1 user unknown\nFrom: me@mydomain.com\nReported by mailer-daemon@googlemail.com\n';
  const r = parseBounce({ from: daemon, subject: 'Delivery Status Notification (Failure)', text }, { ownEmail: 'me@mydomain.com' });
  assert.deepEqual(r.hard.map((h) => h.email), ['real@example.com']);
});

test('ordinary mail, out-of-office and read receipts are not bounces', () => {
  assert.equal(parseBounce({ from: { address: 'asha@example.com' }, subject: 'Re: Hello', text: 'Thanks! The address user unknown@x.com is wrong.' }).isBounce, false);
  assert.equal(parseBounce({ from: { address: 'asha@example.com' }, subject: 'Automatic reply: away', text: 'I am out of office' }).isBounce, false);
  assert.equal(parseBounce({ from: { address: 'asha@example.com' }, subject: 'Read: Hello', dsn: 'Reporting-UA: x\r\nOriginal-Message-ID: <1@x>\r\nDisposition: manual-action/MDN-sent-manually; displayed\r\n' }).isBounce, false);
  assert.equal(parseBounce({ from: { address: 'mailer-daemon@x.org' }, subject: 'Weekly digest', text: 'hello' }).isBounce, false);
  assert.equal(parseBounce({}).isBounce, false);
  assert.equal(parseBounce(null).isBounce, false);
});

test('classify: codes and words', () => {
  assert.equal(classify({ status: '5.1.1', diagnostic: '' }).hard, true);
  assert.equal(classify({ status: '5.2.1', diagnostic: 'mailbox disabled' }).hard, true);
  assert.equal(classify({ status: '5.4.4', diagnostic: 'unable to route' }).hard, true);
  assert.equal(classify({ status: '5.4.1', diagnostic: 'Recipient address rejected: Access denied' }).hard, false);
  assert.equal(classify({ status: '5.0.0', diagnostic: 'rejected' }).hard, false);
});
