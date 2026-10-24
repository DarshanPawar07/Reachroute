import { config } from '../config.js';
import { Consent } from '../models.js';
import { bad } from '../utils/http.js';
import { DOC_NAMES, getDocument } from './documents.js';

const clip = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** Write down that this account accepted the current version of each document named. Safe to repeat. */
export async function recordAcceptance(userId, { docs = DOC_NAMES, via, ip = '', userAgent = '' }) {
  for (const name of docs) {
    const doc = getDocument(name);
    await Consent.updateOne(
      { userId, doc: name, version: doc.version },
      { $setOnInsert: { textHash: doc.hash, via, ip: clip(ip, 64), userAgent: clip(userAgent, 200), acceptedAt: new Date() } },
      { upsert: true }
    );
  }
}

/** For each document: the current version, and whether (and when) this account accepted that exact version. */
export async function consentStatus(userId) {
  const rows = await Consent.find({ userId }).sort({ acceptedAt: -1 }).lean();
  const documents = DOC_NAMES.map((name) => {
    const doc = getDocument(name);
    const mine = rows.find((r) => r.doc === name && r.version === doc.version);
    const last = rows.find((r) => r.doc === name);
    return {
      doc: name,
      title: doc.title,
      currentVersion: doc.version,
      accepted: Boolean(mine),
      acceptedAt: mine?.acceptedAt || null,
      lastAcceptedVersion: last?.version || null,
    };
  });
  return { required: config.requireTermsAcceptance, documents, pending: documents.filter((d) => !d.accepted).map((d) => d.doc) };
}

/** Stops an account that has not accepted the current documents (when acceptance is required). */
export async function assertAcceptedTerms(userId) {
  if (!config.requireTermsAcceptance) return;
  const { pending } = await consentStatus(userId);
  if (pending.length) {
    throw Object.assign(bad('Please accept the current Terms of Service and Privacy Policy before starting a campaign.', 403), { code: 'terms_required' });
  }
}

/** The versions an accept request must name: it has to be the ones the person was shown. */
export function checkVersions(sent) {
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) throw bad('Send { "versions": { "terms": "...", "privacy": "..." } }');
  const names = Object.keys(sent);
  if (!names.length) throw bad('Name at least one document');
  for (const name of names) {
    if (!DOC_NAMES.includes(name)) throw bad(`"${name}" is not a document. The documents are: ${DOC_NAMES.join(', ')}.`);
    if (typeof sent[name] !== 'string') throw bad(`Give the version of "${name}" as text`);
    if (sent[name] !== getDocument(name).version) throw bad('These documents changed while you were reading. Reload them and accept again.', 409);
  }
  return names;
}
