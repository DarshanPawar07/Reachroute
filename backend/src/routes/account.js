import { Router } from 'express';
import { fromReq, record } from '../audit/audit.js';
import { checkVersions, consentStatus, recordAcceptance } from '../legal/consent.js';
import { ContactList, Template } from '../models.js';
import { usageOf } from '../attachments/store.js';
import { limitTable } from '../plans/limits.js';
import { quotaSummary } from '../plans/quota.js';

/** The logged-in person's own plan and limits, and how much of the saved-item limits they use. */
export function accountRouter() {
  const router = Router();

  router.get('/plan', async (req, res) => {
    const [table, lists, templates, files, quota] = await Promise.all([
      limitTable(req.userId),
      ContactList.countDocuments({ userId: req.userId }),
      Template.countDocuments({ userId: req.userId }),
      usageOf(req.userId),
      quotaSummary(req.userId),
    ]);
    res.json({ ...table, usage: { lists, templates, attachments: files.count, storageBytes: files.bytes }, quota });
  });

  // Which documents this account has accepted, and which it still has to.
  router.get('/legal', async (req, res) => res.json(await consentStatus(req.userId)));

  // Accept the documents the person was shown ({ versions: { terms: "<version>", privacy: "<version>" } }).
  router.post('/legal/accept', async (req, res) => {
    const docs = checkVersions((req.body || {}).versions);
    await recordAcceptance(req.userId, { docs, via: 'accept', ip: req.ip, userAgent: req.get('user-agent') });
    await record({ ...fromReq(req), action: 'terms.accepted', detail: docs.join(', ') });
    res.json(await consentStatus(req.userId));
  });

  return router;
}
