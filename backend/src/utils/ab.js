import { randomInt } from 'node:crypto';
import { bad } from './http.js';

/** Read the A/B fields of an email campaign: a second subject line and the share of people who get it. */
export function readAb(body, subject) {
  const raw = typeof body.subjectB === 'string' ? body.subjectB.trim() : '';
  if (!raw) return { subjectB: '', splitB: 50 };
  if (raw.length > 200) throw bad('The second subject is too long (max 200 characters)');
  if (raw.toLowerCase() === subject.toLowerCase()) throw bad('The two subject lines are the same. Write a different second subject, or turn the test off.');
  let split = 50;
  if (body.splitB !== undefined && body.splitB !== '') {
    split = Number(body.splitB);
    if (!Number.isInteger(split) || split < 1 || split > 99) throw bad('The share for the second subject must be a whole number from 1 to 99');
  }
  return { subjectB: raw, splitB: split };
}

/**
 * Which subject each person gets: a list of 'A' / 'B' of the right length, in random order.
 * Exactly round(count * splitB / 100) people get B, so the groups are the size asked for and nobody's group
 * depends on their place in the file. With two or more people both groups always have at least one person.
 */
export function assignVariants(count, splitB, pick = (n) => randomInt(n)) {
  let b = Math.round((count * splitB) / 100);
  if (count >= 2) b = Math.min(count - 1, Math.max(1, b));
  else b = 0;
  const list = Array.from({ length: count }, (_, i) => (i < b ? 'B' : 'A'));
  for (let i = list.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
