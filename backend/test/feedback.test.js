import test from 'node:test';
import assert from 'node:assert/strict';
import { isSnsUrl, MAX_EVENTS, parseFeedback } from '../src/email/feedback.js';

const kinds = (body) => parseFeedback(body).events.map((e) => `${e.email}:${e.kind}`).sort();

test('Amazon SES through SNS: permanent bounces and complaints', () => {
  const bounce = { notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'a@x.com', diagnosticCode: 'smtp; 550 no such user' }, { emailAddress: 'b@x.com' }] } };
  const sns = { Type: 'Notification', MessageId: '1', Message: JSON.stringify(bounce) };
  assert.deepEqual(kinds(sns), ['a@x.com:bounced', 'b@x.com:bounced']);
  assert.match(parseFeedback(sns).events[0].detail, /no such user/);

  const complaint = { Type: 'Notification', Message: JSON.stringify({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'c@x.com' }], complaintFeedbackType: 'abuse' } }) };
  assert.deepEqual(kinds(complaint), ['c@x.com:complaint']);
  assert.equal(parseFeedback(complaint).events[0].detail, 'abuse');
});

test('Amazon SES: temporary bounces, deliveries and other events are ignored; event publishing format works', () => {
  const soft = { Type: 'Notification', Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'a@x.com' }] } }) };
  assert.deepEqual(kinds(soft), []);
  assert.deepEqual(kinds({ Type: 'Notification', Message: JSON.stringify({ notificationType: 'Delivery' }) }), []);
  assert.deepEqual(kinds({ eventType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'd@x.com' }] } }), ['d@x.com:complaint']);
  assert.deepEqual(kinds({ Type: 'Notification', Message: 'not json' }), []);
});

test('SNS subscription confirmation: only genuine Amazon links are accepted', () => {
  const url = 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc';
  assert.equal(parseFeedback({ Type: 'SubscriptionConfirmation', SubscribeURL: url }).snsConfirmUrl, url);
  for (const bad of [
    'http://sns.eu-west-1.amazonaws.com/?x=1',
    'https://sns.eu-west-1.amazonaws.com.evil.test/?x=1',
    'https://evil.test/sns.eu-west-1.amazonaws.com',
    'https://user@sns.us-east-1.amazonaws.com/',
    'https://sns.us-east-1.amazonaws.com:8443/',
    'https://169.254.169.254/latest/meta-data',
    'https://amazonaws.com/',
    'file:///etc/passwd',
    'not a url',
    '',
  ]) {
    assert.equal(isSnsUrl(bad), false, bad);
    assert.equal(parseFeedback({ Type: 'SubscriptionConfirmation', SubscribeURL: bad }).snsConfirmUrl, null, bad);
  }
});

test('SendGrid: hard bounces, spam reports and unsubscribes; blocks and normal events are ignored', () => {
  const events = [
    { event: 'bounce', email: 'a@x.com', type: 'bounce', reason: '550 5.1.1 user unknown' },
    { event: 'bounce', email: 'b@x.com', type: 'blocked', reason: 'blocked by policy' },
    { event: 'spamreport', email: 'c@x.com' },
    { event: 'unsubscribe', email: 'd@x.com' },
    { event: 'group_unsubscribe', email: 'e@x.com' },
    { event: 'delivered', email: 'f@x.com' },
    { event: 'open', email: 'g@x.com' },
    { event: 'dropped', email: 'h@x.com', reason: 'Bounced Address' },
    { event: 'dropped', email: 'i@x.com', reason: 'Spam Reporting Address' },
    { event: 'dropped', email: 'j@x.com', reason: 'Unsubscribed Address' },
    { event: 'dropped', email: 'k@x.com', reason: 'Invalid' },
  ];
  assert.deepEqual(kinds(events), ['a@x.com:bounced', 'c@x.com:complaint', 'd@x.com:unsubscribed', 'e@x.com:unsubscribed', 'h@x.com:bounced', 'i@x.com:complaint', 'j@x.com:unsubscribed']);
});

test('Mailgun: permanent failures, complaints and unsubscribes', () => {
  const wrap = (d) => ({ signature: { token: 't' }, 'event-data': d });
  assert.deepEqual(kinds(wrap({ event: 'failed', severity: 'permanent', recipient: 'a@x.com', 'delivery-status': { description: 'no mailbox' } })), ['a@x.com:bounced']);
  assert.deepEqual(kinds(wrap({ event: 'failed', severity: 'temporary', recipient: 'b@x.com' })), []);
  assert.deepEqual(kinds(wrap({ event: 'complained', recipient: 'c@x.com' })), ['c@x.com:complaint']);
  assert.deepEqual(kinds(wrap({ event: 'unsubscribed', recipient: 'd@x.com' })), ['d@x.com:unsubscribed']);
  assert.deepEqual(kinds(wrap({ event: 'delivered', recipient: 'e@x.com' })), []);
});

test('Postmark: hard bounces and spam complaints', () => {
  assert.deepEqual(kinds({ RecordType: 'Bounce', Type: 'HardBounce', Email: 'a@x.com' }), ['a@x.com:bounced']);
  assert.deepEqual(kinds({ RecordType: 'Bounce', Type: 'SoftBounce', Email: 'b@x.com' }), []);
  assert.deepEqual(kinds({ RecordType: 'Bounce', Type: 'SpamNotification', Email: 'c@x.com' }), ['c@x.com:complaint']);
  assert.deepEqual(kinds({ RecordType: 'SpamComplaint', Email: 'd@x.com' }), ['d@x.com:complaint']);
});

test('Resend: permanent bounces and complaints', () => {
  assert.deepEqual(kinds({ type: 'email.bounced', data: { to: ['a@x.com', 'b@x.com'], bounce: { type: 'Permanent' } } }), ['a@x.com:bounced', 'b@x.com:bounced']);
  assert.deepEqual(kinds({ type: 'email.bounced', data: { to: ['c@x.com'], bounce: { type: 'Transient' } } }), []);
  assert.deepEqual(kinds({ type: 'email.complained', data: { to: ['d@x.com'] } }), ['d@x.com:complaint']);
  assert.deepEqual(kinds({ type: 'email.delivered', data: { to: ['e@x.com'] } }), []);
});

test('custom format: one event, a list, or { events: [...] }', () => {
  assert.deepEqual(kinds({ type: 'bounce', email: 'a@x.com', reason: 'gone' }), ['a@x.com:bounced']);
  assert.deepEqual(kinds({ type: 'Complaint', email: 'b@x.com' }), ['b@x.com:complaint']);
  assert.deepEqual(kinds({ events: [{ type: 'unsubscribe', email: 'c@x.com' }, { type: 'bounce', email: 'd@x.com' }] }), ['c@x.com:unsubscribed', 'd@x.com:bounced']);
  assert.deepEqual(kinds([{ type: 'bounce', email: 'e@x.com' }, { type: 'complaint', email: 'f@x.com' }]), ['e@x.com:bounced', 'f@x.com:complaint']);
  assert.deepEqual(kinds({ type: 'delivered', email: 'g@x.com' }), []);
});

test('one address twice in a notice is one event, and a complaint outranks a bounce', () => {
  const r = parseFeedback([{ type: 'bounce', email: 'a@x.com' }, { type: 'complaint', email: 'A@x.com' }, { type: 'unsubscribe', email: 'a@x.com' }, { type: 'bounce', email: 'b@x.com' }, { type: 'bounce', email: 'b@x.com' }]);
  assert.deepEqual(r.events.map((e) => `${e.email.toLowerCase()}:${e.kind}`).sort(), ['a@x.com:complaint', 'b@x.com:bounced']);
});

test('rubbish never throws and gives nothing', () => {
  for (const junk of [undefined, null, 5, 'text', true, [], {}, [null, 1, 'x'], { event: 5, email: 7 }, { type: 'bounce' }, { type: 'bounce', email: 5 }, { Type: 'Notification', Message: 5 }, { events: 'no' }, { 'event-data': 'x' }]) {
    assert.deepEqual(parseFeedback(junk).events, [], JSON.stringify(junk));
  }
});

test('a deeply nested notice does not loop forever, and a huge one is cut off', () => {
  let nested = { type: 'bounce', email: 'a@x.com' };
  for (let i = 0; i < 10; i++) nested = { events: [nested] };
  assert.deepEqual(kinds(nested), []);
  const many = Array.from({ length: MAX_EVENTS + 500 }, (_, i) => ({ type: 'bounce', email: `u${i}@x.com` }));
  assert.equal(parseFeedback(many).events.length, MAX_EVENTS);
});

test('details are limited in length', () => {
  assert.equal(parseFeedback({ type: 'bounce', email: 'a@x.com', reason: 'x'.repeat(5000) }).events[0].detail.length, 300);
});
