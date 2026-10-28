import { config } from '../config.js';
import { getSender } from '../email/mailer.js';
import { Notification, User } from '../models.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'notify' });
const DEDUPE_MS = 2 * 60_000; // the same alert is not repeated within 2 minutes
const EMAIL_GAP_MS = 30 * 60_000; // at most one email per alert type every 30 minutes (never flood an inbox)
const frontendUrl = () => (config.corsOrigins[0] || '').replace(/\/$/, '');

/** Email the account owner about an alert. Quietly does nothing if no SMTP is available. */
async function emailOwner(userId, alert) {
  const recent = await Notification.exists({
    userId,
    type: alert.type,
    emailed: true,
    createdAt: { $gte: new Date(Date.now() - EMAIL_GAP_MS) },
  });
  if (recent) return;

  const [user, sender] = await Promise.all([User.findById(userId).select('email').lean(), getSender(userId, { allowUnverified: true })]); // an alert goes to the owner's own address, so the "from" check does not apply
  if (!user || !sender) return;

  const link = alert.link ? `\n\nOpen it here: ${frontendUrl()}${alert.link}` : '';
  await sender.transport.sendMail({
    from: sender.from,
    to: user.email,
    subject: `[Reachroute] ${alert.title}`,
    text: `${alert.message}${link}\n\nYou get this email because alerts are switched on for this app.`,
  });
  await Notification.updateOne({ _id: alert._id }, { $set: { emailed: true } });
}

/**
 * Save an alert for a user (shown in the app) and, when `email` is true, email it to the account owner too.
 * Never throws: a failing alert must not break whatever triggered it.
 */
export async function notify(userId, { type, level = 'info', title, message = '', link = '', dedupeKey = null, email = false }) {
  try {
    if (dedupeKey) {
      const duplicate = await Notification.exists({ userId, dedupeKey, createdAt: { $gte: new Date(Date.now() - DEDUPE_MS) } });
      if (duplicate) return null;
    }
    const alert = await Notification.create({
      userId,
      type,
      level,
      title: String(title).slice(0, 200),
      message: String(message).slice(0, 1000),
      link,
      dedupeKey,
    });
    if (email && config.alertEmails) {
      emailOwner(userId, alert).catch((err) => log.warn({ err: err.message, userId: String(userId) }, 'could not email alert'));
    }
    return alert;
  } catch (err) {
    log.error({ err: err.message, userId: String(userId), type }, 'could not save alert');
    return null;
  }
}
