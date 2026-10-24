import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeZip } from '../src/utils/zipGuard.js';

/** Builds just enough of a ZIP file (headers only, "stored" entries) for the guard to inspect. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = Buffer.alloc(0), compressed = data.length, uncompressed = data.length } of entries) {
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(compressed, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const refused = (buffer, pattern) => assert.throws(() => assertSafeZip(buffer), (e) => e.status === 400 && pattern.test(e.message));

test('an ordinary small spreadsheet-like zip passes', () => {
  assertSafeZip(makeZip([{ name: 'a.xml', data: Buffer.from('x'.repeat(50)) }, { name: 'b.xml', data: Buffer.from('y'.repeat(50)) }]));
});

test('a high but plausible compression ratio passes', () => {
  assertSafeZip(makeZip([{ name: 'a.xml', compressed: 100, uncompressed: 10_000 }]));
});

test('a zip bomb (tiny file that unpacks to hundreds of MB) is refused', () => {
  refused(makeZip([{ name: 'bomb.xml', compressed: 1000, uncompressed: 500 * 1024 * 1024 }]), /too large/);
});

test('a big declared size is refused even with a modest ratio', () => {
  refused(makeZip([{ name: 'big.xml', compressed: 20 * 1024 * 1024, uncompressed: 30 * 1024 * 1024 }]), /too large/);
});

test('too many internal files is refused', () => {
  refused(makeZip(Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.xml` }))), /too many/);
});

test('ZIP64 files are refused', () => {
  refused(makeZip([{ name: 'a.xml', compressed: 0xffffffff, uncompressed: 0xffffffff }]), /ZIP64/);
});

test('files that are not zips, or are cut short, are refused', () => {
  refused(Buffer.from('this is just a text file, not a spreadsheet'), /not a valid/);
  refused(Buffer.alloc(0), /not a valid/);
  const zip = makeZip([{ name: 'a.xml', data: Buffer.from('hello') }]);
  refused(zip.subarray(0, zip.length - 10), /not a valid/);
});
