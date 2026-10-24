export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
};

export const emptySchedule = () => ({ later: false, startAt: '', useWindow: false, windowStart: '09:00', windowEnd: '18:00', days: [], timezone: browserZone() });

/** The schedule of an existing campaign, in the shape the form uses. */
export function scheduleFromCampaign(c) {
  const w = c.sendWindow;
  const future = c.startAt && new Date(c.startAt).getTime() > Date.now();
  return {
    ...emptySchedule(),
    later: Boolean(future),
    startAt: future ? toLocalInput(new Date(c.startAt)) : '',
    useWindow: Boolean(w),
    ...(w ? { windowStart: w.start, windowEnd: w.end, days: w.days || [], timezone: w.timezone } : {}),
  };
}

/** A Date as the text a datetime-local box wants (the computer's own clock). */
export function toLocalInput(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** Why this schedule cannot be sent, or '' when it is fine. */
export function scheduleProblem(s, { allowStart = true } = {}) {
  if (allowStart && s.later) {
    if (!s.startAt) return 'Choose the date and time to start.';
    if (new Date(s.startAt).getTime() < Date.now() - 60_000) return 'That start time has already passed.';
  }
  if (s.useWindow) {
    if (!s.windowStart || !s.windowEnd) return 'Choose when the daily sending hours start and end.';
    if (s.windowStart === s.windowEnd) return 'The sending hours must start and end at different times.';
  }
  return '';
}

/**
 * The fields the server reads. `sendStart` false leaves the start time alone (a campaign that already began).
 * `hadWindow` true means a window exists now, so turning it off must say so.
 */
export function scheduleFields(s, { sendStart = true, hadWindow = false } = {}) {
  const out = {};
  if (sendStart) out.startAt = s.later && s.startAt ? new Date(s.startAt).toISOString() : null;
  if (s.useWindow) {
    out.windowStart = s.windowStart;
    out.windowEnd = s.windowEnd;
    out.timezone = s.timezone;
    if (s.days.length) out.windowDays = s.days.join(',');
  } else if (hadWindow) {
    out.removeWindow = true;
  }
  return out;
}
