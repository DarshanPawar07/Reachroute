const FATAL_CODES = new Set(['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND', 'ETLS', 'ECONNRESET']);

// Responses that really mean "this mailbox does not exist" (as opposed to a spam block or policy refusal).
const NO_SUCH_MAILBOX = /user unknown|no such user|does not exist|unknown user|mailbox (unavailable|not found)|invalid (recipient|mailbox|address)|recipient (rejected|address rejected)|5\.1\.[1-6]/i;

/**
 * Sorts an SMTP/nodemailer error into what the engine should do next:
 *   'fatal'     the connection or login is broken: pause the whole campaign
 *   'transient' 4xx, e.g. greylisting or a full mailbox: try this recipient again later
 *   'bounce'    the address does not exist: fail it and never email it again
 *   'rejected'  other permanent refusal: fail this recipient only
 */
export function classifySmtpError(err) {
  if (FATAL_CODES.has(err.code) || err.responseCode === 535 || err.responseCode === 534) return 'fatal';
  const code = Number(err.responseCode);
  if (code >= 400 && code < 500) return 'transient';
  if (code >= 500 && NO_SUCH_MAILBOX.test(String(err.response || err.message))) return 'bounce';
  return 'rejected';
}

/** A short, plain-language reason for an SMTP failure, safe to show to the user. */
export function describeSmtpError(err) {
  if (err.code === 'EAUTH' || err.responseCode === 535 || err.responseCode === 534) {
    return 'The server rejected the username or password. Gmail and Outlook need an app password, not your normal one.';
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'EDNS'].includes(err.code)) {
    return 'Could not reach that server. Check the host name and port.';
  }
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNRESET'].includes(err.code)) {
    return 'The connection timed out or was closed. Check the port and the SSL/TLS setting (465 uses SSL/TLS, 587 does not).';
  }
  if (err.code === 'ETLS' || /wrong version number|ssl|tls/i.test(String(err.message))) {
    return 'The secure connection failed. Try switching the SSL/TLS setting (on for port 465, off for 587).';
  }
  const text = String(err.response || err.message || 'Unknown error').replace(/\s+/g, ' ').trim();
  return text.slice(0, 200);
}
