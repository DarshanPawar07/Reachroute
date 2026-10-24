import { nextOpen } from './window.js';

/**
 * Pure scheduling math (no database), so it can be unit tested.
 *
 * Returns `count` send times (ms since epoch). The first send happens a couple of seconds from `now`,
 * or after the user's already-scheduled messages (`latestMs`), whichever is later, so two campaigns from
 * the same account never send at the same time. Each later send is `gap()` ms after the previous one.
 *
 * `notBeforeMs` is a scheduled start time: nothing is planned earlier. `window` (see window.js) keeps every
 * time inside the allowed hours: a time that falls outside moves to the next opening, and the sends after it
 * continue from there.
 */
export function planTimes({ now, latestMs = 0, count, gap, jitterMs = 2000, notBeforeMs = 0, window = null }) {
  let t = Math.max(now + jitterMs, latestMs > 0 ? latestMs + gap() : 0, notBeforeMs);
  if (window) t = nextOpen(t, window);
  const times = [];
  for (let i = 0; i < count; i++) {
    times.push(t);
    t += gap();
    if (window) t = nextOpen(t, window);
  }
  return times;
}

/**
 * "At most `cap` messages in any rolling window" rule. `sentAtDesc` holds the send times (ms) of the messages
 * that count, newest first. Returns 0 when a message may go out right now, otherwise the moment (ms) the first
 * slot frees up, which is when the message that is blocking leaves the window.
 */
export function nextSlotAt({ sentAtDesc, cap, now, windowMs = 60 * 60 * 1000 }) {
  const inWindow = sentAtDesc.filter((t) => t > now - windowMs);
  if (inWindow.length < cap) return 0;
  return inWindow[cap - 1] + windowMs;
}
