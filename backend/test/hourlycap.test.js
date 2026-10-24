import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSlotAt } from '../src/engine/schedule.js';

const HOUR = 3_600_000;

test('a message may go out right now while fewer than the cap were sent in the window', () => {
  assert.equal(nextSlotAt({ sentAtDesc: [], cap: 3, now: 1_000_000 }), 0);
  assert.equal(nextSlotAt({ sentAtDesc: [900_000, 800_000], cap: 3, now: 1_000_000 }), 0);
});

test('at the cap, the next slot is when the oldest counted message leaves the hour', () => {
  // sent at 10, 20, 30 minutes: the 10-minute one leaves the window first
  const sent = [30, 20, 10].map((m) => m * 60_000);
  assert.equal(nextSlotAt({ sentAtDesc: sent, cap: 3, now: 40 * 60_000 }), 10 * 60_000 + HOUR);
});

test('with more messages than the cap, enough of the old ones must leave first', () => {
  const sent = [50, 40, 30, 20, 10].map((m) => m * 60_000);
  // cap 3: two may stay, so the third newest (30 min) must leave
  assert.equal(nextSlotAt({ sentAtDesc: sent, cap: 3, now: 55 * 60_000 }), 30 * 60_000 + HOUR);
});

test('messages older than the window do not count', () => {
  const now = 3 * HOUR;
  assert.equal(nextSlotAt({ sentAtDesc: [now - HOUR - 1, now - 2 * HOUR, now - 2.5 * HOUR], cap: 3, now }), 0);
  assert.equal(nextSlotAt({ sentAtDesc: [now - 10, now - HOUR - 1, now - 2 * HOUR], cap: 2, now }), 0);
});

test('a custom window works', () => {
  assert.equal(nextSlotAt({ sentAtDesc: [95, 90], cap: 2, now: 100, windowMs: 60 }), 90 + 60);
});
