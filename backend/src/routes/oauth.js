import { Router } from 'express';
import { fromReq, record } from '../audit/audit.js';
import { config } from '../config.js';
import { recordAcceptance } from '../legal/consent.js';
import { signToken } from '../middleware/auth.js';
import { User } from '../models.js';
import { normalizeEmail } from '../utils/contacts.js';
import { logger } from '../utils/logger.js';
import { authorizeUrl, enabledProviders, fetchProfile, makeState, PROVIDERS, readState, STATE_MINUTES } from '../utils/oauth.js';

const log = logger.child({ mod: 'oauth' });
const COOKIE = 'oauth_nonce';

const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
};
const cookieFlags = () => `Path=/api/auth/oauth; HttpOnly; SameSite=Lax${config.isProd ? '; Secure' : ''}`;

/** Back to the web app. The result travels in the #fragment, which browsers never send to any server or write in logs. */
const back = (res, params) => {
  res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags()}`);
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.redirect(302, `${config.appUrl}/auth/callback#${new URLSearchParams(params)}`);
};

/**
 * Sign in with Google or GitHub. The web app shows a button for each provider listed by GET /providers and sends the
 * browser to GET /:provider/start?intent=login|signup&terms=1.
 */
export function oauthRouter({ oauth: limiter } = {}) {
  const router = Router();
  const use = limiter ? [limiter] : [];

  router.get('/providers', (_req, res) => res.json({ providers: enabledProviders() }));

  router.get('/:provider/start', ...use, (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS[provider]) return res.status(404).json({ error: 'Not found' });
    if (!enabledProviders().includes(provider)) return back(res, { error: 'not_configured', provider });
    const { state, nonce } = makeState({ provider, intent: req.query.intent, terms: req.query.terms === '1' });
    res.append('Set-Cookie', `${COOKIE}=${nonce}; Max-Age=${STATE_MINUTES * 60}; ${cookieFlags()}`);
    res.set('Cache-Control', 'no-store');
    res.redirect(302, authorizeUrl(provider, state));
  });

  router.get('/:provider/callback', ...use, async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS[provider]) return res.status(404).json({ error: 'Not found' });
    const fail = (error) => back(res, { error, provider });

    const state = readState(req.query.state, provider);
    if (!state || !cookieOf(req, COOKIE) || cookieOf(req, COOKIE) !== state.nonce) return fail('bad_state');
    if (req.query.error) return fail(req.query.error === 'access_denied' ? 'denied' : 'provider_error'); // the person pressed Cancel
    if (typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 2000) return fail('provider_error');

    let profile;
    try {
      profile = await fetchProfile(provider, req.query.code);
    } catch (err) {
      log.warn({ provider, err: err.message }, 'sign-in with a provider failed');
      return fail('provider_error');
    }
    const email = normalizeEmail(profile.email);
    if (!profile.id || !email || !profile.emailVerified) return fail('no_verified_email');

    try {
      // 1. someone who signed in this way before
      let user = await User.findOne({ oauth: { $elemMatch: { provider, id: profile.id } } });
      let created = false;

      // 2. an existing account with the same (provider-confirmed) email: link it
      if (!user) {
        user = await User.findOne({ email });
        if (user) {
          await User.updateOne({ _id: user._id }, { $push: { oauth: { provider, id: profile.id } }, $set: { emailVerified: true, emailVerifiedAt: user.emailVerifiedAt || new Date() } });
          await record({ ...fromReq(req), actorId: user._id, actorEmail: user.email, action: 'oauth.linked', detail: provider });
        }
      }

      // 3. a new account: only from the sign-up side, with the Terms ticked
      if (!user) {
        if (state.intent !== 'signup') return back(res, { error: 'no_account', provider, email });
        if (config.requireTermsAcceptance && !state.terms) return back(res, { error: 'terms_required', provider });
        try {
          user = await User.create({ email, emailVerified: true, emailVerifiedAt: new Date(), oauth: [{ provider, id: profile.id }] });
        } catch (err) {
          if (err.code !== 11000) throw err;
          return fail('provider_error'); // two sign-ins at once
        }
        created = true;
        if (state.terms) await recordAcceptance(user._id, { via: 'register', ip: req.ip, userAgent: req.get('user-agent') }).catch((err) => log.error({ err: err.message }, 'could not record acceptance'));
      }

      if (user.suspendedAt) {
        await record({ ...fromReq(req), actorId: user._id, actorEmail: user.email, action: 'login.blocked', detail: 'account is suspended' });
        return fail('suspended');
      }
      await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
      await record({ ...fromReq(req), actorId: user._id, actorEmail: user.email, action: created ? 'oauth.signup' : 'oauth.login', detail: provider });
      return back(res, { token: signToken(user), email: user.email, provider });
    } catch (err) {
      log.error({ provider, err: err.message }, 'could not finish the provider sign-in');
      return fail('server_error');
    }
  });

  return router;
}
