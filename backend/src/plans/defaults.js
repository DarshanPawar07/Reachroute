import { Plan } from '../models.js';

/**
 * The plans every install starts with. They are only created when missing: once an administrator has changed
 * a plan in Admin > Plans, restarting the server never puts the original numbers back.
 * (Prices are in rupees. Free has none; "Business" is arranged by hand and has no entry here.)
 */
export const DEFAULT_PLANS = [
  {
    key: 'free',
    name: 'Free',
    tagline: 'Try Reachroute with real messages. Not refilled.',
    sortOrder: 10,
    priceMonthly: 0,
    priceYearly: 0,
    limits: {
      waLifetimeCap: 50, emailLifetimeCap: 100,
      waDailyCap: 50, waHourlyCap: 10, emailDailyCap: 100,
      maxActiveCampaigns: 1, waMaxUpload: 50, emailMaxUpload: 50,
      maxLists: 3, maxListContacts: 500, maxTemplates: 5,
      waAttachmentMb: 5, emailAttachmentMb: 5, storageMb: 20,
    },
  },
  {
    key: 'pro',
    name: 'Pro',
    tagline: 'For a business that messages its customers every week.',
    sortOrder: 20,
    priceMonthly: 699,
    priceYearly: 6990,
    limits: {
      waDailyCap: 200, waHourlyCap: 40, emailDailyCap: 400, monthlyCap: 5000,
      maxActiveCampaigns: 3, waMaxUpload: 200, emailMaxUpload: 500,
      maxLists: 20, maxListContacts: 5000, maxTemplates: 50,
      waAttachmentMb: 16, emailAttachmentMb: 10, storageMb: 200,
    },
  },
  {
    key: 'premium',
    name: 'Premium',
    tagline: 'For teams that send every day.',
    sortOrder: 30,
    priceMonthly: 1499,
    priceYearly: 14990,
    limits: {
      waDailyCap: 500, waHourlyCap: 60, emailDailyCap: 1000, monthlyCap: 20000,
      maxActiveCampaigns: 10, waMaxUpload: 500, emailMaxUpload: 2000,
      maxLists: 100, maxListContacts: 20000, maxTemplates: 200,
      waAttachmentMb: 16, emailAttachmentMb: 20, storageMb: 1000,
    },
  },
];

/** Create the starting plans that do not exist yet. Returns the keys that were created. */
export async function ensureDefaultPlans() {
  const made = [];
  for (const plan of DEFAULT_PLANS) {
    const r = await Plan.updateOne({ key: plan.key }, { $setOnInsert: plan }, { upsert: true });
    if (r.upsertedCount) made.push(plan.key);
  }
  return made;
}
