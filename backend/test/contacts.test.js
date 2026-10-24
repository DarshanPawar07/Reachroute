import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// These need the real packages (csv-parse, exceljs, libphonenumber-js), so they run after `npm install`.
const { normalizePhone, normalizeEmail, detectDelimiter, parseContacts, parseEmailContacts } = await import('../src/utils/contacts.js');
const ExcelJS = (await import('exceljs')).default;

const buf = (text) => Buffer.from(text, 'utf8');
const rejects400 = (promise, pattern) => assert.rejects(promise, (e) => e.status === 400 && pattern.test(e.message));

test('phone numbers are normalized to digits with country code', () => {
  assert.equal(normalizePhone('8123456789'), '918123456789'); // India is the default country
  assert.equal(normalizePhone('+91 81234 56789'), '918123456789');
  assert.equal(normalizePhone('918123456789'), '918123456789'); // spreadsheets often drop the +
  assert.equal(normalizePhone('08123456789'), '918123456789');
  assert.equal(normalizePhone('+1 650-253-0000'), '16502530000');
});

test('invalid phone numbers are rejected', () => {
  for (const v of ['', null, undefined, 'abc', '12345', '0000000000']) assert.equal(normalizePhone(v), null, String(v));
});

test('emails are lower-cased and validated, and header injection is blocked', () => {
  assert.equal(normalizeEmail('  Foo@Example.COM '), 'foo@example.com');
  const bad = ['', null, 'plainaddress', 'a@b', 'a@example.c', 'a b@example.com', 'a@@example.com', '<a@example.com>', 'a@example.com\nBcc: x@y.com', `${'a'.repeat(250)}@b.co`];
  for (const v of bad) assert.equal(normalizeEmail(v), null, JSON.stringify(v));
});

test('the CSV delimiter is detected from the header line', () => {
  assert.equal(detectDelimiter(buf('name;email\nA;a@b.co')), ';');
  assert.equal(detectDelimiter(buf('name\temail\nA\ta@b.co')), '\t');
  assert.equal(detectDelimiter(buf('name,email')), ',');
  assert.equal(detectDelimiter(buf('single')), ',');
});

test('email CSV: header aliases, BOM, duplicates and bad rows', async () => {
  const csv = '﻿Name,E-mail\nAsha,Asha@Example.com\nRahul,rahul@example.com\nDup,asha@example.com\nBad,not-an-email\n,\n';
  const out = await parseEmailContacts(buf(csv), 'list.csv');
  assert.deepEqual(out.contacts, [{ name: 'Asha', email: 'asha@example.com' }, { name: 'Rahul', email: 'rahul@example.com' }]);
  assert.equal(out.duplicates, 1);
  assert.deepEqual(out.invalid.map((i) => i.row), [5, 6]);
  assert.equal(out.totalRows, 5);
});

test('semicolon separated files (common from Excel in some regions) work', async () => {
  const out = await parseEmailContacts(buf('name;email\nAsha;asha@example.com\n'), 'list.csv');
  assert.equal(out.contacts.length, 1);
});

test('WhatsApp CSV: numbers are normalized, duplicates removed, bad rows reported', async () => {
  const out = await parseContacts(buf('name,phone\nA,8123456789\nB,+91 81234 56789\nC,12345\n'), 'list.csv');
  assert.deepEqual(out.contacts, [{ name: 'A', phone: '918123456789' }]);
  assert.equal(out.duplicates, 1);
  assert.deepEqual(out.invalid, [{ row: 4, value: '12345' }]);
});

test('files over the row limit are refused', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => `P${i},p${i}@example.com`).join('\n');
  await rejects400(parseEmailContacts(buf(`name,email\n${rows}`), 'list.csv', { maxRows: 5 }), /limit is 5/);
});

test('JSON: a plain array or {contacts: [...]}, with control characters removed from names', async () => {
  const a = await parseEmailContacts(buf(JSON.stringify([{ name: 'Evil\nName', email: 'a@example.com' }])), 'x.json');
  assert.deepEqual(a.contacts, [{ name: 'EvilName', email: 'a@example.com' }]);
  const b = await parseEmailContacts(buf(JSON.stringify({ contacts: [{ email: 'b@example.com' }] })), 'x.json');
  assert.equal(b.contacts[0].email, 'b@example.com');
});

test('JSON: numeric phone values are accepted', async () => {
  const out = await parseContacts(buf(JSON.stringify([{ name: 'A', phone: 918123456789 }])), 'x.json');
  assert.equal(out.contacts[0].phone, '918123456789');
});

test('bad files give a clear 400', async () => {
  await rejects400(parseEmailContacts(buf('{not json'), 'x.json'), /Could not read the file/);
  await rejects400(parseEmailContacts(buf('{"a": 1}'), 'x.json'), /JSON must be an array/);
  await rejects400(parseEmailContacts(buf('hello'), 'x.txt'), /Unsupported file type/);
  await rejects400(parseEmailContacts(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'x.csv'), /renamed to \.csv/);
});

test('XLSX: reads the first sheet, including phone numbers stored as numbers', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contacts');
  ws.addRow(['Name', 'Phone']);
  ws.addRow(['Asha', 8123456789]);
  ws.addRow(['Rahul', '+91 81234 56788']);
  const out = await parseContacts(Buffer.from(await wb.xlsx.writeBuffer()), 'list.xlsx');
  assert.equal(out.contacts.length, 2);
  assert.equal(out.contacts[0].phone, '918123456789');
});

test('XLSX: a file that is not really a spreadsheet is refused', async () => {
  await rejects400(parseContacts(buf('this is not a zip file at all, just text'), 'list.xlsx'), /not a valid/);
});

// ---------------------------------------------------------------- extra columns (variables)

test('extra columns are kept per contact: headers become variable names and empty values are skipped', async () => {
  const csv = 'Name,Email,Company,City / Town,Order #,Notes\nAsha,asha@example.com,Acme,Pune,4471,\nRahul,rahul@example.com,,Mumbai,,hi\nPlain,plain@example.com,,,,\n';
  const out = await parseEmailContacts(buf(csv), 'list.csv');
  assert.deepEqual(out.contacts, [
    { name: 'Asha', email: 'asha@example.com', fields: { company: 'Acme', city_town: 'Pune', order: '4471' } },
    { name: 'Rahul', email: 'rahul@example.com', fields: { city_town: 'Mumbai', notes: 'hi' } },
    { name: 'Plain', email: 'plain@example.com' },
  ]);
  assert.deepEqual(out.columns.sort(), ['city_town', 'company', 'notes', 'order']);
  assert.deepEqual(out.ignoredColumns, []);
});

test('the name, phone and email columns are not repeated as variables, but the other channel\'s column is', async () => {
  const wa = await parseContacts(buf('First Name,Mobile,Email,City\nAsha,8123456789,a@example.com,Pune\n'), 'list.csv');
  assert.deepEqual(wa.contacts, [{ name: 'Asha', phone: '918123456789', fields: { email: 'a@example.com', city: 'Pune' } }]);
  const em = await parseEmailContacts(buf('Full Name,E-mail,Phone\nAsha,a@example.com,8123456789\n'), 'list.csv');
  assert.deepEqual(em.contacts, [{ name: 'Asha', email: 'a@example.com', fields: { phone: '8123456789' } }]);
});

test('only the first 20 extra columns are kept, and the rest are reported', async () => {
  const headers = Array.from({ length: 25 }, (_, i) => `col${i + 1}`);
  const row = headers.map((_, i) => `v${i + 1}`);
  const out = await parseEmailContacts(buf(`name,email,${headers.join(',')}\nAsha,a@example.com,${row.join(',')}\n`), 'list.csv');
  assert.equal(out.columns.length, 20);
  assert.equal(Object.keys(out.contacts[0].fields).length, 20);
  assert.deepEqual(out.ignoredColumns, ['col21', 'col22', 'col23', 'col24', 'col25']);
});

test('values are cleaned and limited; objects and nulls are skipped; duplicate headers keep the first', async () => {
  const json = [{ name: 'A', email: 'a@example.com', note: `x\ny${'z'.repeat(300)}`, n: 5, flag: true, nothing: null, nested: { a: 1 }, City: 'First', city: 'Second', __proto__x: 'safe' }];
  const out = await parseEmailContacts(buf(JSON.stringify(json)), 'x.json');
  const f = out.contacts[0].fields;
  assert.equal(f.note.length, 200);
  assert.ok(f.note.startsWith('x y'), 'a line break becomes a space');
  assert.equal(f.n, '5');
  assert.equal(f.flag, 'true');
  assert.equal(f.city, 'First');
  assert.equal(f.proto_x, 'safe');
  assert.ok(!('nothing' in f) && !('nested' in f));
  assert.equal(Object.getPrototypeOf(f), Object.prototype);
});

test('a duplicate row keeps the first contact\'s columns', async () => {
  const out = await parseEmailContacts(buf('name,email,city\nA,a@example.com,Pune\nB,a@example.com,Delhi\n'), 'list.csv');
  assert.deepEqual(out.contacts, [{ name: 'A', email: 'a@example.com', fields: { city: 'Pune' } }]);
});

test('XLSX: extra columns come through as text', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contacts');
  ws.addRow(['Name', 'Phone', 'Order No']);
  ws.addRow(['Asha', 8123456789, 4471]);
  const out = await parseContacts(Buffer.from(await wb.xlsx.writeBuffer()), 'list.xlsx');
  assert.deepEqual(out.contacts[0].fields, { order_no: '4471' });
});
