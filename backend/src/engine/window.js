// Same shape as utils/http.js `bad` (kept here so this file has no imports and can be tested on its own).
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Send windows and start times (no database, so it can be unit tested).
 *
 * A send window says "only send between 09:00 and 18:00 in this timezone, on these weekdays".
 * It is stored on the campaign as { start, end, timezone, days } where start and end are minutes after local
 * midnight (end is exclusive), timezone is an IANA name such as "Asia/Kolkata" and days lists the weekdays that
 * are allowed (0 = Sunday ... 6 = Saturday; empty = every day). A window may cross midnight (22:00 to 06:00):
 * then a night belongs to the weekday it started on.
 */

const DAY_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

// ---------------------------------------------------------------- local time

const formatters = new Map();

/** What the clock on the wall says in `timeZone` at the instant `ms`. */
function localParts(ms, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, fmt);
  }
  const p = {};
  for (const part of fmt.formatToParts(ms)) p[part.type] = part.value;
  return { minutes: Number(p.hour) * 60 + Number(p.minute), seconds: Number(p.second), weekday: WEEKDAYS[p.weekday] };
}

const crossesMidnight = (w) => w.start > w.end;

/** The weekday a moment counts for: after midnight in an overnight window it is still the day the window started. */
function windowDay({ minutes, weekday }, w) {
  return crossesMidnight(w) && minutes < w.end ? (weekday + 6) % 7 : weekday;
}

/** True when sending is allowed at the instant `ms`. */
export function isOpen(ms, w) {
  if (!w) return true;
  const local = localParts(ms, w.timezone);
  const inTime = crossesMidnight(w) ? local.minutes >= w.start || local.minutes < w.end : local.minutes >= w.start && local.minutes < w.end;
  if (!inTime) return false;
  return !w.days?.length || w.days.includes(windowDay(local, w));
}

/**
 * After a jump across a daylight-saving change we can land an hour after the opening time (the clock moved in between).
 * Step back to the opening time itself when that is still after `floor` and really is the start of the window.
 */
function snapToStart(t, w, floor) {
  const local = localParts(t, w.timezone);
  const late = (local.minutes - w.start + DAY_MINUTES) % DAY_MINUTES;
  if (late === 0 || late > 180) return t;
  const candidate = t - late * MINUTE_MS - local.seconds * 1000 - (((t % 1000) + 1000) % 1000);
  if (candidate > floor && isOpen(candidate, w) && localParts(candidate, w.timezone).minutes === w.start) return candidate;
  return t;
}

/** The first instant at or after `ms` when sending is allowed (the opening time of the next window). */
export function nextOpen(ms, w) {
  if (!w) return ms;
  let t = ms;
  // One jump almost always lands on the opening time. The loop only repeats around daylight-saving changes.
  for (let round = 0; round < 12; round++) {
    if (isOpen(t, w)) return round === 0 ? t : snapToStart(t, w, ms);
    const local = localParts(t, w.timezone);
    const intoSecond = ((t % 1000) + 1000) % 1000;
    let target = null;
    for (let day = 0; day <= 7; day++) {
      const wait = (day * DAY_MINUTES + w.start - local.minutes) * MINUTE_MS - local.seconds * 1000 - intoSecond;
      if (wait <= 0) continue; // that opening time has already passed
      if (!w.days?.length || w.days.includes((local.weekday + day) % 7)) {
        target = t + wait;
        break;
      }
    }
    t = target ?? t + DAY_MINUTES * MINUTE_MS; // unreachable for a valid window; never loops forever
  }
  return t;
}

// ---------------------------------------------------------------- reading what the user sent

/** "09:00" or "9:30" -> minutes after midnight. */
export function parseClock(value, label) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  const hours = m ? Number(m[1]) : NaN;
  const minutes = m ? Number(m[2]) : NaN;
  if (!m || hours > 23 || minutes > 59) throw bad(`${label} must be a time like 09:00 (24-hour clock).`);
  return hours * 60 + minutes;
}

function validTimeZone(value) {
  const name = String(value ?? '').trim();
  if (!name) throw bad('Choose a timezone for the send window, for example Asia/Kolkata.');
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
  } catch {
    throw bad(`"${name}" is not a known timezone. Use a name like Asia/Kolkata or Europe/London.`);
  }
  return name;
}

function readDays(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const days = list.map((d) => (typeof d === 'string' ? d.trim() : d)).filter((d) => d !== '').map(Number);
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('Days must be numbers from 0 (Sunday) to 6 (Saturday).');
  const unique = [...new Set(days)].sort((a, b) => a - b);
  return unique.length === 7 ? [] : unique; // all seven days is the same as no restriction
}

/** Validate a send window. Throws a 400 with a plain message. */
export function parseWindow({ start, end, timezone, days }) {
  const w = {
    start: parseClock(start, 'The window start'),
    end: parseClock(end, 'The window end'),
    timezone: validTimeZone(timezone),
    days: readDays(days),
  };
  if (w.start === w.end) throw bad('The send window must start and end at different times.');
  return w;
}

/**
 * Read the scheduling fields of a request: startAt, windowStart, windowEnd, timezone, windowDays, removeWindow.
 * Returns { startAt, sendWindow } where a field that was not sent is `undefined` (keep as it is),
 * `startAt: null` means "start right away" and `sendWindow: null` means "no window".
 */
export function readSchedule(body, { now = Date.now(), maxDays = 30 } = {}) {
  const b = body || {};
  const out = {};

  if ('startAt' in b) {
    if (b.startAt === null || b.startAt === '') {
      out.startAt = null;
    } else {
      const raw = String(b.startAt).trim();
      if (!ISO_WITH_ZONE.test(raw) || Number.isNaN(Date.parse(raw))) {
        throw bad('The start time must look like 2026-11-02T09:30:00+05:30 (date, time and timezone offset).');
      }
      const ms = Date.parse(raw);
      if (ms < now - MINUTE_MS) throw bad('That start time has already passed.');
      if (ms > now + maxDays * DAY_MINUTES * MINUTE_MS) throw bad(`A campaign can be scheduled at most ${maxDays} days ahead.`);
      out.startAt = ms <= now + 5_000 ? null : new Date(ms); // "now" and "a moment ago" simply start right away
    }
  }

  const hasWindowField = ['windowStart', 'windowEnd', 'timezone', 'windowDays'].some((k) => b[k] !== undefined && b[k] !== '');
  const remove = b.removeWindow === true || b.removeWindow === 'true';
  if (remove && hasWindowField) throw bad('Either set a send window or remove it, not both.');
  if (remove) {
    out.sendWindow = null;
  } else if (hasWindowField) {
    if (!b.windowStart || !b.windowEnd) throw bad('A send window needs both a start and an end time.');
    out.sendWindow = parseWindow({ start: b.windowStart, end: b.windowEnd, timezone: b.timezone, days: b.windowDays });
  }
  return out;
}

/** A campaign's stored window as a plain object (works for Mongoose documents and lean results), or null. */
export function windowOf(campaign) {
  const w = campaign?.sendWindow;
  if (!w || w.start === undefined || w.start === null) return null;
  return { start: w.start, end: w.end, timezone: w.timezone, days: Array.from(w.days || []) };
}
