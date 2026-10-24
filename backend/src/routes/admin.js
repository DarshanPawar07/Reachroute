import { Router } from 'express';
import {
  accountDetail, createPlan, deletePlan, forceLogout, isPlanKey, listPlans, listUsers, markVerified, overview, setUserLimits, setUserPlan, suspendUser, unsuspendUser, updatePlan,
} from '../admin/accounts.js';
import { describeLimits } from '../plans/definitions.js';
import { fromReq, listAudit, record } from '../audit/audit.js';
import { requireAdmin } from '../middleware/auth.js';
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
    await record({ ...fromReq(req), actorEmail: req.adminEmail, action: 'plan.created', detail: `${plan.key} "${plan.name}": ${describeLimits(plan.limits)}` });
    res.status(201).json({ plan });
  });

  router.put('/plans/:key', async (req, res) => {
    const plan = await updatePlan(req.params.key, req.body || {});
    await record({ ...fromReq(req), actorEmail: req.adminEmail, action: 'plan.updated', detail: `${plan.key} "${plan.name}": ${describeLimits(plan.limits)}` });
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

  return router;
}
