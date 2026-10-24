const OPT_OUT_LINE = '\n\nReply STOP to opt out.';

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Message templates (no database, so it can be unit tested).
 *
 *   {{name}}              the contact's name (or "there" when there is none)
 *   {{first_name}}        the first word of the name
 *   {{city}}              any other column of the contact file, the column name in lower case with _ for spaces
 *   {{city|your city}}    the same, with a fallback for contacts whose value is empty
 *   {Hi|Hello|Hey}        one of the options, picked at random, so messages are not identical
 */

/** Variables every contact has, whatever the file contained. */
export const BUILT_IN = ['name', 'first_name'];

// {{ name }}, {{first name}}, {{ city | your city }}. The name is letters, numbers, underscores and spaces.
const VAR_RE = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_ ]{0,38}?)\s*(?:\|([^{}|]*))?\}\}/g;
const VAR_WHOLE = new RegExp(`^${VAR_RE.source}$`);
const PLACEHOLDER_RE = /\{\{[^{}]*\}\}/g; // anything that looks like a variable, valid or not
// Values end up inside messages: no control characters, and none of the characters that mean something to the template.
const UNSAFE = /[\u0000-\u001f\u007f{}|]/g;

/** "Order #", "First Name" -> "order", "first_name": how a column header becomes a variable name. */
export function columnKey(header) {
  return String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

const clean = (value, max = 200) => String(value ?? '').replace(UNSAFE, '').trim().slice(0, max);

/**
 * Replace the {{variables}} of `text` for one contact: { name, fields }. `escape` is applied to every inserted value
 * (HTML emails pass an HTML escaper). Values can never inject template syntax.
 */
export function fillVariables(text, { name = '', fields = null } = {}, escape = (s) => s) {
  return String(text).replace(VAR_RE, (_, raw, fallback) => {
    const key = columnKey(raw);
    let value;
    if (key === 'name') value = clean(name, 100);
    else if (key === 'first_name') value = clean(name, 100).split(/\s+/)[0] || '';
    else value = fields && Object.hasOwn(fields, key) ? clean(fields[key]) : ''; // own values only: {{constructor}} must not reach Object's
    if (!value) value = (fallback === undefined ? '' : clean(fallback)) || (BUILT_IN.includes(key) ? 'there' : '');
    return escape(value);
  });
}

/**
 * What a template needs. Returns { variables: [{ key, optional }], malformed: ['{{first-name}}', ...] }
 * `variables` lists the columns used (not name / first_name); optional = every use has a fallback.
 * `malformed` are placeholders that would be sent as they are because they are not valid variables.
 */
export function analyze(texts) {
  const variables = new Map();
  const malformed = new Set();
  for (const text of texts) {
    for (const m of String(text ?? '').matchAll(VAR_RE)) {
      const key = columnKey(m[1]);
      if (BUILT_IN.includes(key)) continue;
      const entry = variables.get(key) || { key, optional: true };
      if (!clean(m[2])) entry.optional = false;
      variables.set(key, entry);
    }
    for (const m of String(text ?? '').matchAll(PLACEHOLDER_RE)) if (!VAR_WHOLE.test(m[0])) malformed.add(m[0]);
  }
  return { variables: [...variables.values()], malformed: [...malformed] };
}

/**
 * Problems that must stop a campaign (empty list = fine). `columns` are the variable names the contacts have;
 * pass null when they are not known, then only broken placeholders are reported.
 */
export function checkTemplate(texts, columns = null) {
  const { variables, malformed } = analyze(texts);
  const problems = malformed.map((p) => `"${p}" is not a valid variable. Use letters, numbers and underscores, like {{first_name}}, and {{city|your city}} for a fallback.`);
  if (columns) {
    const have = new Set(columns);
    for (const v of variables) {
      if (have.has(v.key) || v.optional) continue;
      const found = columns.length ? `Columns found: ${columns.join(', ')}.` : 'The file has no columns besides name and the phone or email.';
      problems.push(`The message uses {{${v.key}}}, but your contacts have no "${v.key}" column. ${found} Add the column, or write a fallback like {{${v.key}|a default}}.`);
    }
  }
  return problems;
}

/** The contacts' columns: every variable name that at least one of them has a value for. */
export function columnsOf(contacts) {
  const keys = new Set();
  for (const c of contacts) for (const [k, v] of Object.entries(c.fields || {})) if (String(v ?? '').trim()) keys.add(k);
  return [...keys].sort();
}

/** For each column the message needs without a fallback: how many contacts have no value for it. */
export function blankValues(texts, contacts) {
  const out = {};
  for (const v of analyze(texts).variables) {
    if (v.optional) continue;
    const blank = contacts.filter((c) => !(c.fields && Object.hasOwn(c.fields, v.key) && String(c.fields[v.key] ?? '').trim())).length;
    if (blank) out[v.key] = blank;
  }
  return out;
}

/**
 * Render a message for one recipient: variables first, then {a|b|c} choices, then the optional opt-out line.
 * `fields` are the contact's other columns.
 */
export function renderMessage(template, name, { appendOptOut = true, fields = null } = {}) {
  let text = fillVariables(template, { name, fields });
  text = text.replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_, group) => {
    const options = group.split('|');
    return options[rand(0, options.length - 1)].trim();
  });
  return appendOptOut ? text + OPT_OUT_LINE : text;
}

export { rand };
