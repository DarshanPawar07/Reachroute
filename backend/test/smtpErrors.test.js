import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySmtpError, describeSmtpError } from '../src/utils/smtpErrors.js';

const err = (props) => Object.assign(new Error(props.message || 'smtp error'), props);

test('broken login or connection is fatal (pauses the whole campaign)', () => {
  for (const props of [{ code: 'EAUTH' }, { code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }, { code: 'ENOTFOUND' }, { responseCode: 535 }, { responseCode: 534 }]) {
    assert.equal(classifySmtpError(err(props)), 'fatal', JSON.stringify(props));
  }
});

test('4xx replies are temporary and get retried later', () => {
  for (const responseCode of [421, 450, 451, 452]) assert.equal(classifySmtpError(err({ responseCode })), 'transient');
});

test('a mailbox that does not exist is a bounce', () => {
  assert.equal(classifySmtpError(err({ responseCode: 550, response: '550 5.1.1 The email account that you tried to reach does not exist' })), 'bounce');
  assert.equal(classifySmtpError(err({ responseCode: 550, response: '550 User unknown' })), 'bounce');
  assert.equal(classifySmtpError(err({ responseCode: 553, response: '553 invalid recipient' })), 'bounce');
});

test('a spam or policy refusal is NOT treated as a bounce', () => {
  assert.equal(classifySmtpError(err({ responseCode: 550, response: '550 5.7.1 message blocked as spam' })), 'rejected');
  assert.equal(classifySmtpError(err({ responseCode: 554, response: '554 Transaction failed' })), 'rejected');
});

test('unknown errors only fail the one recipient', () => {
  assert.equal(classifySmtpError(err({ message: 'something odd' })), 'rejected');
});

test('descriptions are short, plain and never throw', () => {
  assert.match(describeSmtpError(err({ code: 'EAUTH' })), /app password/);
  assert.match(describeSmtpError(err({ code: 'ECONNREFUSED' })), /host name and port/);
  assert.match(describeSmtpError(err({ code: 'ETIMEDOUT' })), /SSL\/TLS/);
  assert.ok(describeSmtpError(err({ response: 'x'.repeat(1000) })).length <= 200);
  assert.ok(describeSmtpError({}).length > 0);
});
