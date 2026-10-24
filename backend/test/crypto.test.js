import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { encrypt, decrypt } = await import('../src/utils/crypto.js');

test('decrypt returns what encrypt was given, including unicode', () => {
  for (const text of ['p@ssw0rd', 'पासवर्ड 🔐', 'a'.repeat(500)]) assert.equal(decrypt(encrypt(text)), text);
});

test('the same text encrypts differently each time', () => {
  assert.notEqual(encrypt('same'), encrypt('same'));
});

test('tampering with any part is detected', () => {
  const [iv, tag, data] = encrypt('secret value').split('.');
  const flip = (b64) => Buffer.from(Buffer.from(b64, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64');
  assert.throws(() => decrypt([iv, tag, flip(data)].join('.')));
  assert.throws(() => decrypt([iv, flip(tag), data].join('.')));
  assert.throws(() => decrypt([flip(iv), tag, data].join('.')));
});

test('garbage input throws instead of returning junk', () => {
  for (const bad of ['', 'abc', 'a.b', 'a.b.c', null, undefined]) assert.throws(() => decrypt(bad));
});
