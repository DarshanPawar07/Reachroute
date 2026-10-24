import { Router } from 'express';
import mongoose from 'mongoose';
import { Notification } from '../models.js';
import { bad } from '../utils/http.js';

const router = Router();

// Latest alerts plus how many are unread (the number on the bell).
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const [notifications, unread] = await Promise.all([
    Notification.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(limit).select('type level title message link read createdAt').lean(),
    Notification.countDocuments({ userId: req.userId, read: false }),
  ]);
  res.json({ notifications, unread });
});

// Cheap call the app polls for the unread badge.
router.get('/unread-count', async (req, res) => {
  res.json({ unread: await Notification.countDocuments({ userId: req.userId, read: false }) });
});

// Mark one alert (body: { id }) or all of them (body: { all: true }) as read.
router.post('/read', async (req, res) => {
  const { id, all } = req.body || {};
  if (all === true) {
    await Notification.updateMany({ userId: req.userId, read: false }, { $set: { read: true } });
  } else if (id !== undefined) {
    if (!mongoose.isValidObjectId(id)) throw bad('Not found', 404);
    await Notification.updateOne({ _id: id, userId: req.userId }, { $set: { read: true } });
  } else {
    throw bad('Send { "id": "..." } or { "all": true }');
  }
  res.json({ unread: await Notification.countDocuments({ userId: req.userId, read: false }) });
});

router.delete('/', async (req, res) => {
  await Notification.deleteMany({ userId: req.userId });
  res.json({ unread: 0 });
});

export default router;