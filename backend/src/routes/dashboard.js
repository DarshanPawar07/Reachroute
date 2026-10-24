import { Router } from 'express';
import { config } from '../config.js';
import { emailEngine, whatsappEngine } from '../engine/channels.js';
import { Campaign, EmailCampaign, EmailRecipient, Recipient, SmtpSettings } from '../models.js';
import { resolveLimits } from '../plans/limits.js';
import { getStatus } from '../whatsapp/sessionManager.js';

const router = Router();
const DAY = 24 * 60 * 60 * 1000;

const sentSince = (Model, userId, since) => Model.countDocuments({ userId, status: 'sent', sentAt: { $gte: since } }).maxTimeMS(5000);

const recentOf = (Model, userId, kind) =>
  Model.find({ userId, status: { $ne: 'preparing' } })
    .sort({ createdAt: -1 })
    .limit(5)
    .select('name status total sentCount failedCount createdAt pauseReason startAt')
    .lean()
    .then((rows) => rows.map((c) => ({ ...c, kind })));

// One call for the dashboard: connection state, usage in the last 24h, and recent campaigns of both kinds.
router.get('/', async (req, res) => {
  const since = new Date(Date.now() - DAY);
  const userId = req.userId;
  const { plan, limits: own } = await resolveLimits(userId);

  const [wa, waSent, emailSent, waRemaining, emailRemaining, smtp, waRecent, emailRecent] = await Promise.all([
    getStatus(userId),
    sentSince(Recipient, userId, since),
    sentSince(EmailRecipient, userId, since),
    whatsappEngine.remainingToday(userId),
    emailEngine.remainingToday(userId),
    SmtpSettings.exists({ userId }),
    recentOf(Campaign, userId, 'whatsapp'),
    recentOf(EmailCampaign, userId, 'email'),
  ]);

  const recent = [...waRecent, ...emailRecent]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8)
    .map(({ _id, kind, name, status, total, sentCount, failedCount, createdAt, pauseReason, startAt }) => ({
      id: _id, kind, name, status, total, sentCount, failedCount, createdAt, pauseReason, startAt,
    }));

  res.json({
    plan,
    whatsapp: {
      status: wa.status,
      sentLast24h: waSent,
      dailyCap: own.waDailyCap,
      remainingToday: waRemaining,
    },
    email: {
      configured: Boolean(smtp) || Boolean(config.platformSmtp),
      sentLast24h: emailSent,
      dailyCap: own.emailDailyCap,
      remainingToday: emailRemaining,
    },
    recent,
  });
});

export default router;
