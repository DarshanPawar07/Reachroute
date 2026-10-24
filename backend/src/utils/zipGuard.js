import { bad } from './http.js';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * An .xlsx is a ZIP file, and a tiny ZIP can unpack to gigabytes ("zip bomb").
 * This reads only the ZIP's table of contents and rejects suspicious files BEFORE anything is unpacked.
 */
export function assertSafeZip(buffer, { maxEntries = 200, maxUncompressed = 25 * 1024 * 1024, maxRatio = 200 } = {}) {
  const invalid = () => bad('That file is not a valid .xlsx spreadsheet');
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== LOCAL_SIG) throw invalid();

  let eocd = -1;
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalid();

  const entries = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  if (entries > maxEntries) throw bad('That spreadsheet has too many internal files');

  let compressed = 0;
  let uncompressed = 0;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CENTRAL_SIG) throw invalid();
    const c = buffer.readUInt32LE(p + 20);
    const u = buffer.readUInt32LE(p + 24);
    if (c === 0xffffffff || u === 0xffffffff) throw bad('ZIP64 spreadsheets are not supported');
    compressed += c;
    uncompressed += u;
    p += 46 + buffer.readUInt16LE(p + 28) + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32);
  }

  if (uncompressed > maxUncompressed || (compressed > 0 && uncompressed / compressed > maxRatio)) {
    throw bad('That spreadsheet is too large once unpacked');
  }
}
