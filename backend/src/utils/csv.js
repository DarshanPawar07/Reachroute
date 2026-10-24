/**
 * Writing CSV that opens safely in Excel and Google Sheets.
 * A cell that starts with = + - @ (or a tab / carriage return) would be run as a formula by a spreadsheet, so it gets a
 * leading apostrophe. Cells with commas, quotes or line breaks are quoted.
 */
const RISKY_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (RISKY_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvLine = (cells) => `${cells.map(csvCell).join(',')}\r\n`;

/** A file name for a download made from free text: letters, numbers, dashes. */
export function safeDownloadName(text, fallback = 'report') {
  const base = String(text || '').normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
  return base || fallback;
}
