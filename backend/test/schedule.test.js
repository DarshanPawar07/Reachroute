import test from 'node:test';
import assert from 'node:assert/strict';
import { planTimes } from '../src/engine/schedule.js';

test('first send is a couple of seconds from now, later ones are one gap apart', () => {
  assert.deepEqual(planTimes({ now: 1000, count: 3, gap: () => 5000, jitterMs: 2000 }), [3000, 8000, 13000]);
});

test('waits behind messages the user already has scheduled', () => {
  assert.deepEqual(planTimes({ now: 1000, latestMs: 100000, count: 3, gap: () => 5000, jitterMs: 2000 }), [105000, 110000, 115000]);
});

test('an old latest time never pulls the start earlier than now + jitter', () => {
  assert.equal(planTimes({ now: 1000, latestMs: 2000, count: 1, gap: () => 1000, jitterMs: 2000 })[0], 3000);
  assert.equal(planTimes({ now: 50_000, latestMs: 2000, count: 1, gap: () => 1000, jitterMs: 2000 })[0], 52_000);
});

test('zero recipients gives no times', () => {
  assert.deepEqual(planTimes({ now: 0, count: 0, gap: () => 1000 }), []);
});

test('random gaps always stay inside the range and times strictly increase', () => {
  const gap = () => 1000 + Math.floor(Math.random() * 2001);
  for (let run = 0; run < 100; run++) {
    const t = planTimes({ now: 0, count: 20, gap });
    for (let i = 1; i < t.length; i++) {
      const d = t[i] - t[i - 1];
      assert.ok(d >= 1000 && d <= 3000, `gap ${d} out of range`);
    }
  }
});
