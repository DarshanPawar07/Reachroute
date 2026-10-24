import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { signUnsubscribe, verifyUnsubscribe } = await import('../src/utils/unsubscribeToken.js');

const USER = 'a1'.repeat(12); // a valid 24-char hex id
const hmac = (data) => crypto.createHmac('sha256', process.env.UNSUBSCRIBE_SECRET).update(data).digest('base64url');
const forge = (payloadObj) => {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  return `v2.${payload}.${hmac(`unsubscribe:v2:${payload}`)}`; // correctly signed, but with bad contents
};

test('a signed link gives back the same user and (lower-cased) address', () => {
  assert.deepEqual(verifyUnsubscribe(signUnsubscribe({ userId: USER, email: 'Foo@Example.COM' })), { userId: USER, email: 'foo@example.com' });
});

test('changing the address or the signature invalidates the link', () => {
  const [v2, payload, sig] = signUnsubscribe({ userId: USER, email: 'a@example.com' }).split('.');
  const other = signUnsubscribe({ userId: USER, email: 'b@example.com' }).split('.');
  assert.equal(verifyUnsubscribe([v2, other[1], sig].join('.')), null); // someone else's address, my signature
  assert.equal(verifyUnsubscribe([v2, payload, other[2]].join('.')), null);
  assert.equal(verifyUnsubscribe([v2, payload, sig.slice(0, -2) + 'xx'].join('.')), null);
});

test('links from the first version (recipient id + signature) still work', () => {
  const id = 'b2'.repeat(12);
  assert.deepEqual(verifyUnsubscribe(`${id}.${hmac(`unsubscribe:${id}`)}`), { recipientId: id });
  assert.equal(verifyUnsubscribe(`${id}.${hmac('unsubscribe:other')}`), null);
});

test('correctly signed links with nonsense contents are refused', () => {
  assert.equal(verifyUnsubscribe(forge({ u: 'not-an-id', e: 'a@example.com' })), null);
  assert.equal(verifyUnsubscribe(forge({ u: USER, e: 'no-at-sign' })), null);
  assert.equal(verifyUnsubscribe(forge({ u: 123, e: 'a@example.com' })), null);
});

test('garbage never throws', () => {
  for (const value of ['', 'abc', null, undefined, 'v2..', 'v2.a.b', '.', 'x'.repeat(601), 42, {}]) assert.equal(verifyUnsubscribe(value), null);
});

test('even the longest legal address fits in a link', () => {
  const email = `${'a'.repeat(240)}@example.com`;
  const token = signUnsubscribe({ userId: USER, email });
  assert.ok(token.length <= 600, `token is ${token.length} characters`);
  assert.equal(verifyUnsubscribe(token).email, email);
});
