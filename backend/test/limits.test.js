import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMIT_KEYS, describeLimits, onlyLimits, platformLimits, readLimits } from '../src/plans/definitions.js';

test('readLimits keeps only what was given and checks every value', () => {
  assert.deepEqual(readLimits(undefined), {});
  assert.deepEqual(readLimits(null), {});
  assert.deepEqual(readLimits({ waDailyCap: 200, maxLists: null, maxTemplates: undefined }), { waDailyCap: 200 });
  for (const bad of [{ nope: 1 }, { waDailyCap: 0 }, { waDailyCap: -5 }, { waDailyCap: 1.5 }, { waDailyCap: '10' }, { waDailyCap: 1e9 }, [1], 'x']) {
    assert.throws(() => readLimits(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test('onlyLimits ignores unknown or unusable stored values', () => {
  assert.deepEqual(onlyLimits({ waDailyCap: 5, maxLists: 0, maxTemplates: 'x', junk: 3 }), { waDailyCap: 5 });
  assert.deepEqual(onlyLimits(undefined), {});
});

test('platformLimits has every key as a number, and describeLimits reads well', () => {
  const p = platformLimits();
  assert.deepEqual(Object.keys(p), LIMIT_KEYS);
  const NO_LIMIT_BY_DEFAULT = ['waLifetimeCap', 'emailLifetimeCap', 'monthlyCap']; // 0 = no limit
  for (const k of LIMIT_KEYS) assert.ok(Number.isInteger(p[k]) && (NO_LIMIT_BY_DEFAULT.includes(k) ? p[k] === 0 : p[k] > 0), k);
  assert.equal(describeLimits({ waDailyCap: 5, maxLists: 2 }), 'waDailyCap=5, maxLists=2');
  assert.match(describeLimits({}), /platform defaults/);
});
