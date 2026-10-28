import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeState, readState, authorizeUrl, redirectUri, enabledProviders, fetchProfile, useFetchForTests } = await import('../src/utils/oauth.js');
const { config } = await import('../src/config.js');

config.oauth.google = { clientId: 'gid', clientSecret: 'gsecret' };
config.oauth.github = { clientId: '', clientSecret: '' };

test('only providers with an id and a secret are offered', () => {
  assert.deepEqual(enabledProviders(), ['google']);
});

test('a state we made reads back; a changed, expired, wrong-provider or malformed one does not', () => {
  const { state, nonce } = makeState({ provider: 'google', intent: 'signup', terms: true });
  assert.deepEqual(readState(state, 'google'), { provider: 'google', intent: 'signup', terms: true, nonce });
  assert.equal(readState(state, 'github'), null, 'for another provider');
  const [body, mac] = state.split('.');
  assert.equal(readState(`${body}.${mac.slice(0, -2)}xx`, 'google'), null, 'signature changed');
  const forged = Buffer.from(JSON.stringify({ p: 'google', i: 'signup', t: true, n: nonce, e: Date.now() + 1e6 })).toString('base64url');
  assert.equal(readState(`${forged}.${mac}`, 'google'), null, 'body changed');
  assert.equal(readState(state, 'google', Date.now() + 11 * 60_000), null, 'expired');
  for (const junk of [undefined, '', 'abc', 'a.b.c', 42, 'x'.repeat(700)]) assert.equal(readState(junk, 'google'), null);
});

test('intent and terms default to the safe values', () => {
  const a = readState(makeState({ provider: 'google', intent: 'whatever' }).state, 'google');
  assert.equal(a.intent, 'login');
  assert.equal(a.terms, false);
  assert.equal(readState(makeState({ provider: 'google', intent: 'signup', terms: 'yes' }).state, 'google').terms, false, 'only a real true counts');
});

test('the address sent to the provider carries the id, the callback and the state', () => {
  const url = new URL(authorizeUrl('google', 'STATE'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'gid');
  assert.equal(url.searchParams.get('state'), 'STATE');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri('google'));
  assert.match(redirectUri('google'), /\/api\/auth\/oauth\/google\/callback$/);
  assert.ok(!url.searchParams.has('client_secret'), 'the secret never goes to the browser');
});

const reply = (data, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => data });

test('Google: the profile comes from the userinfo address, and email_verified is respected', async () => {
  const calls = [];
  useFetchForTests(async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('token')) return reply({ access_token: 'tok' });
    return reply({ sub: '123', email: 'Asha@Example.com', email_verified: true });
  });
  assert.deepEqual(await fetchProfile('google', 'code'), { id: '123', email: 'asha@example.com', emailVerified: true });
  assert.equal(calls.length, 2);

  useFetchForTests(async (url) => (String(url).includes('token') ? reply({ access_token: 'tok' }) : reply({ sub: '1', email: 'a@b.co', email_verified: false })));
  assert.equal((await fetchProfile('google', 'code')).emailVerified, false);
  useFetchForTests();
});

test('GitHub: only the primary AND verified email is used', async () => {
  config.oauth.github = { clientId: 'x', clientSecret: 'y' };
  const emails = [
    { email: 'old@example.com', primary: false, verified: true },
    { email: 'main@example.com', primary: true, verified: true },
  ];
  useFetchForTests(async (url) => {
    const u = String(url);
    if (u.includes('access_token')) return reply({ access_token: 'tok' });
    if (u.endsWith('/user/emails')) return reply(emails);
    return reply({ id: 77, email: 'public@example.com' });
  });
  assert.deepEqual(await fetchProfile('github', 'code'), { id: '77', email: 'main@example.com', emailVerified: true });

  emails[1].verified = false;
  const p = await fetchProfile('github', 'code');
  assert.equal(p.emailVerified, false, 'an unverified primary is not trusted, and the public email is ignored');
  assert.equal(p.email, '');
  useFetchForTests();
});

test('a provider refusing the code is an error, not a login', async () => {
  useFetchForTests(async () => reply({ error: 'bad_verification_code' }, false));
  await assert.rejects(() => fetchProfile('google', 'code'), /token request failed/);
  useFetchForTests(async () => reply({}));
  await assert.rejects(() => fetchProfile('google', 'code'), /no access token/);
  useFetchForTests();
});
