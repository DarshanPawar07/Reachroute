import { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { markUsed, resolveForCampaign } from '../attachments/store.js';
import { config } from '../config.js';
import { readSchedule } from '../engine/window.js';
import { assertAcceptedTerms } from '../legal/consent.js';
import { ContactList, ListContact } from '../models.js';
import { resolveLimits } from '../plans/limits.js';
import { assertVerified } from '../utils/authTokens.js';
import { csvLine, safeDownloadName } from '../utils/csv.js';
import { bad, validId } from '../utils/http.js';
import { blankValues, checkTemplate, columnsOf } from '../utils/template.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 20 } });

const isTrue = (v) => v === true || v === 'true';
const isFalse = (v) => v === false || v === 'false';

/**
 * Pick the contacts for a campaign from a saved list.
 *   listId     the list
 *   onlyNew    (default true) only people who were never part of a campaign from this list
 *   limit      how many to take (default and maximum: what is left of the daily limit around the campaign's start)
 * In "only new" mode the chosen contacts are claimed straight away, so two campaigns started at the same moment
 * can never pick the same people. If the campaign cannot be created, the claim is given back.
 */
async function claimFromList(req, channel, engine, atMs) {
  const { listId } = req.body;
  if (!mongoose.isValidObjectId(listId)) throw bad('That list was not found', 404);
  const list = await ContactList.findOne({ _id: listId, userId: req.userId, kind: channel.name }).lean();
  if (!list) throw bad('That list was not found', 404);

  const onlyNew = !isFalse(req.body.onlyNew);
  const remaining = await engine.remainingToday(req.userId, atMs);
  if (remaining === 0) throw bad(`You have used today's limit of ${channel.limits.dailyCap}. Try again later.`, 429);

  let take = remaining;
  let capped = false;
  if (req.body.limit !== undefined && req.body.limit !== '') {
    const wanted = Number(req.body.limit);
    if (!Number.isInteger(wanted) || wanted < 1) throw bad('How many contacts? Enter a whole number, 1 or more.');
    take = Math.min(wanted, remaining);
    capped = wanted > remaining;
  }

  const filter = { listId: list._id, ...(onlyNew ? { lastCampaignAt: null } : {}) };
  const picked = await ListContact.find(filter).sort({ _id: 1 }).limit(take).select('_id').lean();
  if (!picked.length) {
    throw bad(
      onlyNew
        ? 'Everyone in this list has already been messaged. Add new contacts, or untick "only people not messaged yet".'
        : 'This list has no contacts.'
    );
  }
  const ids = picked.map((p) => p._id);
  const stamp = new Date();

  if (onlyNew) {
    // Claim first: only rows that were still unclaimed get our stamp.
    await ListContact.updateMany({ _id: { $in: ids }, lastCampaignAt: null }, { $set: { lastCampaignAt: stamp } });
  }
  const rows = await ListContact.find(onlyNew ? { _id: { $in: ids }, lastCampaignAt: stamp } : { _id: { $in: ids } })
    .sort({ _id: 1 })
    .select('name value fields')
    .lean();
  const claimedIds = rows.map((r) => r._id);

  return {
    list,
    capped,
    contacts: rows.map((r) => ({ name: r.name, [channel.contactField]: r.value, ...(r.fields ? { fields: r.fields } : {}) })),
    // after the campaign exists: remember who was messaged (the "only new" mode already did this when claiming)
    commit: async () => {
      if (!onlyNew) await ListContact.updateMany({ _id: { $in: claimedIds } }, { $set: { lastCampaignAt: stamp } });
    },
    // the campaign could not be created: give the claimed people back
    release: async () => {
      if (onlyNew) await ListContact.updateMany({ _id: { $in: claimedIds }, lastCampaignAt: stamp }, { $set: { lastCampaignAt: null } });
    },
  };
}

/**
 * Campaign endpoints, identical for both channels:
 *   POST /  GET /  GET /:id  PATCH /:id/schedule  POST /:id/pause|resume|cancel|retry
 * Scheduling fields on POST and PATCH: startAt (ISO time with offset), windowStart, windowEnd ("09:00"),
 * timezone ("Asia/Kolkata"), windowDays ("1,2,3,4,5", 0 = Sunday), removeWindow (PATCH only).
 * `channel` describes what differs (fields, contact file, opt-outs); `engine` does the work.
 * `limiter` (optional) throttles campaign creation per user.
 * A campaign's contacts come from an uploaded `file` or from a saved list (`listId`).
 */
/** A/B test: for each subject line, how many people got it and what happened. */
async function variantResults(Recipient, campaignId) {
  const rows = await Recipient.aggregate([{ $match: { campaignId } }, { $group: { _id: { v: '$variant', s: '$status', f: '$feedback' }, n: { $sum: 1 } } }]);
  const blank = () => ({ people: 0, sent: 0, failed: 0, skipped: 0, bounced: 0, complaints: 0, unsubscribed: 0 });
  const out = { A: blank(), B: blank() };
  for (const { _id: k, n } of rows) {
    const v = out[k.v];
    if (!v) continue;
    v.people += n;
    if (k.s === 'sent' || k.s === 'failed' || k.s === 'skipped') v[k.s] += n;
    if (k.f === 'bounced') v.bounced += n;
    if (k.f === 'complaint') v.complaints += n;
    if (k.f === 'unsubscribed') v.unsubscribed += n;
  }
  return out;
}

export function campaignRouter(channel, engine, { createLimiter } = {}) {
  const router = Router();
  const { Campaign, Recipient, contactField } = channel;
  router.param('id', validId);

  const create = async (req, res) => {
    const fields = channel.readFields(req.body);
    const consent = isTrue(req.body.consentConfirmed);
    const fromList = Boolean(req.body.listId);
    if (!fromList && !req.file) throw bad('Upload a .csv, .xlsx or .json file of contacts, or choose a saved list');
    if (!consent) throw bad('You must confirm that everyone in the list has agreed to hear from you (consentConfirmed=true).');
    const when = readSchedule(req.body, { maxDays: config.maxScheduleDays });
    await assertVerified(req.userId);
    await assertAcceptedTerms(req.userId);
    await channel.requireReady(req.userId);
    const { limits: ownLimits } = await resolveLimits(req.userId);
    fields.attachments = await resolveForCampaign(req.userId, req.body.attachmentIds, channel.name, ownLimits);

    let contacts;
    let invalid = [];
    let duplicates = 0;
    let claim = null;
    if (fromList) {
      claim = await claimFromList(req, channel, engine, when.startAt ? when.startAt.getTime() : Date.now());
      contacts = claim.contacts;
    } else {
      const { limits: own } = await resolveLimits(req.userId);
      const parsed = await channel.parseFile(req.file.buffer, req.file.originalname, own[channel.uploadLimit]);
      ({ contacts, invalid, duplicates } = parsed);
    }

    try {
      const { allowed, skipped } = await channel.filterOptOuts(req.userId, contacts);
      if (!allowed.length) {
        // Everyone picked had opted out: they stay marked as handled, so they are not picked again.
        claim = null;
        return res.status(400).json({ error: 'No valid contacts to send to.', invalid });
      }

      // {{variables}} that cannot be filled in, or are written wrongly, would reach people as they are: stop before sending.
      const texts = channel.templateTexts(fields);
      const problems = checkTemplate(texts, columnsOf(allowed));
      if (problems.length) throw bad(problems.join(' '));

      const campaign = await engine.createCampaign({ userId: req.userId, fields, contacts: allowed, startAt: when.startAt ?? null, sendWindow: when.sendWindow ?? null });
      await claim?.commit();
      await markUsed(fields.attachments).catch(() => {});

      const summary = { queued: allowed.length, invalid, duplicatesRemoved: duplicates, optedOutSkipped: skipped, blankValues: blankValues(texts, allowed) };
      if (claim) {
        summary.list = {
          name: claim.list.name,
          notMessagedYet: await ListContact.countDocuments({ listId: claim.list._id, lastCampaignAt: null }),
          cappedToDailyLimit: claim.capped,
        };
      }
      res.status(201).json({ campaign, summary });
    } catch (err) {
      await claim?.release().catch(() => {});
      throw err;
    }
  };
  router.post('/', ...(createLimiter ? [createLimiter] : []), upload.single('file'), create);

  router.get('/', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const query = { userId: req.userId };
    if (req.query.before) query.createdAt = { $lt: new Date(String(req.query.before)) };
    const campaigns = await Campaign.find(query).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ campaigns });
  });

  router.get('/:id', async (req, res) => {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!campaign) throw bad('Campaign not found', 404);
    // Counters come from the recipient rows themselves, so they are right even after a crash.
    const by = await engine.counts(campaign._id);
    Object.assign(campaign, { sentCount: by.sent || 0, failedCount: by.failed || 0, skippedCount: by.skipped || 0 });
    const recipients = await Recipient.find({ campaignId: campaign._id })
      .sort({ createdAt: 1, _id: 1 })
      .limit(1000)
      .select(`name ${contactField} status error ambiguous sentAt feedback variant`)
      .lean();
    // Email: what happened after delivery (bounced later, reported spam, unsubscribed). Empty for WhatsApp.
    const after = await Recipient.aggregate([{ $match: { campaignId: campaign._id, feedback: { $ne: null } } }, { $group: { _id: '$feedback', n: { $sum: 1 } } }]);
    campaign.feedback = Object.fromEntries(after.map((r) => [r._id, r.n]));
    const next = await Recipient.findOne({ campaignId: campaign._id, status: 'pending', scheduledFor: { $ne: null } }).sort({ scheduledFor: 1 }).select('scheduledFor').lean();
    campaign.nextSendAt = campaign.status === 'running' && next ? next.scheduledFor : null; // when the next message goes out
    if (campaign.subjectB) campaign.variants = await variantResults(Recipient, campaign._id); // A/B test: how each subject line did
    // Replies: how many people wrote back, and (for A/B) which subject line they were answering.
    const replies = await channel.Reply.aggregate([{ $match: { userId: campaign.userId, campaignId: campaign._id } }, { $group: { _id: { v: '$variant', o: '$optOut' }, n: { $sum: 1 }, people: { $addToSet: '$recipientId' } } }]);
    campaign.replies = { total: 0, optOuts: 0, people: 0 };
    const peopleSeen = new Set();
    for (const r of replies) {
      campaign.replies.total += r.n;
      if (r._id.o) campaign.replies.optOuts += r.n;
      r.people.forEach((p) => peopleSeen.add(String(p)));
      if (campaign.variants && campaign.variants[r._id.v]) campaign.variants[r._id.v].replies = (campaign.variants[r._id.v].replies || 0) + r.n;
    }
    campaign.replies.people = peopleSeen.size; // people who wrote at least once
    res.json({ campaign, recipients });
  });

  // The whole campaign as a spreadsheet: one row per person (not only the first 1000 the page shows).
  router.get('/:id/report.csv', async (req, res) => {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!campaign) throw bad('Campaign not found', 404);
    const isEmail = channel.name === 'email';
    const label = { sent: 'sent', failed: 'failed', skipped: 'skipped', pending: 'waiting', sending: 'sending' };
    const head = ['Name', contactField === 'phone' ? 'Phone' : 'Email', 'Status', 'Detail', 'Sent at', ...(isEmail ? ['After delivery'] : []), ...(campaign.subjectB ? ['Subject version'] : [])];

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeDownloadName(campaign.name)}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('\uFEFF' + csvLine(head)); // the mark lets Excel read names in any language correctly
    const cursor = Recipient.find({ campaignId: campaign._id }).sort({ createdAt: 1, _id: 1 }).select(`name ${contactField} status error ambiguous sentAt feedback variant`).lean().cursor();
    try {
      for await (const r of cursor) {
        const detail = r.error || (r.ambiguous ? 'may have been delivered' : '');
        const ok = res.write(csvLine([r.name, r[contactField], label[r.status] || r.status, detail, r.sentAt, ...(isEmail ? [r.feedback] : []), ...(campaign.subjectB ? [r.variant] : [])]));
        if (!ok) await new Promise((resolve) => res.once('drain', resolve)); // do not pile up memory for a slow download
      }
      res.end();
    } catch (err) {
      res.destroy(err); // the file is cut short rather than looking complete
    }
  });

  router.patch('/:id/schedule', async (req, res) => {
    const change = readSchedule(req.body, { maxDays: config.maxScheduleDays });
    if (change.startAt === undefined && change.sendWindow === undefined) throw bad('Send a start time or a send window to change.');
    res.json({ campaign: await engine.updateSchedule(req.userId, req.params.id, change) });
  });

  router.post('/:id/pause', async (req, res) => res.json({ campaign: await engine.pause(req.userId, req.params.id) }));
  router.post('/:id/resume', async (req, res) => {
    await channel.requireReady(req.userId);
    res.json({ campaign: await engine.resume(req.userId, req.params.id) });
  });
  router.post('/:id/cancel', async (req, res) => res.json({ campaign: await engine.cancel(req.userId, req.params.id) }));
  router.post('/:id/retry', async (req, res) => {
    await channel.requireReady(req.userId);
    const includeAmbiguous = req.body?.includeAmbiguous === true;
    res.json({ campaign: await engine.retryFailed(req.userId, req.params.id, { includeAmbiguous }) });
  });

  return router;
}
