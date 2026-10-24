import { Router } from 'express';
import { markRecipientFeedback } from '../email/suppression.js';
import { EmailOptOut, EmailRecipient } from '../models.js';
import { verifyUnsubscribe } from '../utils/unsubscribeToken.js';

// Public routes (no login). Linked from every email footer and from the List-Unsubscribe header.
const router = Router();

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const page = (title, inner) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f5f5f4;margin:0;display:grid;place-items:center;min-height:100vh;color:#1c1917}
  main{background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:32px;max-width:420px;width:calc(100% - 32px);text-align:center}
  button{background:#1c1917;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}
</style></head><body><main>${inner}</main></body></html>`;

const INVALID = page('Invalid link', '<h1>Invalid link</h1><p>This unsubscribe link is not valid. If you keep getting emails you do not want, reply to one of them and ask to be removed.</p>');

function send(res, status, html) {
  res.status(status).set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).send(html);
}

/** Works out whose address the link is for. Current links carry it; legacy links need the recipient row. */
async function resolve(token) {
  const v = verifyUnsubscribe(token);
  if (!v) return null;
  if (v.email) return { userId: v.userId, email: v.email };
  const r = await EmailRecipient.findById(v.recipientId).select('userId email').lean();
  return r ? { userId: String(r.userId), email: r.email } : null;
}

// GET only shows a confirm button. Mail scanners often open links automatically, so a GET must not unsubscribe anyone.
router.get('/:token', async (req, res) => {
  const who = await resolve(req.params.token);
  if (!who) return send(res, 400, INVALID);
  send(
    res,
    200,
    page(
      'Unsubscribe',
      `<h1>Unsubscribe</h1><p>Stop sending emails to <strong>${escapeHtml(who.email)}</strong>?</p>` +
        `<form method="post"><button type="submit">Yes, unsubscribe me</button></form>`
    )
  );
});

// POST does the unsubscribe. Also used by mail apps for one-click unsubscribe (RFC 8058).
router.post('/:token', async (req, res) => {
  const who = await resolve(req.params.token);
  if (!who) return send(res, 400, INVALID);
  try {
    await EmailOptOut.updateOne(
      { userId: who.userId, email: who.email },
      { $setOnInsert: { userId: who.userId, email: who.email, reason: 'unsubscribed' } },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) throw err; // two clicks at once: the address is already on the list
  }
  await markRecipientFeedback(who.userId, who.email, 'unsubscribed').catch(() => {}); // shows in the campaign results
  send(res, 200, page('Unsubscribed', `<h1>You're unsubscribed</h1><p><strong>${escapeHtml(who.email)}</strong> will not receive more emails from this sender.</p>`));
});

export default router;
