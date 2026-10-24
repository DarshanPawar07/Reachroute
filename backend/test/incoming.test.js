import test from 'node:test';
import assert from 'node:assert/strict';
import { extractIncoming } from '../src/whatsapp/incoming.js';

const msg = (message, extra = {}) => ({
  key: { remoteJid: '919876543210@s.whatsapp.net', fromMe: false, id: 'ABC123' },
  message,
  messageTimestamp: 1_790_000_000,
  pushName: 'Asha',
  ...extra,
});

test('a plain text reply', () => {
  const r = extractIncoming(msg({ conversation: 'Yes, interested!' }));
  assert.deepEqual({ ...r, receivedAt: r.receivedAt.getTime() }, {
    phone: '919876543210', text: 'Yes, interested!', kind: 'text', messageId: 'ABC123', pushName: 'Asha', receivedAt: 1_790_000_000_000,
  });
});

test('extended text, button and list answers count as text', () => {
  assert.equal(extractIncoming(msg({ extendedTextMessage: { text: 'with a link https://x.test' } })).text, 'with a link https://x.test');
  assert.equal(extractIncoming(msg({ buttonsResponseMessage: { selectedDisplayText: 'Yes' } })).text, 'Yes');
  assert.equal(extractIncoming(msg({ listResponseMessage: { title: 'Option 2' } })).text, 'Option 2');
});

test('photos, voice notes and other media are recorded by kind, with their caption', () => {
  assert.deepEqual(pick(extractIncoming(msg({ imageMessage: { caption: 'my receipt' } }))), { kind: 'image', text: 'my receipt' });
  assert.deepEqual(pick(extractIncoming(msg({ audioMessage: {} }))), { kind: 'audio', text: '' });
  assert.deepEqual(pick(extractIncoming(msg({ documentMessage: { caption: 'cv' } }))), { kind: 'document', text: 'cv' });
  assert.deepEqual(pick(extractIncoming(msg({ stickerMessage: {} }))), { kind: 'sticker', text: '' });
  assert.equal(extractIncoming(msg({ somethingNew: {} })).kind, 'other');
});
const pick = ({ kind, text }) => ({ kind, text });

test('wrapped messages (disappearing chats, view once) are read through', () => {
  assert.equal(extractIncoming(msg({ ephemeralMessage: { message: { conversation: 'hello' } } })).text, 'hello');
  assert.equal(extractIncoming(msg({ viewOnceMessage: { message: { imageMessage: { caption: 'once' } } } })).kind, 'image');
});

test('our own messages, groups, status updates and broadcasts are ignored', () => {
  assert.equal(extractIncoming(msg({ conversation: 'x' }, { key: { remoteJid: '919876543210@s.whatsapp.net', fromMe: true, id: '1' } })), null);
  assert.equal(extractIncoming(msg({ conversation: 'x' }, { key: { remoteJid: '1203630@g.us', fromMe: false, id: '1' } })), null);
  assert.equal(extractIncoming(msg({ conversation: 'x' }, { key: { remoteJid: 'status@broadcast', fromMe: false, id: '1' } })), null);
  assert.equal(extractIncoming(msg({ conversation: 'x' }, { key: { remoteJid: '1234@newsletter', fromMe: false, id: '1' } })), null);
});

test('reactions, protocol messages and empty messages are ignored', () => {
  assert.equal(extractIncoming(msg({ reactionMessage: { text: '👍' } })), null);
  assert.equal(extractIncoming(msg({ protocolMessage: { type: 0 } })), null);
  assert.equal(extractIncoming(msg({ messageContextInfo: {} })), null);
  assert.equal(extractIncoming(msg({ conversation: '   ' })), null);
  assert.equal(extractIncoming(msg(undefined)), null);
  assert.equal(extractIncoming(null), null);
  assert.equal(extractIncoming({}), null);
});

test('when the chat id is opaque, the phone number from the "Alt" field is used', () => {
  const r = extractIncoming(msg({ conversation: 'hi' }, { key: { remoteJid: '1234567890123@lid', remoteJidAlt: '919811122233@s.whatsapp.net', fromMe: false, id: 'Z' } }));
  assert.equal(r.phone, '919811122233');
  assert.equal(extractIncoming(msg({ conversation: 'hi' }, { key: { remoteJid: '1234567890123@lid', fromMe: false, id: 'Z' } })), null, 'no phone number, nothing to match');
});

test('a device suffix in the id is removed, and a bad number is refused', () => {
  assert.equal(extractIncoming(msg({ conversation: 'hi' }, { key: { remoteJid: '919876543210:12@s.whatsapp.net', fromMe: false, id: '1' } })).phone, '919876543210');
  assert.equal(extractIncoming(msg({ conversation: 'hi' }, { key: { remoteJid: '12@s.whatsapp.net', fromMe: false, id: '1' } })), null);
});

test('text is cleaned and limited, and names too', () => {
  const r = extractIncoming(msg({ conversation: `  hello\u0000\u0007 world\nnext line  ${'x'.repeat(2000)}` }, { pushName: `Ra\u0000vi${'y'.repeat(300)}` }));
  assert.ok(r.text.startsWith('hello world\nnext line'));
  assert.equal(r.text.length, 1000);
  assert.equal(r.pushName.length, 100);
  assert.ok(r.pushName.startsWith('Ravi'));
});

test('timestamps: Long-like values work, and one from the future is replaced by now', () => {
  const long = extractIncoming(msg({ conversation: 'a' }, { messageTimestamp: { toNumber: () => 1_790_000_123 } }));
  assert.equal(long.receivedAt.getTime(), 1_790_000_123_000);
  const future = extractIncoming(msg({ conversation: 'a' }, { messageTimestamp: Math.floor(Date.now() / 1000) + 86_400 }));
  assert.ok(Math.abs(future.receivedAt.getTime() - Date.now()) < 5000);
  const missing = extractIncoming(msg({ conversation: 'a' }, { messageTimestamp: undefined }));
  assert.ok(Math.abs(missing.receivedAt.getTime() - Date.now()) < 5000);
});

test('a message without an id still gets a stable one, so a repeat is not stored twice', () => {
  const m = msg({ conversation: 'same' }, { key: { remoteJid: '919876543210@s.whatsapp.net', fromMe: false } });
  const a = extractIncoming(m);
  const b = extractIncoming(m);
  assert.equal(a.messageId, b.messageId);
  assert.match(a.messageId, /^[0-9a-f]{40}$/);
});
