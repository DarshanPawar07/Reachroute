import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearBanSignals, isBanSignal, noteBanSignal, restrictedReason, RESTRICTED_PREFIX } from '../src/whatsapp/restriction.js';

test('which errors count as "WhatsApp refused this number"', () => {
  assert.equal(isBanSignal({ output: { statusCode: 403 }, message: 'x' }), true);
  assert.equal(isBanSignal({ statusCode: 403 }), true);
  assert.equal(isBanSignal({ data: '403' }), true);
  assert.equal(isBanSignal(new Error('Forbidden')), true);
  assert.equal(isBanSignal(new Error('this account is banned')), true);
  assert.equal(isBanSignal(new Error('account temporarily restricted')), true);
  for (const e of [new Error('Timed Out'), new Error('Connection Closed'), { output: { statusCode: 500 } }, { output: { statusCode: 401 } }, null, undefined, new Error('not-authorized')]) {
    assert.equal(isBanSignal(e), false, String(e?.message ?? e));
  }
});

test('one refusal is not enough; two close together are', () => {
  const user = 'u-signal-1';
  clearBanSignals(user);
  const t = 1_000_000;
  assert.equal(noteBanSignal(user, t), false);
  assert.equal(noteBanSignal(user, t + 60_000), true);
  clearBanSignals(user);
  assert.equal(noteBanSignal(user, t), false);
  assert.equal(noteBanSignal(user, t + 11 * 60_000), false, 'the first one is too old to count');
  assert.equal(noteBanSignal(user, t + 12 * 60_000), true);
});

test('refusals are counted per account', () => {
  clearBanSignals('a1');
  clearBanSignals('b1');
  assert.equal(noteBanSignal('a1', 5), false);
  assert.equal(noteBanSignal('b1', 6), false);
});

test('the pause text names the number and how to continue', () => {
  const text = restrictedReason('919100000001');
  assert.ok(text.startsWith(RESTRICTED_PREFIX));
  assert.match(text, /\+919100000001/);
  assert.match(text, /24 hours/);
  assert.match(text, /different WhatsApp number/);
  assert.match(restrictedReason(''), /this number/);
});
