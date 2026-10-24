import { Router } from 'express';
import mongoose from 'mongoose';
import { fromReq, record } from '../audit/audit.js';
import { createWebhookKey, currentWebhookUrl, removeWebhookKey } from '../email/suppression.js';
import { EmailOptOut } from '../models.js';
import { bad, validId } from '../utils/http.js';

const REASONS = ['unsubscribed', 'bounced', 'complaint'];

/**
 * Email feedback: the webhook address that providers send bounces and spam complaints to, and the list of
 * addresses that will never be emailed again. `limiters.settingsWrite` (optional) throttles changes.
 */
export function feedbackRouter({ settingsWrite } = {}) {
  const router = Router();
  router.param('id', validId);
  const use = settingsWrite ? [settingsWrite] : [];

  // The webhook address (null until one is created), counts by reason, and the latest bounces and complaints.
  router.get('/', async (req, res) => {
    const [webhookUrl, rows, recent] = await Promise.all([
      currentWebhookUrl(req.userId),
      EmailOptOut.aggregate([{ $match: { userId: new mongoose.Types.ObjectId(String(req.userId)) } }, { $group: { _id: '$reason', n: { $sum: 1 } } }]),
      EmailOptOut.find({ userId: req.userId, reason: { $in: ['bounced', 'complaint'] } }).sort({ createdAt: -1 }).limit(10).select('email reason detail createdAt').lean(),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
    res.json({
      webhookUrl,
      providers: ['Amazon SES (through SNS)', 'SendGrid', 'Mailgun', 'Postmark', 'Resend', 'Custom: POST { "type": "bounce" | "complaint" | "unsubscribe", "email": "name@example.com" }'],
      counts: { unsubscribed: by.unsubscribed || 0, bounced: by.bounced || 0, complaint: by.complaint || 0 },
      recent,
    });
  });

  // Create the webhook address, or replace it with a new one (the old address stops working).
  router.post('/key', ...use, async (req, res) => {
    const webhookUrl = await createWebhookKey(req.userId);
    await record({ ...fromReq(req), action: 'webhook_key.created', detail: 'a new bounce/complaint webhook address; any older one stopped working' });
    res.status(201).json({ webhookUrl });
  });

  router.delete('/key', ...use, async (req, res) => {
    await removeWebhookKey(req.userId);
    await record({ ...fromReq(req), action: 'webhook_key.removed' });
    res.json({ webhookUrl: null });
  });

  // Everyone who will not be emailed again. ?reason=bounced|complaint|unsubscribed, ?limit=1..100, ?before=<ISO time>
  router.get('/suppressed', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const query = { userId: req.userId };
    if (req.query.reason) {
      if (!REASONS.includes(req.query.reason)) throw bad(`reason must be one of: ${REASONS.join(', ')}`);
      query.reason = req.query.reason;
    }
    if (req.query.before) {
      const before = new Date(String(req.query.before));
      if (Number.isNaN(before.getTime())) throw bad('"before" must be a date and time');
      query.createdAt = { $lt: before };
    }
    const rows = await EmailOptOut.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).select('email reason detail createdAt').lean();
    const addresses = rows.slice(0, limit);
    res.json({ addresses, nextBefore: rows.length > limit ? addresses.at(-1).createdAt : null });
  });

  // Allow emailing an address again. Only for bounces (a mailbox can come back to life): people who unsubscribed
  // or reported spam asked not to be emailed, and that cannot be undone from here.
  router.delete('/suppressed/:id', async (req, res) => {
    const row = await EmailOptOut.findOne({ _id: req.params.id, userId: req.userId }).select('reason').lean();
    if (!row) throw bad('Address not found', 404);
    if (row.reason !== 'bounced') throw bad('People who unsubscribed or reported spam asked not to be emailed. They cannot be added back.', 409);
    await EmailOptOut.deleteOne({ _id: row._id });
    res.json({ ok: true });
  });

  return router;
}
