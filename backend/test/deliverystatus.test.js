import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL, readStatusUpdates } from '../src/whatsapp/deliveryStatus.js';

const upd = (id, status, fromMe = true) => ({ key: { id, fromMe }, update: { status } });

test('delivered and read are picked up, one tick (server ack) and errors are not', () => {
  const out = readStatusUpdates([upd('a', 2), upd('b', 3), upd('c', 4), upd('d', 5), upd('e', 0), upd('f', 1)]);
  assert.deepEqual([...out], [['b', 3], ['c', 4], ['d', 5]]);
  assert.equal(LEVEL.DELIVERED, 3);
  assert.equal(LEVEL.READ, 4);
});

test('only our own messages count', () => {
  assert.equal(readStatusUpdates([upd('a', 3, false)]).size, 0);
});

test('names work as well as numbers, and the highest level in a batch wins', () => {
  const out = readStatusUpdates([upd('a', 'DELIVERY_ACK'), upd('a', 'READ'), upd('a', 'DELIVERY_ACK'), upd('b', 'SERVER_ACK')]);
  assert.deepEqual([...out], [['a', 4]]);
});

test('rubbish in, nothing out', () => {
  assert.equal(readStatusUpdates(undefined).size, 0);
  assert.equal(readStatusUpdates([null, {}, { key: {} }, { key: { id: 'x', fromMe: true } }, upd('y', 'WHATEVER'), upd('z', {})]).size, 0);
});
