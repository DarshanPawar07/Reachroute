import { EmailRecipient, SmtpSettings } from '../models.js';
import { parseBounce } from './bounceParse.js';
import { applyFeedback } from './suppression.js';

/**
 * Handle one received mail that may be a "could not be delivered" notice.
 * Only addresses this account really emailed in a campaign are acted on: a bounce naming anyone else is ignored,
 * so a forged notice cannot stop mail to people the account never wrote to.
 * Returns { isBounce, stopped, ignored }:
 *   isBounce  the mail was a bounce notice (so it is not a reply from a person)
 *   stopped   addresses newly put on the do-not-email list
 *   ignored   failures that did not count (full mailbox, spam block, unknown recipient, ...)
 */
export async function ingestBounce(userId, msg) {
  const own = await SmtpSettings.findOne({ userId }).select('fromEmail').lean();
  const parsed = parseBounce(msg, { ownEmail: own?.fromEmail });
  if (!parsed.isBounce) return { isBounce: false, stopped: 0, ignored: 0 };

  let hard = [];
  if (parsed.hard.length) {
    const emailed = new Set(
      (await EmailRecipient.find({ userId, email: { $in: parsed.hard.map((h) => h.email) }, status: 'sent' }).select('email').lean()).map((r) => r.email)
    );
    hard = parsed.hard.filter((h) => emailed.has(h.email));
  }
  let stopped = 0;
  if (hard.length) {
    const res = await applyFeedback(userId, hard.map((h) => ({ email: h.email, kind: 'bounced', detail: h.detail || 'bounce notice read from your mailbox' })));
    stopped = res.newlyStopped.bounced;
  }
  return { isBounce: true, stopped, ignored: parsed.ignored.length + (parsed.hard.length - hard.length) };
}
