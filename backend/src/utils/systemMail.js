import { config } from '../config.js';
import { buildTransport } from '../email/mailer.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'systemMail' });

/** Emails the app itself sends (password reset, verification). They go through the platform SMTP (SMTP_HOST). */
let transport = null;
const getTransport = () => {
  if (!transport) {
    const { host, port, secure, user, pass } = config.platformSmtp;
    transport = buildTransport({ host, port, secure, user, pass });
  }
  return transport;
};

/** The last few emails that could not be sent because no SMTP is configured. Used by tests and local development. */
export const outbox = [];

/**
 * Send one plain-text email.
 * Returns { sent: true } when it went to the SMTP server. With no platform SMTP it returns { sent: false }:
 * in development the message (with its link) is printed to the backend terminal so you can still click it.
 * Throws if the SMTP server refuses the message.
 */
export async function sendSystemEmail({ to, subject, text }) {
  const smtp = config.platformSmtp;
  if (!smtp) {
    outbox.push({ to, subject, text, at: Date.now() });
    if (outbox.length > 20) outbox.shift();
    if (config.isProd) log.warn({ subject }, 'no platform SMTP configured (SMTP_HOST): email not sent');
    else log.info(`\n---- email (not sent: SMTP_HOST is not set) ----\nTo: ${to}\nSubject: ${subject}\n\n${text}\n------------------------------------------------\n`);
    return { sent: false };
  }
  await getTransport().sendMail({ from: { name: 'Bulk Messenger', address: smtp.fromEmail }, to, subject, text });
  return { sent: true };
}