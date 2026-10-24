import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectType, safeFileName } from '../src/attachments/types.js';
import { parseIds } from '../src/attachments/store.js';
import { buildContents, CAPTION_MAX } from '../src/whatsapp/media.js';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('a file is recognised by its ending AND its first bytes', () => {
  assert.deepEqual(detectType('Offer.PDF', pdf), { ext: 'pdf', mime: 'application/pdf', kind: 'document' });
  assert.equal(detectType('a.png', png).kind, 'image');
  assert.throws(() => detectType('a.pdf', png), /does not look like a real \.pdf/);
  assert.throws(() => detectType('virus.exe', Buffer.from('MZ')), /cannot be sent/);
  assert.throws(() => detectType('noending', pdf), /cannot be sent/);
  assert.throws(() => detectType('a.txt', Buffer.from([0, 1, 2])), /does not look like/);
  assert.equal(detectType('x.mp4', Buffer.from('\0\0\0\x18ftypmp42')).kind, 'video');
  assert.equal(detectType('x.mp3', Buffer.from('ID3\x03')).kind, 'audio');
});

test('file names are made safe', () => {
  assert.equal(safeFileName('C:\\docs\\..\\my:file?.pdf', 'pdf'), 'my_file_.pdf');
  assert.equal(safeFileName('../../etc/passwd', 'txt'), 'passwd.txt');
  assert.equal(safeFileName('.hidden.pdf', 'pdf'), 'hidden.pdf');
  assert.equal(safeFileName('', 'pdf'), 'file.pdf');
  assert.ok(safeFileName(`${'a'.repeat(300)}.pdf`, 'pdf').length <= 104);
});

test('attachment ids are read from a form field', () => {
  const a = '507f1f77bcf86cd799439011';
  const b = '507f1f77bcf86cd799439012';
  assert.deepEqual(parseIds(undefined), []);
  assert.deepEqual(parseIds(''), []);
  assert.deepEqual(parseIds(`["${a}","${b}","${a}"]`), [a, b]);
  assert.deepEqual(parseIds(`${a}, ${b}`), [a, b]);
  assert.deepEqual(parseIds([a]), [a]);
  assert.throws(() => parseIds('[bad json'), /list of attachment ids/);
  assert.throws(() => parseIds('nope'), /not valid/);
  assert.throws(() => parseIds({ a: 1 }), /list of attachment ids/);
  assert.throws(() => parseIds(Array.from({ length: 21 }, () => a).concat(b)), /Too many/);
});

test('WhatsApp content: text only, file with caption, sound with separate text, long text separate', () => {
  const buffer = Buffer.from('x');
  assert.deepEqual(buildContents('hi', null), [{ text: 'hi' }]);
  assert.deepEqual(buildContents('hi', { buffer, mime: 'image/png', name: 'a.png', kind: 'image' }), [{ image: buffer, mimetype: 'image/png', caption: 'hi' }]);
  assert.deepEqual(buildContents('hi', { buffer, mime: 'video/mp4', name: 'a.mp4', kind: 'video' }), [{ video: buffer, mimetype: 'video/mp4', caption: 'hi' }]);
  assert.deepEqual(buildContents('hi', { buffer, mime: 'application/pdf', name: 'a.pdf', kind: 'document' }), [{ document: buffer, mimetype: 'application/pdf', fileName: 'a.pdf', caption: 'hi' }]);
  assert.deepEqual(buildContents('hi', { buffer, mime: 'audio/mpeg', name: 'a.mp3', kind: 'audio' }), [{ audio: buffer, mimetype: 'audio/mpeg', ptt: false }, { text: 'hi' }]);
  const long = 'x'.repeat(CAPTION_MAX + 1);
  assert.deepEqual(buildContents(long, { buffer, mime: 'application/pdf', name: 'a.pdf', kind: 'document' }), [{ document: buffer, mimetype: 'application/pdf', fileName: 'a.pdf' }, { text: long }]);
  assert.equal(buildContents('', { buffer, mime: 'image/png', name: 'a.png', kind: 'image' }).length, 1);
});
