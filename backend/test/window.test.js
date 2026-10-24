import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpen, nextOpen, parseClock, parseWindow, readSchedule, windowOf } from '../src/engine/window.js';
import { planTimes } from '../src/engine/schedule.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// India has no daylight saving and is UTC+5:30, which keeps the expectations easy to read.
const IST = 'Asia/Kolkata';
const at = (iso) => Date.parse(iso);
const nineToSix = { start: 9 * 60, end: 18 * 60, timezone: IST, days: [] };

test('clock times: 24-hour format, with or without a leading zero', () => {
  assert.equal(parseClock('09:00', 'x'), 540);
  assert.equal(parseClock('9:30', 'x'), 570);
  assert.equal(parseClock('23:59', 'x'), 1439);
  for (const bad of ['24:00', '9', '09:60', 'nine', '', null, '9:5']) assert.throws(() => parseClock(bad, 'The start'), /The start must be a time/);
});

test('a window is open from its start up to, but not including, its end', () => {
  assert.equal(isOpen(at('2026-11-02T09:00:00+05:30'), nineToSix), true);
  assert.equal(isOpen(at('2026-11-02T17:59:59+05:30'), nineToSix), true);
  assert.equal(isOpen(at('2026-11-02T18:00:00+05:30'), nineToSix), false);
  assert.equal(isOpen(at('2026-11-02T08:59:59+05:30'), nineToSix), false);
  assert.equal(isOpen(123, null), true, 'no window means always open');
});

test('the window follows the timezone, not the server clock', () => {
  const t = at('2026-11-02T04:00:00Z'); // 09:30 in India, 04:00 in London
  assert.equal(isOpen(t, nineToSix), true);
  assert.equal(isOpen(t, { ...nineToSix, timezone: 'Europe/London' }), false);
});

test('outside the window the next opening is the next start time', () => {
  assert.equal(nextOpen(at('2026-11-02T07:00:00+05:30'), nineToSix), at('2026-11-02T09:00:00+05:30'));
  assert.equal(nextOpen(at('2026-11-02T18:00:00+05:30'), nineToSix), at('2026-11-03T09:00:00+05:30'));
  assert.equal(nextOpen(at('2026-11-02T23:59:59.500+05:30'), nineToSix), at('2026-11-03T09:00:00+05:30'));
  assert.equal(nextOpen(at('2026-11-02T10:00:00+05:30'), nineToSix), at('2026-11-02T10:00:00+05:30'), 'already open: unchanged');
});

test('weekday limits skip the days that are not allowed', () => {
  const weekdays = { ...nineToSix, days: [1, 2, 3, 4, 5] };
  // 2026-11-06 is a Friday, 2026-11-07 a Saturday, 2026-11-09 a Monday
  assert.equal(nextOpen(at('2026-11-06T18:30:00+05:30'), weekdays), at('2026-11-09T09:00:00+05:30'));
  assert.equal(nextOpen(at('2026-11-07T10:00:00+05:30'), weekdays), at('2026-11-09T09:00:00+05:30'));
  assert.equal(isOpen(at('2026-11-07T10:00:00+05:30'), weekdays), false);
  assert.equal(isOpen(at('2026-11-06T10:00:00+05:30'), weekdays), true);
  const sundayOnly = { ...nineToSix, days: [0] };
  assert.equal(nextOpen(at('2026-11-02T10:00:00+05:30'), sundayOnly), at('2026-11-08T09:00:00+05:30'));
});

test('a window can cross midnight, and a night belongs to the day it started', () => {
  const night = { start: 22 * 60, end: 6 * 60, timezone: IST, days: [] };
  assert.equal(isOpen(at('2026-11-02T23:00:00+05:30'), night), true);
  assert.equal(isOpen(at('2026-11-03T05:59:00+05:30'), night), true);
  assert.equal(isOpen(at('2026-11-03T06:00:00+05:30'), night), false);
  assert.equal(nextOpen(at('2026-11-03T06:00:00+05:30'), night), at('2026-11-03T22:00:00+05:30'));

  // Friday-night window only: Saturday 02:00 is still part of Friday night, Sunday 02:00 is not.
  const fridayNights = { ...night, days: [5] };
  assert.equal(isOpen(at('2026-11-07T02:00:00+05:30'), fridayNights), true); // Saturday early morning
  assert.equal(isOpen(at('2026-11-08T02:00:00+05:30'), fridayNights), false); // Sunday early morning
  assert.equal(nextOpen(at('2026-11-07T07:00:00+05:30'), fridayNights), at('2026-11-13T22:00:00+05:30'));
});

test('daylight saving changes never make the next opening wrong or loop forever', () => {
  const london = { start: 9 * 60, end: 17 * 60, timezone: 'Europe/London', days: [] };
  // Clocks go back on 2026-10-25 and forward on 2027-03-28.
  const afterAutumn = nextOpen(at('2026-10-24T20:00:00Z'), london);
  assert.equal(afterAutumn, at('2026-10-25T09:00:00Z'), '09:00 GMT on the day the clocks went back');
  const afterSpring = nextOpen(at('2027-03-27T20:00:00Z'), london);
  assert.equal(afterSpring, at('2027-03-28T08:00:00Z'), '09:00 BST on the day the clocks went forward');
  for (let t = at('2026-10-20T00:00:00Z'); t < at('2026-11-05T00:00:00Z'); t += 37 * 60_000) {
    const open = nextOpen(t, london);
    assert.ok(open >= t && open - t <= 2 * DAY, 'the next opening is soon');
    assert.equal(isOpen(open, london), true, 'and it really is open');
  }
});

test('windows are validated with plain messages', () => {
  assert.deepEqual(parseWindow({ start: '09:00', end: '18:00', timezone: IST, days: '1,2,3' }), { start: 540, end: 1080, timezone: IST, days: [1, 2, 3] });
  assert.deepEqual(parseWindow({ start: '9:00', end: '18:00', timezone: IST, days: [3, 1, 3] }).days, [1, 3]);
  assert.deepEqual(parseWindow({ start: '9:00', end: '18:00', timezone: IST, days: '0,1,2,3,4,5,6' }).days, [], 'every day = no limit');
  assert.throws(() => parseWindow({ start: '09:00', end: '09:00', timezone: IST }), /different times/);
  assert.throws(() => parseWindow({ start: '09:00', end: '18:00' }), /timezone/);
  assert.throws(() => parseWindow({ start: '09:00', end: '18:00', timezone: 'Mars/Base' }), /not a known timezone/);
  assert.throws(() => parseWindow({ start: '09:00', end: '18:00', timezone: IST, days: '7' }), /0 \(Sunday\) to 6/);
  assert.throws(() => parseWindow({ start: '09:00', end: '18:00', timezone: IST, days: 'mon' }), /0 \(Sunday\) to 6/);
});

test('request fields: nothing sent means nothing changes', () => {
  assert.deepEqual(readSchedule({}), {});
  assert.deepEqual(readSchedule(undefined), {});
  assert.deepEqual(readSchedule({ name: 'x', message: 'y' }), {});
});

test('request fields: start time', () => {
  const now = at('2026-11-02T10:00:00Z');
  const later = readSchedule({ startAt: '2026-11-03T09:30:00+05:30' }, { now });
  assert.equal(later.startAt.getTime(), at('2026-11-03T04:00:00Z'));
  assert.equal(readSchedule({ startAt: '' }, { now }).startAt, null);
  assert.equal(readSchedule({ startAt: null }, { now }).startAt, null);
  assert.equal(readSchedule({ startAt: '2026-11-02T10:00:03Z' }, { now }).startAt, null, 'a few seconds ahead is just "now"');
  assert.equal(readSchedule({ startAt: '2026-11-02T09:59:30Z' }, { now }).startAt, null, 'half a minute ago is just "now"');
  assert.throws(() => readSchedule({ startAt: '2026-11-02T09:00:00Z' }, { now }), /already passed/);
  assert.throws(() => readSchedule({ startAt: '2026-12-25T09:00:00Z' }, { now, maxDays: 30 }), /at most 30 days/);
  assert.throws(() => readSchedule({ startAt: '2026-11-03' }, { now }), /must look like/, 'no timezone, no guessing');
  assert.throws(() => readSchedule({ startAt: '2026-11-03T09:00' }, { now }), /must look like/);
  assert.throws(() => readSchedule({ startAt: 'tomorrow' }, { now }), /must look like/);
  assert.throws(() => readSchedule({ startAt: '2026-13-45T99:00:00Z' }, { now }), /must look like/);
});

test('request fields: send window', () => {
  const ok = readSchedule({ windowStart: '09:00', windowEnd: '18:00', timezone: IST, windowDays: '1,2,3,4,5' });
  assert.deepEqual(ok.sendWindow, { start: 540, end: 1080, timezone: IST, days: [1, 2, 3, 4, 5] });
  assert.equal('startAt' in ok, false);
  assert.equal(readSchedule({ removeWindow: 'true' }).sendWindow, null);
  assert.equal(readSchedule({ removeWindow: true }).sendWindow, null);
  assert.throws(() => readSchedule({ windowStart: '09:00', timezone: IST }), /both a start and an end/);
  assert.throws(() => readSchedule({ windowEnd: '18:00', timezone: IST }), /both a start and an end/);
  assert.throws(() => readSchedule({ timezone: IST }), /both a start and an end/);
  assert.throws(() => readSchedule({ windowStart: '09:00', windowEnd: '18:00', removeWindow: true, timezone: IST }), /not both/);
  assert.throws(() => readSchedule({ windowStart: '09:00', windowEnd: '18:00' }), /timezone/);
});

test('a stored window reads back as a plain object, and no window as null', () => {
  assert.equal(windowOf({}), null);
  assert.equal(windowOf({ sendWindow: null }), null);
  assert.deepEqual(windowOf({ sendWindow: { start: 0, end: 60, timezone: IST, days: [1] } }), { start: 0, end: 60, timezone: IST, days: [1] });
  assert.deepEqual(windowOf({ sendWindow: { start: 540, end: 1080, timezone: IST } }).days, []);
});

// ---------------------------------------------------------------- planning with a window

test('planning: a scheduled start is respected and the first send is exactly then', () => {
  const start = at('2026-11-05T09:00:00+05:30');
  assert.deepEqual(planTimes({ now: 0, count: 3, gap: () => 10_000, notBeforeMs: start }), [start, start + 10_000, start + 20_000]);
});

test('planning: a start time in the past changes nothing', () => {
  assert.deepEqual(planTimes({ now: 100_000, count: 2, gap: () => 5000, jitterMs: 2000, notBeforeMs: 1 }), [102_000, 107_000]);
});

test('planning: sends that would pass the end of the window continue at the next opening', () => {
  const now = at('2026-11-02T17:59:00+05:30');
  const times = planTimes({ now, count: 4, gap: () => 30_000, jitterMs: 0, window: nineToSix });
  assert.deepEqual(times, [
    at('2026-11-02T17:59:00+05:30'),
    at('2026-11-02T17:59:30+05:30'),
    at('2026-11-03T09:00:00+05:30'), // 18:00:00 is closed
    at('2026-11-03T09:00:30+05:30'),
  ]);
});

test('planning: starting outside the window waits for it, and every time stays inside', () => {
  const now = at('2026-11-02T22:00:00+05:30');
  const gap = () => 20 * 60_000;
  const times = planTimes({ now, count: 60, gap, window: nineToSix });
  assert.ok(times[0] >= at('2026-11-03T09:00:00+05:30'));
  for (const t of times) assert.equal(isOpen(t, nineToSix), true);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], 'times keep increasing');
  assert.ok(times.at(-1) > at('2026-11-04T00:00:00+05:30'), 'sixty sends 20 minutes apart need more than one day of 9 hours');
});

test('planning: a scheduled start plus a window starts at the first opening after the start', () => {
  const start = at('2026-11-07T20:00:00+05:30'); // Saturday evening
  const weekdays = { ...nineToSix, days: [1, 2, 3, 4, 5] };
  const [first] = planTimes({ now: 0, count: 1, gap: () => 1000, notBeforeMs: start, window: weekdays });
  assert.equal(first, at('2026-11-09T09:00:00+05:30'));
});
