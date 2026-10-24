import { Router } from 'express';
import mongoose from 'mongoose';
import { resolveLimits } from '../plans/limits.js';
import { emailEngine, whatsappEngine } from '../engine/channels.js';
import { Campaign, EmailCampaign, EmailOptOut, EmailRecipient, OptOut, Recipient } from '../models.js';

const router = Router();
const DAY = 24 * 60 * 60 * 1000;

function safeTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return String(value);
  } catch {
    return 'UTC';
  }
}

/** The last `days` calendar days (oldest first) as YYYY-MM-DD in the given time zone. */
function dayKeys(days, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = fmt.format(new Date(Date.now() - i * DAY));
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

async function channelStats({ Campaign: Camps, Recipient: Recips, engine, dailyCap }, userId, since, keys, timeZone) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const [rows, campaigns, failures, remaining] = await Promise.all([
    Recips.aggregate([
      { $match: { userId: uid, status: { $in: ['sent', 'failed', 'skipped'] }, updatedAt: { $gte: since } } },
      {
        $group: {
          _id: { day: { $dateToString: { format: '%Y-%m-%d', date: { $ifNull: ['$sentAt', '$updatedAt'] }, timezone: timeZone } }, status: '$status' },
          n: { $sum: 1 },
        },
      },
    ]).option({ maxTimeMS: 8000 }),
    Camps.aggregate([{ $match: { userId: uid, createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).option({ maxTimeMS: 8000 }),
    Recips.aggregate([
      { $match: { userId: uid, status: 'failed', updatedAt: { $gte: since }, error: { $ne: null } } },
      { $group: { _id: '$error', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 5 },
    ]).option({ maxTimeMS: 8000 }),
    engine.remainingToday(userId),
  ]);

  const daily = keys.map((date) => ({ date, sent: 0, failed: 0, skipped: 0 }));
  const byDate = new Map(daily.map((d) => [d.date, d]));
  for (const r of rows) {
    const day = byDate.get(r._id.day);
    if (day) day[r._id.status] += r.n;
  }
  const totals = daily.reduce((t, d) => ({ sent: t.sent + d.sent, failed: t.failed + d.failed, skipped: t.skipped + d.skipped }), { sent: 0, failed: 0, skipped: 0 });
  const attempted = totals.sent + totals.failed;
  const byStatus = Object.fromEntries(campaigns.map((c) => [c._id, c.n]));

  return {
    ...totals,
    successRate: attempted ? Math.round((totals.sent / attempted) * 1000) / 10 : null, // % of attempted that went out; null when nothing was attempted
    campaigns: { total: campaigns.reduce((n, c) => n + c.n, 0), ...byStatus },
    topFailures: failures.map((f) => ({ reason: f._id, count: f.n })),
    dailyCap,
    remainingToday: remaining,
    daily,
  };
}

// GET /api/stats?days=30&tz=Asia/Kolkata
router.get('/', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
  const timeZone = safeTimeZone(req.query.tz || 'UTC');
  const keys = dayKeys(days, timeZone);
  const since = new Date(Date.now() - days * DAY);
  const uid = new mongoose.Types.ObjectId(String(req.userId));
  const { limits: own } = await resolveLimits(req.userId);

  const [whatsapp, email, waOptOuts, emailOptOuts] = await Promise.all([
    channelStats({ Campaign, Recipient, engine: whatsappEngine, dailyCap: own.waDailyCap }, req.userId, since, keys, timeZone),
    channelStats({ Campaign: EmailCampaign, Recipient: EmailRecipient, engine: emailEngine, dailyCap: own.emailDailyCap }, req.userId, since, keys, timeZone),
    OptOut.countDocuments({ userId: uid }).maxTimeMS(5000),
    EmailOptOut.aggregate([{ $match: { userId: uid } }, { $group: { _id: '$reason', n: { $sum: 1 } } }]).option({ maxTimeMS: 5000 }),
  ]);
  const emailBy = Object.fromEntries(emailOptOuts.map((o) => [o._id, o.n]));

  res.json({
    days,
    timeZone,
    since,
    whatsapp,
    email,
    optOuts: { whatsappStopped: waOptOuts, emailUnsubscribed: emailBy.unsubscribed || 0, emailBounced: emailBy.bounced || 0, emailComplaints: emailBy.complaint || 0 },
  });
});

export default router;
