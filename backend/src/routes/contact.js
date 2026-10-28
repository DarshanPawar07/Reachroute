import { Router } from 'express';
import { config } from '../config.js';
import { CONTACT_TOPICS, ContactMessage } from '../models.js';
import { normalizeEmail } from '../utils/contacts.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { sendSystemEmail } from '../utils/systemMail.js';

const log = logger.child({ mod: 'contact' });
const text = (v, field, max, min = 1) => {
  if (typeof v !== 'string') throw bad(`Please fill in your ${field}`);
  const t = v.replace(/\r\n/g, '\n').trim();
  if (t.length < min) throw bad(min > 1 ? `Your ${field} is too short` : `Please fill in your ${field}`);
  if (t.length > max) throw bad(`Your ${field} is too long (up to ${max} characters)`);
  return t;
};

/**
 * Public (no login): the form on the Contact page. The message is saved for the admin area, and also emailed to
 * LEGAL_CONTACT_EMAIL when that and the platform SMTP are set. A hidden field catches simple bots: they get a normal
 * "sent" answer and nothing is saved. The route is rate limited per IP (see middleware/limits.js).
 */
export function contactRouter() {
  const router = Router();

  router.post('/', async (req, res) => {
    const body = req.body || {};
    if (typeof body.website === 'string' && body.website.trim()) return res.json({ ok: true }); // the trap field

    const name = text(body.name, 'name', 100);
    const email = normalizeEmail(body.email);
    if (!email) throw bad('Please enter a valid email address so we can reply');
    const message = text(body.message, 'message', 4000, 10);
    const topic = CONTACT_TOPICS.includes(body.topic) ? body.topic : 'other';
    const plan = topic === 'plans' && typeof body.plan === 'string' && /^[a-z]{1,20}$/.test(body.plan) ? body.plan : '';

    const saved = await ContactMessage.create({ name, email, topic, plan, message, ip: req.ip || '' });

    if (config.legalContactEmail) {
      try {
        await sendSystemEmail({
          to: config.legalContactEmail,
          subject: `Reachroute contact: ${topic}${plan ? ` (${plan})` : ''}`,
          text: `From: ${name} <${email}>\nTopic: ${topic}${plan ? `, plan ${plan}` : ''}\n\n${message}\n\nReply to ${email}. Also saved in Admin > Messages.`,
        });
      } catch (err) {
        log.warn({ err: err.message }, 'could not email a contact message (it is saved in the admin area)');
      }
    }
    res.status(201).json({ ok: true, id: saved._id });
  });

  return router;
}
