/**
 * Reading "this address bounced / complained / unsubscribed" notices that email providers send to a webhook.
 * No database here, so it can be unit tested. Supported without any setting (the format is recognised):
 *   Amazon SES through SNS, SendGrid, Mailgun, Postmark, Resend, and a simple custom format:
 *     { "type": "bounce" | "complaint" | "unsubscribe", "email": "a@b.com", "reason": "optional" }
 *     or { "events": [ ...the same... ] }
 * Only permanent problems count: a full mailbox or a temporary block must not stop us emailing someone.
 */

export const MAX_EVENTS = 1000;

/** Amazon only: SNS asks us to open this link once to confirm the subscription, so it must never point anywhere else. */
export function isSnsUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' && !u.port && !u.username && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname);
  } catch {
    return false;
  }
}

const text = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v : []);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Returns { events: [{ email, kind: 'bounced' | 'complaint' | 'unsubscribed', detail }], snsConfirmUrl }. */
export function parseFeedback(body) {
  const out = { events: [], snsConfirmUrl: null };
  const add = (email, kind, detail = '') => {
    if (typeof email === 'string' && email.trim() && out.events.length < MAX_EVENTS) out.events.push({ email: email.trim(), kind, detail: String(detail || '').slice(0, 300) });
  };

  const ses = (n) => {
    const type = text(n.notificationType) || text(n.eventType);
    if (type === 'Bounce' && n.bounce?.bounceType === 'Permanent') {
      for (const r of list(n.bounce.bouncedRecipients)) add(r?.emailAddress, 'bounced', r?.diagnosticCode || n.bounce.bounceSubType);
    } else if (type === 'Complaint') {
      for (const r of list(n.complaint?.complainedRecipients)) add(r?.emailAddress, 'complaint', n.complaint.complaintFeedbackType);
    }
  };

  const sendgrid = (e) => {
    const reason = text(e.reason) || text(e.response);
    switch (e.event) {
      case 'bounce':
        if (e.type !== 'blocked') add(e.email, 'bounced', reason); // "blocked" is a temporary refusal
        break;
      case 'spamreport':
        add(e.email, 'complaint', 'spam report');
        break;
      case 'unsubscribe':
      case 'group_unsubscribe':
        add(e.email, 'unsubscribed');
        break;
      case 'dropped': // SendGrid refused to send because of something it already knew
        if (/bounced address/i.test(reason)) add(e.email, 'bounced', reason);
        else if (/spam report/i.test(reason)) add(e.email, 'complaint', reason);
        else if (/unsubscribed address/i.test(reason)) add(e.email, 'unsubscribed', reason);
        break;
      default:
    }
  };

  const mailgun = (d) => {
    const reason = text(d['delivery-status']?.description) || text(d['delivery-status']?.message);
    if (d.event === 'failed' && d.severity === 'permanent') add(d.recipient, 'bounced', reason);
    else if (d.event === 'complained') add(d.recipient, 'complaint', 'spam complaint');
    else if (d.event === 'unsubscribed') add(d.recipient, 'unsubscribed');
  };

  const postmark = (e) => {
    if (e.RecordType === 'SpamComplaint') add(e.Email, 'complaint', e.Description || e.Type);
    else if (e.RecordType === 'Bounce' && ['HardBounce', 'BadEmailAddress', 'SpamNotification', 'ManuallyDeactivated'].includes(e.Type)) {
      add(e.Email, e.Type === 'SpamNotification' ? 'complaint' : 'bounced', e.Description || e.Type);
    }
  };

  const resend = (e) => {
    const to = list(e.data?.to);
    if (e.type === 'email.complained') for (const a of to) add(a, 'complaint', 'spam complaint');
    else if (e.type === 'email.bounced' && e.data?.bounce?.type === 'Permanent') for (const a of to) add(a, 'bounced', e.data.bounce.message);
  };

  const custom = (e) => {
    const kind = { bounce: 'bounced', bounced: 'bounced', complaint: 'complaint', complained: 'complaint', unsubscribe: 'unsubscribed', unsubscribed: 'unsubscribed' }[text(e.type).toLowerCase()];
    if (kind) add(e.email, kind, e.reason);
  };

  const handle = (item, depth = 0) => {
    if (!isObject(item) || depth > 3) return;
    if (item.Type === 'SubscriptionConfirmation') {
      if (isSnsUrl(item.SubscribeURL)) out.snsConfirmUrl = item.SubscribeURL;
      return;
    }
    if (item.Type === 'Notification' && typeof item.Message === 'string') {
      try {
        handle(JSON.parse(item.Message), depth + 1);
      } catch {
        /* not a notice we understand */
      }
      return;
    }
    if (item.notificationType || item.eventType) return ses(item);
    if (isObject(item['event-data'])) return mailgun(item['event-data']);
    if (item.RecordType) return postmark(item);
    if (text(item.type).startsWith('email.') && isObject(item.data)) return resend(item);
    if (typeof item.event === 'string' && item.email) return sendgrid(item);
    if (Array.isArray(item.events)) return item.events.forEach((e) => handle(e, depth + 1));
    custom(item);
  };

  if (Array.isArray(body)) body.slice(0, MAX_EVENTS * 2).forEach((item) => handle(item));
  else handle(body);

  // the same address twice in one notice is one event; a complaint outranks the rest
  const rank = { complaint: 3, bounced: 2, unsubscribed: 1 };
  const best = new Map();
  for (const e of out.events) {
    const key = e.email.toLowerCase();
    if (!best.has(key) || rank[e.kind] > rank[best.get(key).kind]) best.set(key, e);
  }
  out.events = [...best.values()];
  return out;
}
