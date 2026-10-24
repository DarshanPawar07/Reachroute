import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { columnKey } from './template.js';
import { assertSafeZip } from './zipGuard.js';

const NAME_KEYS = ['name', 'full name', 'fullname', 'contact name', 'first name'];
const PHONE_KEYS = ['phone', 'phone number', 'mobile', 'mobile number', 'number', 'contact', 'whatsapp', 'whatsapp number'];
const EMAIL_KEYS = ['email', 'email address', 'e-mail', 'mail', 'email id'];

/** Most extra columns kept per file. More than this is almost certainly a mistake, and every column is stored per contact. */
export const MAX_COLUMNS = 20;
const MAX_VALUE = 200;
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * The columns of a row that are not the name or the phone / email: { city: 'Pune', company: 'Acme' }, or null when
 * there are none. Headers become variable names ("Order #" -> order). `state` follows the columns seen across the
 * whole file so only the first MAX_COLUMNS are kept.
 */
function extraFields(row, reserved, state) {
  const out = {};
  for (const [header, raw] of Object.entries(row)) {
    if (reserved.has(String(header).trim().toLowerCase())) continue;
    const key = columnKey(header);
    if (!key || Object.hasOwn(out, key)) continue;
    if (raw === null || raw === undefined || typeof raw === 'object') continue;
    const value = String(raw).replace(CONTROL, ' ').trim().slice(0, MAX_VALUE);
    if (!value) continue;
    if (!state.columns.has(key)) {
      if (state.columns.size >= MAX_COLUMNS) {
        state.ignored.add(key);
        continue;
      }
      state.columns.add(key);
    }
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function pick(row, keys) {
  const lowered = {};
  for (const [k, v] of Object.entries(row)) lowered[String(k).trim().toLowerCase()] = v;
  for (const key of keys) {
    if (lowered[key] !== undefined && String(lowered[key]).trim() !== '') return String(lowered[key]).trim();
  }
  return '';
}

/** Normalize a raw phone value to digits-only E.164 (no '+'), or null if invalid. */
export function normalizePhone(raw, defaultCountry = 'IN') {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  const digitsOnly = s.replace(/[\s\-().]/g, '');
  // Sheets often store "919876543210" without a '+'; treat long digit strings as international.
  if (/^\d+$/.test(digitsOnly) && digitsOnly.length > 10 && !digitsOnly.startsWith('0')) {
    s = '+' + digitsOnly;
  }
  const parsed = parsePhoneNumberFromString(s, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number.replace('+', '');
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

/** Returns a lowercase email, or null if it doesn't look valid. No whitespace allowed (blocks header injection). */
export function normalizeEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s.length > 254 || !EMAIL_RE.test(s)) return null;
  return s;
}

async function rowsFromXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    headers[col] = String(cell.text || '').trim();
  });
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    headers.forEach((h, col) => {
      if (h) obj[h] = row.getCell(col).text;
    });
    rows.push(obj);
  });
  return rows;
}

function rowsFromJson(buffer) {
  const data = JSON.parse(buffer.toString('utf8'));
  const arr = Array.isArray(data) ? data : Array.isArray(data?.contacts) ? data.contacts : null;
  if (!arr) throw new Error('JSON must be an array of contacts, or an object with a "contacts" array');
  return arr.filter((r) => r && typeof r === 'object');
}

/** Guess the CSV delimiter from the header line: whichever of , ; tab appears most. */
export function detectDelimiter(buffer) {
  const firstLine = buffer.toString('utf8', 0, Math.min(buffer.length, 4096)).split(/\r?\n/)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** Read the rows of a .csv, .xlsx or .json upload and enforce the row limit. */
async function readRows(buffer, filename, maxRows) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  let rows;
  try {
    if (ext === 'csv') {
      if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
        throw Object.assign(new Error('This looks like an Excel file renamed to .csv. Upload it as .xlsx.'), { status: 400 });
      }
      rows = parseCsv(buffer, {
        columns: (header) => header.map((h) => String(h).trim()),
        skip_empty_lines: true,
        bom: true,
        trim: true,
        relax_column_count: true,
        delimiter: detectDelimiter(buffer), // Excel in some regions exports with ; or tabs
        to: maxRows + 1, // stop reading early on huge files; one extra row lets us detect "too many"
      });
    } else if (ext === 'xlsx') {
      assertSafeZip(buffer); // reject zip bombs before anything is unpacked
      rows = await rowsFromXlsx(buffer);
    } else if (ext === 'json') {
      rows = rowsFromJson(buffer);
    } else {
      throw new Error('Unsupported file type. Upload a .csv, .xlsx or .json file.');
    }
  } catch (err) {
    if (!err.status) {
      err.status = 400;
      err.message = err.message.startsWith('Unsupported') || err.message.startsWith('JSON must')
        ? err.message
        : `Could not read the file: ${err.message}`;
    }
    throw err;
  }
  if (rows.length > maxRows) {
    const err = new Error(`Too many contacts in that file. The limit is ${maxRows} per upload.`);
    err.status = 400;
    throw err;
  }
  return rows;
}

/** Shared dedupe/validate loop. */
function collect(rows, keys, normalize) {
  const seen = new Set();
  const contacts = [];
  const invalid = [];
  let duplicates = 0;
  const reserved = new Set([...NAME_KEYS, ...keys]);
  const state = { columns: new Set(), ignored: new Set() };
  rows.forEach((row, i) => {
    const raw = pick(row, keys);
    const value = normalize(raw);
    if (!value) {
      invalid.push({ row: i + 2, value: raw || '(empty)' });
      return;
    }
    if (seen.has(value)) {
      duplicates += 1;
      return;
    }
    seen.add(value);
    // Names end up in messages: drop control characters and cap the length.
    const fields = extraFields(row, reserved, state);
    contacts.push({ name: pick(row, NAME_KEYS).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100), value, ...(fields ? { fields } : {}) });
  });
  return { contacts, invalid, duplicates, totalRows: rows.length, columns: [...state.columns], ignoredColumns: [...state.ignored] };
}

/** WhatsApp: returns { contacts: [{name, phone, fields?}], invalid, duplicates, totalRows, columns, ignoredColumns }. */
export async function parseContacts(buffer, filename, { defaultCountry = 'IN', maxRows = 100 } = {}) {
  const rows = await readRows(buffer, filename, maxRows);
  const out = collect(rows, PHONE_KEYS, (raw) => normalizePhone(raw, defaultCountry));
  return { ...out, contacts: out.contacts.map(({ value, ...c }) => ({ ...c, phone: value })) };
}

/** Email: returns { contacts: [{name, email, fields?}], invalid, duplicates, totalRows, columns, ignoredColumns }. */
export async function parseEmailContacts(buffer, filename, { maxRows = 500 } = {}) {
  const rows = await readRows(buffer, filename, maxRows);
  const out = collect(rows, EMAIL_KEYS, normalizeEmail);
  return { ...out, contacts: out.contacts.map(({ value, ...c }) => ({ ...c, email: value })) };
}
