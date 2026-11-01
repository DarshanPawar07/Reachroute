import { Router } from 'express';
import {
  accountDetail, createPlan, deletePlan, forceLogout, isPlanKey, listPlans, listUsers, markVerified, overview, setUserLimits, setUserPlan, suspendUser, unsuspendUser, updatePlan,
} from '../admin/accounts.js';
import { billingSummary, issueCreditNote, listInvoices, listSubscriptions, listUpiRequests } from '../admin/billing.js';
import { confirmUpiPayment, rejectUpiPayment } from '../billing/service.js';

import { describeLimits } from '../plans/definitions.js';
import { fromReq, listAudit, record } from '../audit/audit.js';
import { requireAdmin } from '../middleware/auth.js';
import { ContactMessage, User } from '../models.js';
import { bad, validId } from '../utils/http.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ mod: 'admin' });

/**
 * The admin area. Everything here needs an administrator (set with `npm run make-admin -- <email>`; there is no way
 * to become one through the API). Each change is written to the log with who did it to whom.
 */
export function adminRouter() {
  const router = Router();
  router.param('id', validId);
  router.param('key', (_req, _res, next, key) => (isPlanKey(key) ? next() : next(bad('Not found', 404))));
  router.use(requireAdmin);

  // Written to the audit log (who, whom, from where, why) and to the normal log.
  const done = async (req, action, result, detail = '') => {
    log.info({ admin: req.userId, target: req.params.id, action, detail }, 'admin action');
    await record({ ...fromReq(req), actorEmail: req.adminEmail, action, targetId: req.params.id, targetEmail: result.email, detail });
  };

  router.get('/overview', async (_req, res) => res.json(await overview()));

  router.get('/users', async (req, res) => {
    const { search, status, sort, page, limit } = req.query;
    for (const value of [search, status, sort, page, limit]) if (value !== undefined && typeof value !== 'string') throw bad('Each filter can be given only once');
    res.json(await listUsers({ search, status, sort, page, limit }));
  });

  // Who did what: ?actor= / ?target= (account ids), ?email=, ?action=, ?from= / ?to= (dates), ?page= ?limit=
  router.get('/audit', async (req, res) => res.json(await listAudit(req.query)));

  router.get('/users/:id', async (req, res) => res.json(await accountDetail(req.params.id)));

  router.post('/users/:id/suspend', async (req, res) => {
    if (req.params.id === req.userId) throw bad('You cannot suspend your own account');
    const reason = req.body?.reason;
    if (reason !== undefined && typeof reason !== 'string') throw bad('The reason must be text');
    const result = await suspendUser(req.params.id, reason);
    await done(req, 'user.suspended', result, `${String(reason ?? '').trim()}${reason ? ' | ' : ''}paused ${result.pausedCampaigns} campaign(s)`);
    res.json({ ok: true, pausedCampaigns: result.pausedCampaigns });
  });

  router.post('/users/:id/unsuspend', async (req, res) => {
    await done(req, 'user.unsuspended', await unsuspendUser(req.params.id));
    res.json({ ok: true });
  });

  router.post('/users/:id/force-logout', async (req, res) => {
    await done(req, 'user.signed_out', await forceLogout(req.params.id));
    res.json({ ok: true });
  });

  // ---- plans: named sets of limits; accounts without a plan use the platform defaults ("default")
  router.get('/plans', async (_req, res) => res.json(await listPlans()));

  router.post('/plans', async (req, res) => {
    const plan = await createPlan(req.body || {});
    await record({ ...fromReq(req), actorEmail: req.adminEmail, action: 'plan.created', detail: `${plan.key} "${plan.name}" Rs ${plan.priceMonthly}/mo, Rs ${plan.priceYearly}/yr: ${describeLimits(plan.limits)}` });
    res.status(201).json({ plan });
  });

  router.put('/plans/:key', async (req, res) => {
    const plan = await updatePlan(req.params.key, req.body || {});
    await record({ ...fromReq(req), actorEmail: req.adminEmail, action: 'plan.updated', detail: `${plan.key} "${plan.name}" Rs ${plan.priceMonthly}/mo, Rs ${plan.priceYearly}/yr: ${describeLimits(plan.limits)}` });
    res.json({ plan });
  });

  router.delete('/plans/:key', async (req, res) => {
    const plan = await deletePlan(req.params.key);
    await record({ ...fromReq(req), actorEmail: req.adminEmail, action: 'plan.deleted', detail: `${plan.key} "${plan.name}"` });
    res.json({ ok: true });
  });

  router.put('/users/:id/plan', async (req, res) => {
    const { plan } = req.body || {};
    if (plan !== null && typeof plan !== 'string') throw bad('Send { "plan": "<key>" }, or "default" to use the platform defaults');
    const result = await setUserPlan(req.params.id, plan);
    await done(req, 'user.plan_changed', result, `${result.from} -> ${result.to}`);
    res.json({ ok: true, plan: result.to });
  });

  router.put('/users/:id/limits', async (req, res) => {
    const result = await setUserLimits(req.params.id, (req.body || {}).limits);
    await done(req, 'user.limits_changed', result, result.text);
    res.json({ ok: true, overrides: result.overrides });
  });

  router.post('/users/:id/verify-email', async (req, res) => {
    await done(req, 'user.email_verified', await markVerified(req.params.id));
    res.json({ ok: true });
  });

  // ---- billing: who pays, what was invoiced, refund notes
  router.get('/billing/summary', async (_req, res) => res.json(await billingSummary()));
  router.get('/billing/subscriptions', async (req, res) => res.json(await listSubscriptions(req.query)));
  router.get('/billing/invoices', async (req, res) => res.json(await listInvoices(req.query)));
  router.get('/billing/upi-requests', async (req, res) => res.json(await listUpiRequests(req.query)));
  router.post('/billing/upi-requests/:id/confirm', async (req, res) => {
    const b = req.body || {};
    for (const v of [b.note, b.utr]) if (v !== undefined && typeof v !== 'string') throw bad('Send text');
    if (b.utr && !/^\d{12}$/.test(b.utr.trim())) throw bad('A UPI transaction id has 12 digits');
    const r = await confirmUpiPayment(req.params.id, { by: req.adminEmail, note: b.note, utr: b.utr });
    if (!r) throw bad('This request was already decided, or does not exist.', 409);
    const email = (await User.findById(r.request.userId).select('email').lean())?.email;
    await record({ ...fromReq(req), actorEmail: req.adminEmail, action: 'billing.upi_confirmed', targetId: r.request.userId, targetEmail: email, detail: `${r.request.reference} ${r.request.planKey} ${r.request.interval} Rs ${r.request.amountPaise / 100} utr ${r.request.utr}`.slice(0, 500) });
    res.json({ ok: true, invoice: r.invoice?.number });
  });
  router.post('/billing/upi-requests/:id/reject', async (req, res) => {
    const note = req.body?.note;
    if (typeof note !== 'string' || !note.trim()) throw bad('Say why, so the customer knows what to do');
    const r = await rejectUpiPayment(req.params.id, { by: req.adminEmail, note: note.trim() });
    if (!r) throw bad('This request was already decided, or does not exist.', 409);
    const email = (await User.findById(r.userId).select('email').lean())?.email;
    await record({ ...fromReq(req), actorEmail: req.adminEmail, action: 'billing.upi_rejected', targetId: r.userId, targetEmail: email, detail: `${r.reference} | ${note.trim()}`.slice(0, 500) });
    res.json({ ok: true });
  });
  router.post('/billing/invoices/:id/refund-note', async (req, res) => {
    const result = await issueCreditNote(req.params.id, req.body || {}, req.adminEmail);
    log.info({ admin: req.userId, invoice: req.params.id, note: result.note.number }, 'refund note issued');
    await record({
      ...fromReq(req), actorEmail: req.adminEmail, action: 'billing.refund_note', targetId: result.userId, targetEmail: result.email,
      detail: `${result.note.number}: Rs ${result.note.amountPaise / 100} on ${result.invoice.number} | ${result.note.reason}`.slice(0, 500),
    });
    res.json({ invoice: result.invoice, note: { number: result.note.number } });
  });

  // ---- messages from the public Contact page
  router.get('/messages', async (req, res) => {
    const filter = req.query.handled === 'true' ? { handled: true } : req.query.handled === 'false' ? { handled: false } : {};
    const [messages, open] = await Promise.all([
      ContactMessage.find(filter).sort({ createdAt: -1 }).limit(200).select('-ip').lean(),
      ContactMessage.countDocuments({ handled: false }),
    ]);
    res.json({ messages, open });
  });

  router.post('/messages/:id/handled', async (req, res) => {
    const handled = req.body?.handled !== false;
    const msg = await ContactMessage.findByIdAndUpdate(req.params.id, { handled }, { new: true }).select('-ip').lean();
    if (!msg) throw bad('Not found', 404);
    res.json({ message: msg });
  });

  return router;
}
