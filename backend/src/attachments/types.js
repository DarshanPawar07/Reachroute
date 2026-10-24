import { bad } from '../utils/http.js';

/**
 * The files that may be sent with a message. An allow-list by file ending, and the start of the file must match its
 * ending (a program renamed to .pdf is refused). Anything not listed (programs, scripts, archives, web pages, SVG)
 * is not accepted: they are how malware travels and how senders get blocked.
 */
const at = (b, offset, text) => b.length >= offset + text.length && b.toString('latin1', offset, offset + text.length) === text;
const starts = (b, bytes) => b.length >= bytes.length && bytes.every((v, i) => b[i] === v);
const isZip = (b) => starts(b, [0x50, 0x4b, 0x03, 0x04]);
const isOle = (b) => starts(b, [0xd0, 0xcf, 0x11, 0xe0]); // old Word / Excel / PowerPoint
const isMp4Family = (b) => at(b, 4, 'ftyp');
const isText = (b) => b.length > 0 && !b.includes(0);

const type = (mime, kind, ok) => ({ mime, kind, ok });

export const TYPES = {
  // documents
  pdf: type('application/pdf', 'document', (b) => at(b, 0, '%PDF-')),
  doc: type('application/msword', 'document', isOle),
  docx: type('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document', isZip),
  xls: type('application/vnd.ms-excel', 'document', isOle),
  xlsx: type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'document', isZip),
  ppt: type('application/vnd.ms-powerpoint', 'document', isOle),
  pptx: type('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'document', isZip),
  odt: type('application/vnd.oasis.opendocument.text', 'document', isZip),
  ods: type('application/vnd.oasis.opendocument.spreadsheet', 'document', isZip),
  rtf: type('application/rtf', 'document', (b) => at(b, 0, '{\\rtf')),
  txt: type('text/plain', 'document', isText),
  csv: type('text/csv', 'document', isText),
  // pictures
  jpg: type('image/jpeg', 'image', (b) => starts(b, [0xff, 0xd8, 0xff])),
  jpeg: type('image/jpeg', 'image', (b) => starts(b, [0xff, 0xd8, 0xff])),
  png: type('image/png', 'image', (b) => starts(b, [0x89, 0x50, 0x4e, 0x47])),
  gif: type('image/gif', 'image', (b) => at(b, 0, 'GIF8')),
  webp: type('image/webp', 'image', (b) => at(b, 0, 'RIFF') && at(b, 8, 'WEBP')),
  // video
  mp4: type('video/mp4', 'video', isMp4Family),
  mov: type('video/quicktime', 'video', (b) => isMp4Family(b) || at(b, 4, 'moov') || at(b, 4, 'mdat') || at(b, 4, 'wide')),
  '3gp': type('video/3gpp', 'video', isMp4Family),
  // sound
  mp3: type('audio/mpeg', 'audio', (b) => at(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)),
  m4a: type('audio/mp4', 'audio', isMp4Family),
  aac: type('audio/aac', 'audio', (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0),
  ogg: type('audio/ogg', 'audio', (b) => at(b, 0, 'OggS')),
  opus: type('audio/ogg', 'audio', (b) => at(b, 0, 'OggS')),
  wav: type('audio/wav', 'audio', (b) => at(b, 0, 'RIFF') && at(b, 8, 'WAVE')),
  amr: type('audio/amr', 'audio', (b) => at(b, 0, '#!AMR')),
};

export const ALLOWED_ENDINGS = Object.keys(TYPES);

/** How many bytes from the start of a file are needed to recognise it. */
export const HEAD_BYTES = 4096;

/** { ext, mime, kind } for a file name and the first bytes of the file, or a 400 error saying why it is not accepted. */
export function detectType(filename, head) {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(String(filename || ''))?.[1]?.toLowerCase();
  if (!ext || !Object.hasOwn(TYPES, ext)) {
    throw bad(`That kind of file cannot be sent. Allowed: PDF, Word, Excel, PowerPoint, text, pictures (jpg, png, gif, webp), video (mp4, mov, 3gp) and sound (mp3, m4a, aac, ogg, wav, amr).`);
  }
  const t = TYPES[ext];
  if (!t.ok(head)) throw bad(`This file does not look like a real .${ext} file. Check that it opens on your computer, then try again.`);
  return { ext, mime: t.mime, kind: t.kind };
}

/** A safe file name: no folders, no odd characters, and the ending that was checked. */
export function safeFileName(original, ext) {
  let name = String(original || 'file');
  if (/[\u0080-ÿ]/.test(name)) {
    // upload names arrive read as Latin-1: turn them back into the characters that were typed
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('�')) name = decoded;
  }
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  const base = name.replace(/\.[^.]*$/, '').trim() || 'file';
  return `${base.slice(0, 100)}.${ext}`;
}
