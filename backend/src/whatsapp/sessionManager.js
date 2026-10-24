import { EventEmitter } from 'node:events';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { OptOut, SessionLease } from '../models.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { rand } from '../utils/template.js';
import { clearAuthState, useMongoAuthState, usersWithSavedLogin } from './authState.js';
import { extractIncoming } from './incoming.js';
import { buildContents } from './media.js';
import { recordReply } from './replies.js';
import { restrictedUserIds, restrictionEvents } from './restriction.js';

const log = logger.child({ mod: 'whatsapp' });
const baileysLog = logger.child({ mod: 'baileys' }, { level: 'warn' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Emits 'ended' { userId, reason, pause?, byUser? } whenever a user's WhatsApp session stops (logout, lost, replaced). byUser = they pressed Disconnect themselves. */
export const sessionEvents = new EventEmitter();

/**
 * Sessions THIS instance owns, by userId:
 *   { sock, status: 'connecting' | 'qr' | 'connected' | 'closed', qr, retries, stopped, phone }
 * A lease document in MongoDB says which instance owns a user's session, so only one process ever
 * holds a given WhatsApp login (two at once makes WhatsApp kick both off).
 */
const sessions = new Map();
const timers = [];
let shuttingDown = false;

export class NotOnWhatsAppError extends Error {
  constructor(phone) {
    super(`${phone} is not on WhatsApp`);
    this.code = 'NOT_ON_WHATSAPP';
  }
}
export class SessionNotConnectedError extends Error {
  constructor() {
    super('WhatsApp is not connected for this account');
    this.code = 'NOT_CONNECTED';
  }
}

const OPT_OUT_RE = /^\s*(stop|unsubscribe|opt[\s-]?out)\s*[.!]?\s*$/i;
const leaseUntil = () => new Date(Date.now() + config.waLeaseMs);

// ------------------------------------------------------------------ leases

/** true if this instance now owns (or already owned) the user's session lease. */
async function acquireLease(userId) {
  try {
    const doc = await SessionLease.findOneAndUpdate(
      { _id: userId, $or: [{ owner: config.instanceId }, { expiresAt: { $lte: new Date() } }] },
      { $set: { owner: config.instanceId, expiresAt: leaseUntil(), status: 'connecting', qr: null, command: null } },
      { upsert: true, returnDocument: 'after' }
    );
    return Boolean(doc);
  } catch (err) {
    if (err.code === 11000) return false; // someone else holds a live lease
    throw err;
  }
}

// ------------------------------------------------------------------ incoming messages (opt-outs and replies)

export async function handleIncoming(userId, messages) {
  for (const m of messages) {
    const msg = extractIncoming(m); // null for our own messages, groups, reactions and the like
    if (!msg) continue;
    const optOut = msg.kind === 'text' && OPT_OUT_RE.test(msg.text);
    if (optOut) {
      try {
        await OptOut.updateOne({ userId, phone: msg.phone }, { $setOnInsert: { userId, phone: msg.phone } }, { upsert: true });
      } catch (err) {
        log.error({ err }, 'failed to record opt-out');
      }
    }
    // Kept only when it comes from someone this account messaged in a campaign; other chats are never stored.
    try {
      await recordReply(userId, msg, { optOut });
    } catch (err) {
      log.error({ err }, 'failed to record reply');
    }
  }
}

// ------------------------------------------------------------------ connection lifecycle

async function endSession(userId, { wipe, reason, byUser = false }) {
  const entry = sessions.get(userId);
  if (entry) {
    entry.stopped = true;
    try {
      if (wipe) await entry.sock?.logout();
      else entry.sock?.end(undefined);
    } catch {
      // the socket may already be closed
    }
    sessions.delete(userId);
  }
  if (wipe) await clearAuthState(userId);
  await SessionLease.deleteOne({ _id: userId, owner: config.instanceId }).catch(() => {});
  sessionEvents.emit('ended', { userId, reason, byUser });
}

async function onConnectionUpdate(userId, entry, sock, update) {
  if (entry.sock !== sock) return; // event from a socket we already replaced
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    entry.status = 'qr';
    entry.qr = qr;
    log.info({ userId }, 'WhatsApp QR code ready to scan');
  }
  if (connection === 'open') {
    entry.status = 'connected';
    entry.qr = null;
    entry.retries = 0;
    entry.phone = (sock.user?.id || '').split(':')[0].split('@')[0] || null;
    entry.detail = null;
    log.info({ userId, phone: entry.phone }, 'WhatsApp connected');
  }
  if (connection !== 'close') return;

  entry.sock = null;
  entry.qr = null; // the old QR code is dead once the connection closes: never keep showing it
  const code = lastDisconnect?.error?.output?.statusCode;
  const why = lastDisconnect?.error?.message;
  log.info({ userId, code, why, stopped: entry.stopped, retries: entry.retries }, 'WhatsApp connection closed');
  if (entry.stopped) {
    entry.status = 'closed';
    return;
  }
  if (code === DisconnectReason.loggedOut) {
    // The user removed this device from their phone: forget the login.
    log.info({ userId }, 'logged out from phone');
    return endSession(userId, { wipe: true, reason: 'You logged this device out of WhatsApp. Link it again to continue.' });
  }
  if (code === DisconnectReason.connectionReplaced) {
    // Another client opened the same login. Fighting for it would get the account flagged: stand down.
    entry.status = 'closed';
    sessionEvents.emit('ended', { userId, reason: 'This WhatsApp account was opened somewhere else.' });
    return;
  }

  if (code === DisconnectReason.forbidden) {
    // WhatsApp refuses this number (restricted or banned). Reconnecting again and again only makes it worse: stop, keep the
    // saved login (it may work again later) and let the restriction handler pause the campaigns and tell the owner.
    entry.status = 'closed';
    entry.detail = 'WhatsApp refused this number. It may be restricted or banned for a while.';
    await SessionLease.deleteOne({ _id: userId, owner: config.instanceId }).catch(() => {});
    restrictionEvents.emit('detected', { userId, phone: entry.phone, source: 'connection', code, reason: why || '' });
    return;
  }

  entry.status = 'connecting';
  entry.retries += 1;
  if (entry.retries > 8) {
    entry.status = 'closed';
    entry.detail = `Gave up after repeated failures (last code ${code ?? 'none'}${why ? `: ${why}` : ''}).`;
    sessionEvents.emit('ended', { userId, reason: 'WhatsApp connection was lost. Reconnect and resume.' });
    return;
  }

  // Make sure everything WhatsApp just gave us (the new login, right after a QR scan) is in the database BEFORE
  // reconnecting, because the new connection reads it back from there.
  await entry.flush?.();

  if (code === DisconnectReason.badSession || code === DisconnectReason.multideviceMismatch) {
    // The saved login is damaged. Start over with a fresh QR code instead of looping on it.
    log.warn({ userId, code }, 'saved WhatsApp login is unusable; clearing it so a new QR can be scanned');
    await clearAuthState(userId);
    await sleep(500);
    if (!entry.stopped && sessions.get(userId) === entry) await connect(userId, entry);
    return;
  }

  // restartRequired happens right after scanning the QR and is expected
  const wait = code === DisconnectReason.restartRequired ? 500 : Math.min(30_000, 1000 * 2 ** entry.retries) + rand(0, 500);
  await sleep(wait);
  if (!entry.stopped && sessions.get(userId) === entry) await connect(userId, entry);
}

async function connect(userId, entry) {
  try {
    const { state, saveCreds, flush } = await useMongoAuthState(userId);
    entry.flush = flush;
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      version,
      auth: state,
      logger: baileysLog,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    entry.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type === 'notify') handleIncoming(userId, messages).catch(() => {});
    });
    sock.ev.on('connection.update', (update) => {
      onConnectionUpdate(userId, entry, sock, update).catch((err) => log.error({ err, userId }, 'connection update failed'));
    });
  } catch (err) {
    log.error({ err, userId }, 'could not start WhatsApp socket');
    entry.sock = null;
    entry.status = 'closed';
    entry.detail = `Could not start WhatsApp: ${err.message}`;
  }
}

// ------------------------------------------------------------------ public API

/**
 * Start a session if nobody owns it. Returns the entry if this instance owns it, or null if another instance does.
 */
export async function startSession(userId) {
  userId = String(userId);
  const existing = sessions.get(userId);
  if (existing && existing.status !== 'closed') return existing;
  if (!existing && sessions.size >= config.waMaxSessions) {
    throw bad('This server is at its WhatsApp session capacity. Try again later.', 503);
  }
  if (!(await acquireLease(userId))) return null;

  const entry = existing || { sock: null, status: 'connecting', qr: null, retries: 0, stopped: false, phone: null, flush: null, detail: null };
  entry.stopped = false;
  entry.status = 'connecting';
  entry.retries = 0;
  sessions.set(userId, entry);
  await connect(userId, entry);
  return entry;
}

export async function getStatus(userId) {
  userId = String(userId);
  const entry = sessions.get(userId);
  let status = 'disconnected';
  let qr = null;
  let detail = null;
  if (entry) {
    ({ status, qr } = entry);
    detail = entry.detail || null;
  } else {
    // Another instance may own it: its status is mirrored into the lease every few seconds.
    const lease = await SessionLease.findOne({ _id: userId, expiresAt: { $gt: new Date() } }).lean();
    if (lease) ({ status, qr } = lease);
  }
  return { status, detail, qr: qr ? await QRCode.toDataURL(qr, { margin: 1, width: 280 }) : null };
}

/** Log out and forget the login. If another instance owns the session, ask it to do so. */
export async function disconnect(userId) {
  userId = String(userId);
  if (sessions.has(userId)) return endSession(userId, { wipe: true, reason: 'You disconnected WhatsApp.', byUser: true });
  const lease = await SessionLease.findOneAndUpdate({ _id: userId, expiresAt: { $gt: new Date() } }, { $set: { command: 'logout' } });
  if (!lease) {
    await clearAuthState(userId);
    sessionEvents.emit('ended', { userId, reason: 'You disconnected WhatsApp.', byUser: true });
  }
}

export const sessionState = (userId) => sessions.get(String(userId))?.status || null;
export const isConnected = (userId) => sessions.get(String(userId))?.status === 'connected';
export const ownPhone = (userId) => sessions.get(String(userId))?.phone || null;
export const ownedUserIds = () => [...sessions.keys()];

/** The number linked right now (digits only), or null when nothing is connected. Works for a session held by another server too. */
export async function connectedPhone(userId) {
  userId = String(userId);
  const entry = sessions.get(userId);
  if (entry) return entry.status === 'connected' ? entry.phone || null : null;
  const lease = await SessionLease.findOne({ _id: userId, expiresAt: { $gt: new Date() }, status: 'connected' }).select('phone').lean();
  return lease?.phone || null;
}

/**
 * Send one message: the text, or a file (picture, video, sound, document) with its text.
 * Checks the number is on WhatsApp and mimics typing. `media` is { buffer, mime, name, kind } or null.
 */
export async function sendMessage(userId, phone, text, media = null) {
  const entry = sessions.get(String(userId));
  if (!entry || entry.status !== 'connected' || !entry.sock) throw new SessionNotConnectedError();
  const { sock } = entry;

  const [result] = (await sock.onWhatsApp(`${phone}@s.whatsapp.net`)) || [];
  if (!result?.exists) throw new NotOnWhatsAppError(phone);
  const jid = result.jid;

  await sock.presenceSubscribe(jid);
  await sock.sendPresenceUpdate('composing', jid);
  await sleep(rand(1500, 4000));
  for (const content of buildContents(text, media)) await sock.sendMessage(jid, content);
  await sock.sendPresenceUpdate('paused', jid);
}

/** Send one text message. */
export const sendText = (userId, phone, text) => sendMessage(userId, phone, text, null);

// ------------------------------------------------------------------ background loops

/** Every few seconds: renew leases, mirror status for other instances, obey 'logout' commands. */
async function leaseTick() {
  for (const [userId, entry] of sessions) {
    try {
      const lease = await SessionLease.findOneAndUpdate(
        { _id: userId, owner: config.instanceId },
        { $set: { expiresAt: leaseUntil(), status: entry.status, qr: entry.qr, phone: entry.phone || null } },
        { returnDocument: 'after' }
      );
      if (!lease) {
        // We lost ownership (long pause, network partition): stop touching this login.
        entry.stopped = true;
        try {
          entry.sock?.end(undefined);
        } catch {
          // ignore
        }
        sessions.delete(userId);
        // pause: false because the login is fine, another instance now holds it and keeps sending
        sessionEvents.emit('ended', { userId, reason: 'WhatsApp session moved to another server.', pause: false });
        continue;
      }
      if (lease.command === 'logout') await endSession(userId, { wipe: true, reason: 'You disconnected WhatsApp.', byUser: true });
    } catch (err) {
      log.error({ err, userId }, 'lease renewal failed');
    }
  }
}

/** Every 30s: pick up saved logins nobody owns (after a restart, or when another instance died). */
async function adoptTick() {
  if (shuttingDown || sessions.size >= config.waMaxSessions) return;
  const saved = (await usersWithSavedLogin()).map(String);
  if (!saved.length) return;
  const live = new Set((await SessionLease.find({ expiresAt: { $gt: new Date() } }).select('_id').lean()).map((l) => String(l._id)));
  const restricted = new Set((await restrictedUserIds()).map(String)); // a refused number is not reconnected on its own
  for (const userId of saved) {
    if (sessions.has(userId) || live.has(userId) || restricted.has(userId)) continue;
    if (sessions.size >= config.waMaxSessions) break;
    try {
      await startSession(userId);
    } catch (err) {
      log.error({ err, userId }, 'could not adopt session');
    }
  }
}

export function startLoops() {
  const every = (fn, ms, label) => timers.push(setInterval(() => fn().catch((err) => log.error({ err }, `${label} failed`)), ms));
  every(leaseTick, 5_000, 'lease tick');
  every(adoptTick, 30_000, 'adopt tick');
  adoptTick().catch((err) => log.error({ err }, 'initial adopt failed'));
}

/** Close sockets without logging anyone out, and release leases so another instance can take over quickly. */
export async function shutdown() {
  shuttingDown = true;
  timers.splice(0).forEach(clearInterval);
  for (const entry of sessions.values()) {
    entry.stopped = true;
    try {
      entry.sock?.end(undefined);
    } catch {
      // ignore
    }
  }
  sessions.clear();
  await SessionLease.updateMany({ owner: config.instanceId }, { $set: { expiresAt: new Date(0) } }).catch(() => {});
}
