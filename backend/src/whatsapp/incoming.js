import { createHash } from 'node:crypto';

// Reading what a contact sent (no database, so it can be unit tested).

const MAX_TEXT = 1000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MEDIA_KINDS = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  contactMessage: 'contact',
  contactsArrayMessage: 'contact',
  locationMessage: 'location',
};
const IGNORED = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);
const SYSTEM = ['protocolMessage', 'reactionMessage', 'pollUpdateMessage', 'keepInChatMessage', 'encReactionMessage'];

const clean = (value, max) => String(value ?? '').replace(CONTROL, '').trim().slice(0, max);

/** Messages can be wrapped (disappearing chats, view once). Look inside. */
function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

function secondsOf(ts) {
  if (ts && typeof ts === 'object' && typeof ts.toNumber === 'function') return ts.toNumber();
  return Number(ts);
}

/**
 * Turn a Baileys message into { phone, text, kind, messageId, pushName, receivedAt }, or null when it is not a
 * one-to-one message from a contact (our own messages, groups, broadcasts, reactions, read receipts and so on).
 */
export function extractIncoming(m) {
  if (!m?.key || m.key.fromMe) return null;
  // Newer WhatsApp versions sometimes identify chats by an opaque id; the phone-number form may be in the "Alt" field.
  const jid = [m.key.remoteJidAlt, m.key.remoteJid].find((j) => j && j.endsWith('@s.whatsapp.net'));
  const phone = (jid || '').split('@')[0].split(':')[0];
  if (!/^\d{6,15}$/.test(phone)) return null;

  const msg = unwrap(m.message);
  if (!msg || typeof msg !== 'object') return null;
  const keys = Object.keys(msg).filter((k) => !IGNORED.has(k));
  if (!keys.length || keys.some((k) => SYSTEM.includes(k))) return null;

  let text = msg.conversation || msg.extendedTextMessage?.text || msg.buttonsResponseMessage?.selectedDisplayText
    || msg.listResponseMessage?.title || msg.templateButtonReplyMessage?.selectedDisplayText || '';
  let kind = 'text';
  if (!text) {
    const media = keys.find((k) => MEDIA_KINDS[k]);
    kind = media ? MEDIA_KINDS[media] : 'other';
    text = media ? msg[media]?.caption || '' : '';
  }
  text = clean(text, MAX_TEXT);
  if (kind === 'text' && !text) return null; // an empty text message carries nothing

  const seconds = secondsOf(m.messageTimestamp);
  const now = Date.now();
  const stamp = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : now;
  const receivedAt = new Date(stamp > now + 5 * 60_000 ? now : stamp);

  const messageId = clean(m.key.id, 100) || createHash('sha1').update(`${phone}|${receivedAt.getTime()}|${kind}|${text}`).digest('hex');
  return { phone, text, kind, messageId, pushName: clean(m.pushName, 100), receivedAt };
}
