import { config } from '../config.js';
import { bad } from '../utils/http.js';

/**
 * The limits a plan can change. `platform` is the value from the server settings (.env), used when neither the
 * plan nor the account says otherwise, so accounts without a plan behave exactly as before.
 * Delays between messages are deliberately not here: they protect the sending numbers and are the same for everyone.
 */
export const LIMITS = {
  waDailyCap: { label: 'WhatsApp messages per day', max: 1_000_000, platform: () => config.dailyCap },
  waHourlyCap: { label: 'WhatsApp messages in any one hour', max: 100_000, platform: () => config.waHourlyCap },
  emailDailyCap: { label: 'Emails per day', max: 1_000_000, platform: () => config.emailDailyCap },
  waMaxUpload: { label: 'Contacts in one WhatsApp upload', max: 100_000, platform: () => config.maxContactsPerUpload },
  emailMaxUpload: { label: 'Contacts in one email upload', max: 100_000, platform: () => config.emailMaxContactsPerUpload },
  maxLists: { label: 'Saved contact lists', max: 10_000, platform: () => config.maxLists },
  maxListContacts: { label: 'Contacts in one saved list', max: 1_000_000, platform: () => config.maxListContacts },
  maxTemplates: { label: 'Saved message templates', max: 10_000, platform: () => config.maxTemplates },
  maxActiveCampaigns: { label: 'Unfinished campaigns per channel', max: 1_000, platform: () => config.maxActiveCampaigns },
  waAttachmentMb: { label: 'Largest WhatsApp attachment (MB)', max: 100, platform: () => config.waAttachmentMb },
  emailAttachmentMb: { label: 'Largest email attachment (MB)', max: 25, platform: () => config.emailAttachmentMb },
  storageMb: { label: 'Attachment storage (MB)', max: 100_000, platform: () => config.attachmentStorageMb },
};

export const LIMIT_KEYS = Object.keys(LIMITS);

/** The server-wide values right now. */
export const platformLimits = () => Object.fromEntries(LIMIT_KEYS.map((k) => [k, LIMITS[k].platform()]));

/** Only the known limits that hold a usable number (what the database may hold is checked loosely: old or odd values are ignored). */
export const onlyLimits = (stored) => Object.fromEntries(LIMIT_KEYS.filter((k) => Number.isInteger(stored?.[k]) && stored[k] >= 1).map((k) => [k, stored[k]]));

/**
 * Check limits sent by an administrator. Returns an object with just the limits that were given;
 * anything left out (or null) means "use the next level down". Throws a 400 for anything else.
 */
export function readLimits(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('Limits must be an object like { "waDailyCap": 200 }');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const def = LIMITS[key];
    if (!def) throw bad(`"${key}" is not a limit. The limits are: ${LIMIT_KEYS.join(', ')}.`);
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > def.max) {
      throw bad(`${def.label} (${key}) must be a whole number from 1 to ${def.max}`);
    }
    out[key] = value;
  }
  return out;
}

/** "waDailyCap=500, maxLists=5", or a note when nothing is set. For the audit log and messages. */
export const describeLimits = (limits) => {
  const parts = Object.entries(limits || {}).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(', ') : '(nothing set: platform defaults)';
};
