import { Plan, User } from '../models.js';
import { LIMITS, LIMIT_KEYS, onlyLimits, platformLimits } from './definitions.js';

/**
 * What one account may do. The answer is built from three levels, the last one that sets a value wins:
 *   1. the server settings (.env), 2. the account's plan, 3. limits set for this account alone.
 * The plan and the account's own limits are remembered for a few seconds, so a busy account does not cost a
 * database read per message. Changes made through the admin area clear the memory on the instance that made
 * them; on other instances they show within CACHE_MS. Server settings are read fresh every time.
 */

const CACHE_MS = 15_000;
const MAX_CACHED = 5000;
const cache = new Map(); // userId -> { at, key, name, planLimits, overrides }

export const forgetLimits = (userId) => cache.delete(String(userId));
export const forgetAllLimits = () => cache.clear();

async function load(userId) {
  const id = String(userId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const user = await User.findById(id).select('planKey limitOverrides').lean();
  const plan = user?.planKey ? await Plan.findOne({ key: user.planKey }).select('key name limits').lean() : null; // a plan that no longer exists counts as no plan
  const entry = {
    at: Date.now(),
    key: plan ? plan.key : 'default',
    name: plan ? plan.name : 'Default',
    planLimits: onlyLimits(plan?.limits),
    overrides: onlyLimits(user?.limitOverrides),
  };
  cache.set(id, entry);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return entry;
}

/** { plan: { key, name }, limits (everything, ready to use), planLimits (only what the plan sets), overrides (only what is set for this account) } */
export async function resolveLimits(userId) {
  const e = await load(userId);
  return { plan: { key: e.key, name: e.name }, limits: { ...platformLimits(), ...e.planLimits, ...e.overrides }, planLimits: e.planLimits, overrides: e.overrides };
}

/** The numbers a send engine needs for one account. */
export async function engineLimits(channel, userId) {
  const { limits } = await resolveLimits(userId);
  return channel === 'whatsapp'
    ? { dailyCap: limits.waDailyCap, hourlyCap: limits.waHourlyCap, maxActive: limits.maxActiveCampaigns }
    : { dailyCap: limits.emailDailyCap, hourlyCap: undefined, maxActive: limits.maxActiveCampaigns };
}

/** Every limit with its meaning, its value, and where the value comes from ("account", "plan" or "default"), for screens. */
export async function limitTable(userId) {
  const r = await resolveLimits(userId);
  return {
    plan: r.plan,
    limits: LIMIT_KEYS.map((key) => ({
      key,
      label: LIMITS[key].label,
      value: r.limits[key],
      source: key in r.overrides ? 'account' : key in r.planLimits ? 'plan' : 'default',
    })),
  };
}
