import { config } from '../config.js';
import { emailEngine, whatsappEngine } from '../engine/channels.js';
import { forgetUser } from '../middleware/auth.js';
import { describeLimits, onlyLimits, platformLimits, readLimits } from '../plans/definitions.js';
import { forgetAllLimits, forgetLimits, resolveLimits } from '../plans/limits.js';
import { collectQueueStats } from '../monitoring/ops.js';
import {
  Campaign, Consent, ContactList, EmailCampaign, EmailOptOut, EmailRecipient, OptOut, Plan, Recipient, SessionLease, SmtpSettings, Template, User,
} from '../models.js';
import { bad } from '../utils/http.js';
import { isVerified } from '../utils/authTokens.js';

/**
 * What an administrator can see and do with accounts. Administrators see account details and usage numbers only:
 * never passwords, tokens, secrets, message texts or the contacts people upload.
 */

const DAY = 24 * 60 * 60_000;
const MAX_REASON = 300;
const STATUS_FILTERS = new Set(['', 'active', 'suspended', 'admin', 'unverified']);
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const count = (query) => query.maxTimeMS(5000);
const sentSince = (Model, since, userId = null) => count(Model.countDocuments({ ...(userId ? { userId } : {}), status: 'sent', sentAt: { $gte: since } }));

const row = (u) => ({
  id: u._id,
  email: u.email,
  role: u.role || 'user',
  emailVerified: isVerified(u),
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt || null,
  suspendedAt: u.suspendedAt || null,
  suspendedReason: u.suspendedReason || '',
  plan: u.planKey || 'default',
});
const ROW_FIELDS = 'email role emailVerified createdAt lastLoginAt suspendedAt suspendedReason planKey';

// ---------------------------------------------------------------- reading

/** Platform-wide numbers for the admin home page. */
export async function overview(now = Date.now()) {
  const day = new Date(now - DAY);
  const week = new Date(now - 7 * DAY);
  const [total, newDay, newWeek, activeWeek, unverified, suspended, admins, waSent, emailSent, linked, queue] = await Promise.all([
    count(User.countDocuments({})),
    count(User.countDocuments({ createdAt: { $gte: day } })),
    count(User.countDocuments({ createdAt: { $gte: week } })),
    count(User.countDocuments({ lastLoginAt: { $gte: week } })),
    count(User.countDocuments({ emailVerified: false })),
    count(User.countDocuments({ suspendedAt: { $ne: null } })),
    count(User.countDocuments({ role: 'admin' })),
    sentSince(Recipient, day),
    sentSince(EmailRecipient, day),
    count(SessionLease.countDocuments({ status: 'connected', expiresAt: { $gt: new Date(now) } })),
    collectQueueStats({ now }),
  ]);
  return {
    users: { total, newLast24h: newDay, newLast7d: newWeek, activeLast7d: activeWeek, unverified, suspended, admins },
    sentLast24h: { whatsapp: waSent, email: emailSent },
    whatsappLinked: linked,
    queue,
  };
}

/** A page of accounts. `search` matches part of the email address (typed text is never treated as a pattern). */
export async function listUsers({ search = '', status = '', sort = 'newest', page = 1, limit = 25 } = {}) {
  const text = String(search).trim().toLowerCase();
  if (text.length > 100) throw bad('That search is too long');
  if (!STATUS_FILTERS.has(status)) throw bad('Status must be active, suspended, admin or unverified');
  if (sort !== 'newest' && sort !== 'oldest') throw bad('Sort must be newest or oldest');
  const size = Math.min(100, Math.max(1, Number(limit) || 25));
  const pageNo = Math.max(1, Math.floor(Number(page)) || 1);

  const filter = {};
  if (text) filter.email = { $regex: escapeRegex(text) };
  if (status === 'active') filter.suspendedAt = null;
  if (status === 'suspended') filter.suspendedAt = { $ne: null };
  if (status === 'admin') filter.role = 'admin';
  if (status === 'unverified') filter.emailVerified = false;
  const direction = sort === 'oldest' ? 1 : -1;

  const [total, users] = await Promise.all([
    count(User.countDocuments(filter)),
    User.find(filter).sort({ createdAt: direction, _id: direction }).skip((pageNo - 1) * size).limit(size).select(ROW_FIELDS).maxTimeMS(5000).lean(),
  ]);
  return { users: users.map(row), total, page: pageNo, pages: Math.max(1, Math.ceil(total / size)), limit: size };
}

const recent = (Model, userId) =>
  Model.find({ userId, status: { $ne: 'preparing' } })
    .sort({ createdAt: -1 })
    .limit(5)
    .select('name status total sentCount failedCount createdAt pauseReason')
    .lean();

async function channelUsage(Campaigns, Recipients, userId, now) {
  const [total, running, paused, sent24h, sent7d, latest] = await Promise.all([
    count(Campaigns.countDocuments({ userId })),
    count(Campaigns.countDocuments({ userId, status: 'running' })),
    count(Campaigns.countDocuments({ userId, status: 'paused' })),
    sentSince(Recipients, new Date(now - DAY), userId),
    sentSince(Recipients, new Date(now - 7 * DAY), userId),
    recent(Campaigns, userId),
  ]);
  return { campaigns: { total, running, paused }, sentLast24h: sent24h, sentLast7d: sent7d, recentCampaigns: latest };
}

/** One account: who they are and how they use the app. Counts and names of campaigns, never their contents. */
export async function accountDetail(userId, now = Date.now()) {
  const user = await User.findById(userId).select(`${ROW_FIELDS} failedLogins lockedUntil`).lean();
  if (!user) throw bad('Not found', 404);
  const [whatsapp, email, lists, templates, smtp, lease, waOptOuts, emailOptOuts, plan, consents] = await Promise.all([
    channelUsage(Campaign, Recipient, userId, now),
    channelUsage(EmailCampaign, EmailRecipient, userId, now),
    count(ContactList.countDocuments({ userId })),
    count(Template.countDocuments({ userId })),
    SmtpSettings.findOne({ userId }).select('host fromEmail').lean(), // never the password
    SessionLease.findById(String(userId)).select('status expiresAt').lean(),
    count(OptOut.countDocuments({ userId })),
    count(EmailOptOut.countDocuments({ userId })),
    resolveLimits(userId),
    Consent.find({ userId }).sort({ acceptedAt: -1 }).limit(20).select('doc version via acceptedAt').lean(),
  ]);
  const online = lease && lease.expiresAt > new Date(now);
  return {
    user: { ...row(user), lockedUntil: user.lockedUntil && user.lockedUntil > new Date(now) ? user.lockedUntil : null },
    consents: consents.map((c) => ({ doc: c.doc, version: c.version, via: c.via, acceptedAt: c.acceptedAt })),
    plan: plan.plan,
    limits: plan.limits, // what applies to this account right now
    overrides: plan.overrides, // only what is set for this account alone
    usage: {
      lists,
      templates,
      whatsapp: { ...whatsapp, session: online ? lease.status : 'offline', stopped: waOptOuts },
      email: { ...email, ownSmtp: smtp ? { host: smtp.host, fromEmail: smtp.fromEmail } : null, stopped: emailOptOuts },
    },
  };
}

// ---------------------------------------------------------------- changing

async function mustExist(userId) {
  const user = await User.findById(userId).select('email role suspendedAt').lean();
  if (!user) throw bad('Not found', 404);
  return user;
}

/**
 * Suspend an account: it is signed out everywhere, cannot log in, and its running campaigns are paused (nothing is deleted).
 * On other server instances the old login keeps working for a few seconds at most.
 */
export async function suspendUser(userId, reason = '') {
  const text = String(reason ?? '').trim();
  if (text.length > MAX_REASON) throw bad(`The reason can be at most ${MAX_REASON} characters`);
  const user = await mustExist(userId);
  if (user.role === 'admin') throw bad('Administrators cannot be suspended. Remove the admin role first (npm run make-admin -- <email> --remove).', 403);
  const changed = await User.findOneAndUpdate(
    { _id: userId, suspendedAt: null },
    { $set: { suspendedAt: new Date(), suspendedReason: text }, $inc: { tokenVersion: 1 } },
    { returnDocument: 'after' }
  );
  if (!changed) throw bad('That account is already suspended', 409);
  forgetUser(userId);
  const why = 'Paused because the account was suspended by an administrator.';
  const [wa, mail] = await Promise.all([whatsappEngine.pauseAllForUser(userId, why), emailEngine.pauseAllForUser(userId, why)]);
  return { email: changed.email, pausedCampaigns: wa + mail };
}

/** Let a suspended account log in again. Campaigns that were paused stay paused until the owner resumes them. */
export async function unsuspendUser(userId) {
  const changed = await User.findOneAndUpdate({ _id: userId, suspendedAt: { $ne: null } }, { $set: { suspendedAt: null, suspendedReason: '' } }, { returnDocument: 'after' });
  if (!changed) {
    await mustExist(userId);
    throw bad('That account is not suspended', 409);
  }
  return { email: changed.email };
}

/** Sign the account out of every device. */
export async function forceLogout(userId) {
  const changed = await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } }, { returnDocument: 'after' });
  if (!changed) throw bad('Not found', 404);
  forgetUser(userId);
  return { email: changed.email };
}

/** Mark the email address as confirmed (for example when someone cannot receive the link). */
export async function markVerified(userId) {
  const user = await mustExist(userId);
  await User.updateOne({ _id: userId }, { $set: { emailVerified: true, emailVerifiedAt: new Date() } });
  return { email: user.email };
}

/** Give or remove the admin role by email address. Only the command line uses this. Returns the account, or null when there is none. */
export async function setRole(email, role) {
  if (role !== 'admin' && role !== 'user') throw bad('Role must be admin or user');
  const user = await User.findOneAndUpdate({ email: String(email).trim().toLowerCase() }, { $set: { role } }, { returnDocument: 'after' });
  return user ? { id: user._id, email: user.email, role: user.role } : null;
}

// ---------------------------------------------------------------- plans and limits

const PLAN_KEY = /^[a-z0-9][a-z0-9-]{1,29}$/;
export const isPlanKey = (key) => PLAN_KEY.test(key);

const planRow = (plan, users) => ({
  key: plan.key,
  name: plan.name,
  builtIn: false,
  tagline: plan.tagline || '',
  priceMonthly: plan.priceMonthly || 0,
  priceYearly: plan.priceYearly || 0,
  listed: plan.listed !== false,
  sortOrder: plan.sortOrder ?? 100,
  limits: onlyLimits(plan.limits), // only what the plan sets; the rest comes from the platform defaults
  effective: { ...platformLimits(), ...onlyLimits(plan.limits) },
  users,
});

/** The default plan (the server settings) first, then every plan an administrator made, each with how many accounts use it. */
export async function listPlans() {
  const [plans, perPlan, total] = await Promise.all([
    Plan.find({}).sort({ key: 1 }).lean(),
    User.aggregate([{ $match: { planKey: { $type: 'string' } } }, { $group: { _id: '$planKey', n: { $sum: 1 } } }]).option({ maxTimeMS: 5000 }),
    count(User.countDocuments({})),
  ]);
  const used = new Map(perPlan.map((p) => [p._id, p.n]));
  const onPlans = plans.reduce((n, p) => n + (used.get(p.key) || 0), 0);
  return {
    plans: [
      { key: 'default', name: 'Default', builtIn: true, limits: {}, effective: platformLimits(), users: Math.max(0, total - onPlans) },
      ...plans.map((p) => planRow(p, used.get(p.key) || 0)),
    ],
  };
}

function readPlanName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 60) throw bad('Give the plan a name of 1 to 60 characters');
  return name;
}

const readPrice = (v, label) => {
  const n = Number(v ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw bad(`${label} must be a whole number of rupees, 0 or more`);
  return n;
};
/** The optional plan details (prices, tagline, visibility, order) that were sent. */
function readExtras(b) {
  const out = {};
  if (b.priceMonthly !== undefined) out.priceMonthly = readPrice(b.priceMonthly, 'The monthly price');
  if (b.priceYearly !== undefined) out.priceYearly = readPrice(b.priceYearly, 'The yearly price');
  if (b.tagline !== undefined) out.tagline = String(b.tagline ?? '').trim().slice(0, 140);
  if (b.listed !== undefined) out.listed = b.listed === true;
  if (b.sortOrder !== undefined) {
    const n = Number(b.sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw bad('The order must be a whole number from 0 to 10000');
    out.sortOrder = n;
  }
  return out;
}

export async function createPlan({ key, name, limits, ...extras }) {
  const k = String(key ?? '').trim().toLowerCase();
  if (k === 'default') throw bad('"default" is the built-in plan and cannot be changed. Choose another key.');
  if (!PLAN_KEY.test(k)) throw bad('The plan key must be 2 to 30 characters: lowercase letters, numbers and hyphens, starting with a letter or number');
  const doc = { key: k, name: readPlanName(name), limits: readLimits(limits), ...readExtras(extras) };
  try {
    const plan = await Plan.create(doc);
    return planRow(plan.toObject(), 0);
  } catch (err) {
    if (err.code === 11000) throw bad(`There is already a plan with the key "${k}"`, 409);
    throw err;
  }
}

/** Change a plan's name and/or its limits (the limits you send replace the old ones). Everyone on the plan gets the change. */
export async function updatePlan(key, { name, limits, ...extras }) {
  const more = readExtras(extras);
  if (name === undefined && limits === undefined && !Object.keys(more).length) throw bad('Send something to change');
  const set = { ...more };
  if (name !== undefined) set.name = readPlanName(name);
  if (limits !== undefined) set.limits = readLimits(limits);
  const plan = await Plan.findOneAndUpdate({ key }, { $set: set }, { returnDocument: 'after' }).lean();
  if (!plan) throw bad('No plan with that key', 404);
  forgetAllLimits();
  return planRow(plan, await count(User.countDocuments({ planKey: key })));
}

/** Remove a plan nobody is on. */
export async function deletePlan(key) {
  const plan = await Plan.findOne({ key }).lean();
  if (!plan) throw bad('No plan with that key', 404);
  if (key === config.defaultPlanKey) throw bad('New accounts start on this plan (DEFAULT_PLAN_KEY). Change that setting first.', 409);
  const users = await count(User.countDocuments({ planKey: key }));
  if (users) throw bad(`${users} account${users === 1 ? ' is' : 's are'} on this plan. Move them to another plan first.`, 409);
  await Plan.deleteOne({ key });
  forgetAllLimits();
  return { key, name: plan.name };
}

/** Put an account on a plan ("default" or null = the built-in plan). Returns the email and the old and new plan. */
export async function setUserPlan(userId, planKey) {
  const wanted = planKey === null || planKey === undefined || planKey === 'default' ? null : String(planKey);
  if (wanted !== null && !(await Plan.exists({ key: wanted }))) throw bad('No plan with that key', 404);
  const before = await User.findByIdAndUpdate(userId, wanted ? { $set: { planKey: wanted } } : { $set: { planKey: null } }, { returnDocument: 'before' }).select('email planKey').lean();
  if (!before) throw bad('Not found', 404);
  forgetLimits(userId);
  return { email: before.email, from: before.planKey || 'default', to: wanted || 'default' };
}

/** Set limits for one account alone, on top of its plan. The limits you send replace the old ones; {} clears them. */
export async function setUserLimits(userId, limits) {
  const overrides = readLimits(limits);
  const update = Object.keys(overrides).length ? { $set: { limitOverrides: overrides } } : { $unset: { limitOverrides: 1 } };
  const user = await User.findByIdAndUpdate(userId, update, { returnDocument: 'after' }).select('email').lean();
  if (!user) throw bad('Not found', 404);
  forgetLimits(userId);
  return { email: user.email, overrides, text: describeLimits(overrides) };
}
