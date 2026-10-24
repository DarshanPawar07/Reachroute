import { Router } from 'express';
import { isSnsUrl, parseFeedback } from '../email/feedback.js';
import { applyFeedback, userIdForKey } from '../email/suppression.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ mod: 'hooks' });
const router = Router();

/** Amazon SNS wants this address opened once to confirm the subscription. Only genuine Amazon addresses are ever opened. */
async function confirmSubscription(url) {
  if (!isSnsUrl(url)) return false;
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch (err) {
    log.warn({ err: err.message }, 'could not confirm an SNS subscription');
    return false;
  }
}

/**
 * POST /hooks/email/:key  (public, no login: the secret in the address says which account it is for)
 * Bounce, spam-complaint and unsubscribe notices from Amazon SES (SNS), SendGrid, Mailgun, Postmark, Resend or a custom sender.
 * Always answers 200 for a valid address, so providers do not keep retrying notices we cannot use.
 */
router.post('/:key', async (req, res) => {
  const userId = await userIdForKey(req.params.key);
  if (!userId) throw bad('Not found', 404);

  const { events, snsConfirmUrl } = parseFeedback(req.body);
  const confirmed = snsConfirmUrl ? await confirmSubscription(snsConfirmUrl) : false;
  const result = events.length ? await applyFeedback(userId, events) : { received: 0, valid: 0, newlyStopped: { bounced: 0, complaint: 0, unsubscribed: 0 } };
  res.json({ ok: true, received: events.length, stopped: result.valid, ...(snsConfirmUrl ? { subscriptionConfirmed: confirmed } : {}) });
});

export default router;
