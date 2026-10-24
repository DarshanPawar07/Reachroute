import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assignVariants, readAb } from '../src/utils/ab.js';
import { renderEmail } from '../src/utils/emailTemplate.js';

const count = (list, v) => list.filter((x) => x === v).length;

test('exactly the asked share gets the second subject', () => {
  assert.equal(count(assignVariants(10, 30), 'B'), 3);
  assert.equal(count(assignVariants(10, 50), 'B'), 5);
  assert.equal(count(assignVariants(100, 20), 'B'), 20);
  assert.equal(assignVariants(37, 50).length, 37);
});

test('both groups always have someone, unless there is only one person', () => {
  assert.equal(count(assignVariants(2, 1), 'B'), 1);
  assert.equal(count(assignVariants(2, 99), 'A'), 1);
  assert.equal(count(assignVariants(5, 1), 'B'), 1);
  assert.deepEqual(assignVariants(1, 50), ['A']);
  assert.deepEqual(assignVariants(0, 50), []);
});

test('the order is shuffled, so a place in the file decides nothing', () => {
  const picks = [];
  for (let i = 0; i < 200; i++) picks.push(assignVariants(20, 50)[0]);
  assert.ok(count(picks, 'A') > 40 && count(picks, 'B') > 40, 'the first person gets either subject');
  // a fixed random source gives a fixed result
  assert.deepEqual(assignVariants(4, 50, () => 0), assignVariants(4, 50, () => 0));
});

test('the A/B fields are read and checked', () => {
  assert.deepEqual(readAb({}, 'Hello'), { subjectB: '', splitB: 50 });
  assert.deepEqual(readAb({ subjectB: '   ' }, 'Hello'), { subjectB: '', splitB: 50 });
  assert.deepEqual(readAb({ subjectB: ' Hi there ', splitB: '30' }, 'Hello'), { subjectB: 'Hi there', splitB: 30 });
  assert.deepEqual(readAb({ subjectB: 'Other' }, 'Hello'), { subjectB: 'Other', splitB: 50 });
  assert.throws(() => readAb({ subjectB: 'HELLO' }, 'Hello'), /same/);
  for (const bad of ['0', '100', '-5', '2.5', 'abc']) assert.throws(() => readAb({ subjectB: 'Other', splitB: bad }, 'Hello'), /1 to 99/, bad);
  assert.throws(() => readAb({ subjectB: 'x'.repeat(201) }, 'Hello'), /too long/);
});

test('each person gets the subject of their group, with their name filled in', () => {
  const campaign = { subject: 'Hello {{name}}', subjectB: 'Offer for {{name}}', body: 'Body', bodyFormat: 'text' };
  const url = 'http://x/unsub';
  assert.equal(renderEmail(campaign, { name: 'Asha', variant: 'A' }, url).subject, 'Hello Asha');
  assert.equal(renderEmail(campaign, { name: 'Asha', variant: 'B' }, url).subject, 'Offer for Asha');
  assert.equal(renderEmail(campaign, { name: 'Asha', variant: null }, url).subject, 'Hello Asha', 'no group: the first subject');
  assert.equal(renderEmail({ ...campaign, subjectB: '' }, { name: 'Asha', variant: 'B' }, url).subject, 'Hello Asha', 'no test: the first subject');
});
