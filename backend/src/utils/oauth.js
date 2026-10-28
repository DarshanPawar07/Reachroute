import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * "Continue with Google / GitHub", the standard authorization-code flow:
 *   1. the person is sent to the provider with a signed `state` (and the same random value in a short-lived cookie),
 *   2. the provider sends them back with a one-time `code`,
 *   3. we trade the code for their verified email address, and log them in (or create the account).
 * No password or provider token is kept: the access token is used once and thrown away.
 */
export const PROVIDERS = {
  google: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
  github: {
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
  },
};

export const STATE_MINUTES = 10;

/** Only providers whose id and secret are both set are offered. */
export const enabledProviders = () => Object.keys(PROVIDERS).filter((p) => config.oauth[p]?.clientId && config.oauth[p]?.clientSecret);
export const redirectUri = (provider) => `${config.publicUrl}/api/auth/oauth/${provider}/callback`;

const sign = (body) => createHmac('sha256', config.jwtSecret).update(`oauth-state|${body}`).digest('base64url');

/** `intent` is 'login' or 'signup'; `terms` says the person ticked the Terms box before pressing the button. */
export function makeState({ provider, intent, terms, now = Date.now() }) {
  const nonce = randomBytes(18).toString('base64url');
  const body = Buffer.from(JSON.stringify({ p: provider, i: intent === 'signup' ? 'signup' : 'login', t: terms === true, n: nonce, e: now + STATE_MINUTES * 60_000 })).toString('base64url');
  return { state: `${body}.${sign(body)}`, nonce };
}

/** The contents of a state we signed, or null when it was changed, expired, or is for another provider. */
export function readState(state, provider, now = Date.now()) {
  if (typeof state !== 'string' || state.length > 600) return null;
  const [body, mac, extra] = state.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.p !== provider || typeof data.e !== 'number' || data.e < now || typeof data.n !== 'string') return null;
    return { provider: data.p, intent: data.i, terms: data.t === true, nonce: data.n };
  } catch {
    return null;
  }
}

export function authorizeUrl(provider, state) {
  const p = PROVIDERS[provider];
  const q = new URLSearchParams({ client_id: config.oauth[provider].clientId, redirect_uri: redirectUri(provider), response_type: 'code', scope: p.scope, state });
  if (provider === 'google') q.set('prompt', 'select_account');
  if (provider === 'github') q.set('allow_signup', 'true');
  return `${p.authorizeUrl}?${q}`;
}

// Replaced in tests, so no real provider is contacted.
let doFetch = (...args) => fetch(...args);
export const useFetchForTests = (fn) => {
  doFetch = fn || ((...args) => fetch(...args));
};

async function json(res, what) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(`${what} failed (${res.status})`);
  return data;
}

/**
 * Trade the one-time code for who the person is: { id, email, emailVerified }.
 * Throws when the provider refuses, or when it gives no confirmed email address.
 */
export async function fetchProfile(provider, code) {
  const p = PROVIDERS[provider];
  const { clientId, clientSecret } = config.oauth[provider];
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri(provider), grant_type: 'authorization_code' });
  const tokenRes = await json(await doFetch(p.tokenUrl, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body }), `${p.label} token request`);
  const accessToken = tokenRes.access_token;
  if (typeof accessToken !== 'string' || !accessToken) throw new Error(`${p.label} gave no access token`);
  const auth = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'Reachroute' };

  if (provider === 'google') {
    const info = await json(await doFetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: auth }), 'Google profile request');
    return { id: String(info.sub || ''), email: String(info.email || '').toLowerCase(), emailVerified: info.email_verified === true || info.email_verified === 'true' };
  }

  // GitHub: the id is on /user, and the email must be the one marked primary AND verified (the public email is not trusted).
  const [me, emails] = await Promise.all([
    json(await doFetch('https://api.github.com/user', { headers: auth }), 'GitHub profile request'),
    json(await doFetch('https://api.github.com/user/emails', { headers: auth }), 'GitHub email request'),
  ]);
  const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : null;
  return { id: String(me.id || ''), email: String(primary?.email || '').toLowerCase(), emailVerified: Boolean(primary) };
}
