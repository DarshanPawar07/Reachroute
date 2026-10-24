import { Router } from 'express';
import { whatsappEngine } from '../engine/channels.js';
import { evaluateHealth } from '../whatsapp/health.js';
import { getRestriction, markSwitching, resumeRestricted } from '../whatsapp/restriction.js';
import { connectedPhone, disconnect, getStatus, startSession } from '../whatsapp/sessionManager.js';

/** Connection endpoints. `limiter` throttles connect attempts per user. */
export function whatsappRouter({ connectLimiter } = {}) {
  const router = Router();

  // Poll every ~2s from the frontend while status === 'qr' to show/refresh the QR code.
  router.get('/status', async (req, res) => res.json(await getStatus(req.userId)));

  // Is this account being used in a way WhatsApp may punish? Also shows how much of the hourly limit is used.
  router.get('/health', async (req, res) => res.json(await evaluateHealth(req.userId)));

  router.post('/connect', ...(connectLimiter ? [connectLimiter] : []), async (req, res) => {
    await startSession(req.userId); // returns null if another instance already owns it; status below tells the story
    res.json(await getStatus(req.userId));
  });

  // Did WhatsApp refuse this number (restricted or banned)? Until when, what to do next, and which campaigns are waiting.
  router.get('/restriction', async (req, res) => res.json(await getRestriction(req.userId, { phone: await connectedPhone(req.userId) })));

  // Give up the restricted number and link a different one: logs the old login out here and returns a fresh QR code to scan.
  router.post('/switch-number', ...(connectLimiter ? [connectLimiter] : []), async (req, res) => {
    await markSwitching(req.userId);
    await disconnect(req.userId);
    await startSession(req.userId);
    res.json(await getStatus(req.userId));
  });

  // After a different number is linked (or the time is up): resume every campaign that stopped because of the restriction.
  router.post('/restriction/resume', async (req, res) => {
    res.json(await resumeRestricted(req.userId, { engine: whatsappEngine, phone: await connectedPhone(req.userId) }));
  });

  router.post('/disconnect', async (req, res) => {
    await disconnect(req.userId);
    res.json({ status: 'disconnected' });
  });

  return router;
}
