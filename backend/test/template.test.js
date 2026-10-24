import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessage } from '../src/utils/template.js';

const plain = { appendOptOut: false };

test('fills in the name, ignoring case and spaces inside the braces', () => {
  assert.equal(renderMessage('Hi {{name}}', 'Asha', plain), 'Hi Asha');
  assert.equal(renderMessage('Hi {{ NAME }}', 'Asha', plain), 'Hi Asha');
});

test('falls back to "there" when there is no name', () => {
  assert.equal(renderMessage('Hi {{name}}', '', plain), 'Hi there');
  assert.equal(renderMessage('Hi {{name}}', undefined, plain), 'Hi there');
  assert.equal(renderMessage('Hi {{name}}', '   ', plain), 'Hi there');
});

test('{a|b|c} picks one option and varies between messages', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(renderMessage('{Hi|Hello|Hey} there', 'x', plain));
  assert.ok([...seen].every((s) => ['Hi there', 'Hello there', 'Hey there'].includes(s)));
  assert.ok(seen.size >= 2);
});

test('a name cannot inject template syntax', () => {
  const out = renderMessage('Hi {{name}}', '{A|B}', plain);
  assert.equal(out, 'Hi AB');
  assert.ok(!out.includes('{') && !out.includes('|'));
});

test('braces without a choice are left alone', () => {
  assert.equal(renderMessage('{solo} text', 'x', plain), '{solo} text');
});

test('the opt-out line is added by default and only then', () => {
  assert.ok(renderMessage('Hello', 'x').endsWith('Reply STOP to opt out.'));
  assert.equal(renderMessage('Hello', 'x', plain), 'Hello');
});

// ---------------------------------------------------------------- extra variables

const { analyze, blankValues, checkTemplate, columnKey, columnsOf, fillVariables } = await import('../src/utils/template.js');

test('first_name is the first word of the name, with or without an underscore', () => {
  assert.equal(renderMessage('Hi {{first_name}}', 'Asha Rao', plain), 'Hi Asha');
  assert.equal(renderMessage('Hi {{ First Name }}', 'Asha Rao', plain), 'Hi Asha');
  assert.equal(renderMessage('Hi {{first_name}}', '', plain), 'Hi there');
  assert.equal(renderMessage('Hi {{first_name|friend}}', '', plain), 'Hi friend');
});

test('other columns are filled in from the contact, ignoring case and spaces', () => {
  const fields = { company: 'Acme', order_no: '4471' };
  assert.equal(renderMessage('{{company}} order {{ Order No }}', 'x', { ...plain, fields }), 'Acme order 4471');
});

test('a missing or empty value uses the fallback, or nothing', () => {
  assert.equal(renderMessage('Hello from {{city|your city}}', 'x', { ...plain, fields: { city: 'Pune' } }), 'Hello from Pune');
  assert.equal(renderMessage('Hello from {{city|your city}}', 'x', { ...plain, fields: { city: '' } }), 'Hello from your city');
  assert.equal(renderMessage('Hello from {{ city | your city }}', 'x', plain), 'Hello from your city');
  assert.equal(renderMessage('Hello{{city}}!', 'x', plain), 'Hello!');
  assert.equal(renderMessage('{{name|friend}}', '', plain), 'friend');
});

test('values can never inject template syntax, and are not filled in twice', () => {
  const fields = { note: '{A|B} {{name}} |', city: '{{company}}', company: 'SECRET' };
  const out = renderMessage('{{note}} / {{city}}', 'Asha', { ...plain, fields });
  assert.equal(out, 'AB name / company');
  assert.ok(!out.includes('SECRET') && !out.includes('{') && !out.includes('|'));
});

test('control characters are removed and long values are cut', () => {
  const out = renderMessage('{{note}}', 'x', { ...plain, fields: { note: `  line1\nline2\u0000${'z'.repeat(500)}` } });
  assert.ok(out.startsWith('line1line2zzz'));
  assert.equal(out.length, 200);
});

test('only the contact\'s own values are used (nothing from JavaScript objects)', () => {
  const out = renderMessage('[{{constructor}}][{{__proto__}}][{{tostring|x}}][{{hasOwnProperty}}]', 'a', { ...plain, fields: { city: 'p' } });
  assert.equal(out, '[][][x][]');
});

test('{a|b} choices still work next to variables, and a fallback is not mistaken for a choice', () => {
  const out = renderMessage('{Hi|Hello} {{name}} from {{city|here}}', 'Asha', { ...plain, fields: {} });
  assert.ok(['Hi Asha from here', 'Hello Asha from here'].includes(out), out);
});

test('column headers become variable names', () => {
  assert.equal(columnKey('Order #'), 'order');
  assert.equal(columnKey('  First Name '), 'first_name');
  assert.equal(columnKey('E-mail Address'), 'e_mail_address');
  assert.equal(columnKey('City/Town'), 'city_town');
  assert.equal(columnKey('2nd line'), '2nd_line');
  assert.equal(columnKey('###'), '');
  assert.equal(columnKey('x'.repeat(100)).length, 40);
});

test('fillVariables escapes what it inserts when asked to (HTML emails)', () => {
  const esc = (s) => s.replace(/</g, '&lt;');
  assert.equal(fillVariables('Hi {{name}} {{city}}', { name: '<b>A</b>', fields: { city: '<i>' } }, esc), 'Hi &lt;b>A&lt;/b> &lt;i>');
});

test('analyze: which columns a message needs, and which placeholders are broken', () => {
  const r = analyze(['Hi {{name}} {{first_name}} {{a}} {{ b | x }} {{first-name}} {{a|y}}', '{{b}} {{x|y|z}} {{}} {{ }}']);
  assert.deepEqual(r.variables, [{ key: 'a', optional: false }, { key: 'b', optional: false }]);
  assert.deepEqual(r.malformed.sort(), ['{{ }}', '{{}}', '{{first-name}}', '{{x|y|z}}'].sort());
  assert.deepEqual(analyze(['{{c|fallback}} {{ c | other }}']).variables, [{ key: 'c', optional: true }]);
  assert.deepEqual(analyze([undefined, null, '']).variables, []);
  assert.deepEqual(analyze(['{single} {a|b}']), { variables: [], malformed: [] });
});

test('checkTemplate: broken placeholders and missing columns stop a campaign', () => {
  assert.deepEqual(checkTemplate(['Hi {{name}}', 'x'], ['city']), []);
  assert.match(checkTemplate(['Hi {{first-name}}'])[0], /"\{\{first-name\}\}" is not a valid variable/);
  const missing = checkTemplate(['{{company}} in {{city}}'], ['city', 'order']);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /uses \{\{company\}\}.*no "company" column.*Columns found: city, order/);
  assert.deepEqual(checkTemplate(['{{company|a company}}'], ['city']), [], 'a fallback makes a missing column fine');
  assert.match(checkTemplate(['{{company}}'], [])[0], /no columns besides name/);
  assert.deepEqual(checkTemplate(['{{company}}'], null), [], 'columns unknown: only broken placeholders are reported');
});

test('columnsOf and blankValues look at the contacts', () => {
  const contacts = [{ fields: { city: 'Pune', company: '' } }, { fields: { city: '  ' } }, {}, { fields: { order: '1' } }];
  assert.deepEqual(columnsOf(contacts), ['city', 'order']);
  assert.deepEqual(blankValues(['{{city}} {{order|x}} {{name}}'], contacts), { city: 3 });
  assert.deepEqual(blankValues(['{{city|there}}'], contacts), {});
  assert.deepEqual(blankValues(['{{constructor}}'], [{ fields: {} }]), { constructor: 1 });
});
