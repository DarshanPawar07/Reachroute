import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvLine, safeDownloadName } from '../src/utils/csv.js';

test('plain values are written as they are, empty values as nothing', () => {
  assert.equal(csvCell('Asha'), 'Asha');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(new Date('2026-10-23T04:30:00Z')), '2026-10-23T04:30:00.000Z');
});

test('commas, quotes and line breaks are quoted', () => {
  assert.equal(csvCell('Rao, Asha'), '"Rao, Asha"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
});

test('a cell that a spreadsheet would run as a formula is made harmless', () => {
  for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=1', '\r=1']) {
    assert.ok(csvCell(evil).replace(/^"/, '').startsWith("'"), JSON.stringify(evil));
  }
  assert.equal(csvCell('a=b'), 'a=b', 'only the first character matters');
  assert.equal(csvCell('919876543210'), '919876543210');
});

test('a line ends with CRLF', () => {
  assert.equal(csvLine(['a', 'b,c', '']), 'a,"b,c",\r\n');
});

test('download names are safe', () => {
  assert.equal(safeDownloadName('Diwali offer 2026!'), 'Diwali-offer-2026');
  assert.equal(safeDownloadName('../../etc/passwd'), 'etcpasswd');
  assert.equal(safeDownloadName('"; rm -rf'), 'rm--rf');
  assert.equal(safeDownloadName('***'), 'report');
  assert.ok(safeDownloadName('x'.repeat(200)).length <= 60);
});
