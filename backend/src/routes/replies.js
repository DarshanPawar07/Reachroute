import { Router } from 'express';
import mongoose from 'mongoose';
import { Campaign, EmailCampaign, EmailReply, Reply } from '../models.js';
import { bad, validId } from '../utils/http.js';

const objectId = (value) => {
  if (!mongoose.isValidObjectId(value)) throw bad('Not found', 404);
  return new mongoose.Types.ObjectId(String(value));
};

/**
 * The replies API of one channel. WhatsApp and email share it; only the model and the columns differ.
 * Mounted at /api/whatsapp/replies and /api/email/replies.
 */
export function createRepliesRouter({ Reply, Campaign, select }) {
const router = Router();
router.param('id', validId);
const unread = (userId) => Reply.countDocuments({ userId, readAt: null });

/**
 * Replies to campaign messages, newest first.
 *   campaignId  only replies to that campaign
 *   unread      "true" for only the ones not read yet
 *   limit       1 to 100 (default 30)
 *   before      an ISO time: replies received before it (use `nextBefore` from the last page)
 */
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const query = { userId: req.userId };
  if (req.query.campaignId) query.campaignId = objectId(req.query.campaignId);
  if (req.query.unread === 'true') query.readAt = null;
  if (req.query.before) {
    const before = new Date(String(req.query.before));
    if (Number.isNaN(before.getTime())) throw bad('"before" must be a date and time');
    query.receivedAt = { $lt: before };
  }

  const rows = await Reply.find(query).sort({ receivedAt: -1, _id: -1 }).limit(limit + 1).select(select).lean();
  const hasMore = rows.length > limit;
  const replies = rows.slice(0, limit);

  const names = new Map(
    (await Campaign.find({ _id: { $in: [...new Set(replies.map((r) => String(r.campaignId)).filter((id) => id !== 'null'))] } }).select('name').lean()).map((c) => [String(c._id), c.name])
  );
  for (const r of replies) r.campaignName = names.get(String(r.campaignId)) || null; // null once the campaign was cleaned up

  res.json({ replies, nextBefore: hasMore ? replies.at(-1).receivedAt : null, unread: await unread(req.userId) });
});

// Cheap call the app polls for the unread badge.
router.get('/unread-count', async (req, res) => res.json({ unread: await unread(req.userId) }));

// Which campaigns got replies: how many, how many are unread, and how many said STOP. Most recent reply first.
router.get('/campaigns', async (req, res) => {
  const rows = await Reply.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(req.userId)), campaignId: { $ne: null } } },
    {
      $group: {
        _id: '$campaignId',
        replies: { $sum: 1 },
        unread: { $sum: { $cond: [{ $eq: ['$readAt', null] }, 1, 0] } },
        optOuts: { $sum: { $cond: ['$optOut', 1, 0] } },
        lastReplyAt: { $max: '$receivedAt' },
      },
    },
    { $sort: { lastReplyAt: -1 } },
    { $limit: 50 },
  ]);
  const names = new Map((await Campaign.find({ _id: { $in: rows.map((r) => r._id) } }).select('name').lean()).map((c) => [String(c._id), c.name]));
  res.json({ campaigns: rows.map((r) => ({ campaignId: r._id, campaignName: names.get(String(r._id)) || null, replies: r.replies, unread: r.unread, optOuts: r.optOuts, lastReplyAt: r.lastReplyAt })) });
});

// Mark replies as read: { id }, { ids: [...] }, { campaignId } or { all: true }.
router.post('/read', async (req, res) => {
  const { id, ids, campaignId, all } = req.body || {};
  const now = new Date();
  const base = { userId: req.userId, readAt: null };
  if (all === true) {
    await Reply.updateMany(base, { $set: { readAt: now } });
  } else if (campaignId !== undefined) {
    await Reply.updateMany({ ...base, campaignId: objectId(campaignId) }, { $set: { readAt: now } });
  } else if (Array.isArray(ids)) {
    if (ids.length > 200) throw bad('Mark at most 200 replies at a time');
    await Reply.updateMany({ ...base, _id: { $in: ids.map(objectId) } }, { $set: { readAt: now } });
  } else if (id !== undefined) {
    await Reply.updateOne({ ...base, _id: objectId(id) }, { $set: { readAt: now } });
  } else {
    throw bad('Send { "id": "..." }, { "ids": [...] }, { "campaignId": "..." } or { "all": true }');
  }
  res.json({ unread: await unread(req.userId) });
});

router.delete('/:id', async (req, res) => {
  const gone = await Reply.deleteOne({ _id: req.params.id, userId: req.userId });
  if (!gone.deletedCount) throw bad('Reply not found', 404);
  res.json({ unread: await unread(req.userId) });
});

return router;
}

export default createRepliesRouter({ Reply, Campaign, select: 'phone name text kind campaignId optOut receivedAt readAt' });
export const emailRepliesRouter = () => createRepliesRouter({ Reply: EmailReply, Campaign: EmailCampaign, select: 'email name subject text campaignId variant optOut receivedAt readAt' });
