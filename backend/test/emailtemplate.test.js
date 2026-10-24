import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// Needs the real sanitize-html package, so it runs after `npm install`.
const { renderEmail } = await import('../src/utils/emailTemplate.js');

const UNSUB = 'https://app.test/unsubscribe/abc';
const render = (campaign, recipient) => renderEmail({ bodyFormat: 'text', ...campaign }, recipient, UNSUB);

test('subject and body get the name, the first name and the other columns', () => {
  const r = render(
    { subject: 'Hi {{first_name}} from {{company}}', body: 'Hello {{name}},\nyour order {{order}} is ready.' },
    { name: 'Asha Rao', fields: { company: 'Acme', order: '4471' } }
  );
  assert.equal(r.subject, 'Hi Asha from Acme');
  assert.ok(r.text.startsWith('Hello Asha Rao,\nyour order 4471 is ready.'));
  assert.ok(r.html.includes('your order 4471 is ready.'));
});

test('fallbacks work in the subject and the body, and "there" is still the default name', () => {
  const r = render({ subject: 'News for {{city|you}}', body: 'Hi {{name}} in {{city|your city}}' }, { name: '', fields: {} });
  assert.equal(r.subject, 'News for you');
  assert.ok(r.text.startsWith('Hi there in your city'));
});

test('the unsubscribe footer is always there', () => {
  const r = render({ subject: 's', body: 'b' }, { name: 'A' });
  assert.ok(r.text.includes(`Unsubscribe: ${UNSUB}`));
  assert.ok(r.html.includes(`href="${UNSUB}"`));
});

test('HTML emails: inserted values are escaped, so a value cannot add markup', () => {
  const r = render(
    { subject: 's', body: '<p>Hi {{name}}, from {{company}}</p>', bodyFormat: 'html' },
    { name: 'A<script>alert(1)</script>', fields: { company: '<img src=x onerror=alert(1)>' } }
  );
  assert.ok(!/<script|<img/i.test(r.html), r.html);
  assert.ok(r.html.includes('&lt;'));
});

test('text emails are shown as text: a value with markup stays inert', () => {
  const r = render({ subject: 's', body: '{{company}}' }, { name: 'A', fields: { company: '<b>bold</b>' } });
  assert.ok(r.html.includes('&lt;b&gt;bold&lt;/b&gt;'));
});

test('a value cannot break the subject line or add template syntax', () => {
  const r = render({ subject: 'Re: {{note}}', body: 'x' }, { name: 'A', fields: { note: 'one\r\nBcc: evil@example.com {{name}}' } });
  assert.ok(!/[\r\n]/.test(r.subject));
  assert.equal(r.subject, 'Re: oneBcc: evil@example.com name');
});

test('a subject with line breaks is put on one line', () => {
  assert.equal(render({ subject: 'a\nb\r\nc', body: 'x' }, { name: 'A' }).subject, 'a b c');
});
