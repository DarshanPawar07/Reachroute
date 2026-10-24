// Pure helpers for reading replies: no database, no network.

/** Turn the text of a reply into what the person actually wrote: no quoted earlier mail, no signature, at most 2000 characters. */
export function cleanReplyText(raw) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // "On Mon, 3 Nov 2026, Asha <a@x.com> wrote:" (the line may be wrapped onto the next one)
    if (/^On .{5,200}$/i.test(line) && (/wrote:\s*$/i.test(line) || /^\s*.{0,100}wrote:\s*$/i.test(lines[i + 1] || ''))) break;
    if (/^-{2,}\s*(original message|forwarded message)/i.test(line) || /^_{5,}$/.test(line.trim())) break;
    if (/^(from|sent):\s.+/i.test(line) && /^(sent|to|date|subject):\s/i.test(lines[i + 1] || '')) break; // Outlook style header block
    if (/^--\s?$/.test(line)) break; // signature
    if (/^\s*>/.test(line)) continue; // quoted line
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
}

const STRONG = /\b(unsubscribe|opt[\s-]?out|remove me|take me off|stop (emailing|sending|mailing|contacting|messaging)|(do not|don'?t|dont) (email|mail|contact|message) me|no more (emails|mails))\b/i;
const SOLO_STOP = /^\s*(please\s+)?stop[\s.!]*$/i;

/** Does a short reply ask not to be emailed again? Long replies are left to the owner to read. */
export function looksLikeOptOut(cleaned) {
  const text = String(cleaned || '');
  return text.length > 0 && text.length <= 300 && (STRONG.test(text) || SOLO_STOP.test(text));
}

const ROBOT_SENDERS = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce[s]?|notifications?)(\+.*)?@/i;
const ROBOT_SUBJECTS = /^\s*((automatic|auto)[\s-]*(reply|response)|out of office|undeliver|delivery (status|failure|has failed)|mail delivery|returned mail|failure notice)/i;

/** Robots (out-of-office, bounces, newsletters) are not replies from a person. `headers` has lower-case names. */
export function isAutoReply({ from = '', subject = '', headers = {} }) {
  const auto = String(headers['auto-submitted'] || '').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (/^(bulk|junk|auto_reply|list)$/i.test(String(headers.precedence || '').trim())) return true;
  if (headers['x-autoreply'] || headers['x-autorespond'] || headers['list-id'] || headers['list-unsubscribe']) return true;
  if (/multipart\/report/i.test(String(headers['content-type'] || ''))) return true;
  return ROBOT_SENDERS.test(from) || ROBOT_SUBJECTS.test(subject);
}

/** A short, plain explanation of why the mailbox could not be read. Never includes the password. */
export function describeImapError(err) {
  if (err?.code === 'IMAP_MODULES_MISSING') return 'Reading replies needs the "imapflow" and "mailparser" packages on the server (run npm install).';
  if (err?.authenticationFailed || /auth|login|credentials|invalid/i.test(String(err?.responseText || '')) && err?.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return 'The mailbox refused the login. Check the user name and password (Gmail, Outlook and Yahoo need an app password, and IMAP must be turned on).';
  }
  switch (err?.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'The IMAP host was not found. Check the spelling.';
    case 'ECONNREFUSED':
      return 'The IMAP server refused the connection. Check the port and the SSL setting (993 with SSL is usual).';
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'NoConnection':
      return 'Could not reach the IMAP server in time. Check the host and port.';
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return 'The server did not answer in SSL. Turn the SSL setting off for port 143, or use port 993 with SSL on.';
  }
  if (/certificate|self.signed|CERT_/i.test(String(err?.code || '') + String(err?.message || ''))) return 'The server certificate could not be trusted.';
  return `Could not read the mailbox${err?.message ? `: ${String(err.message).slice(0, 120)}` : ''}`;
}

const HEADERS = ['auto-submitted', 'precedence', 'x-autoreply', 'x-autorespond', 'list-id', 'list-unsubscribe', 'content-type'];

/** mailparser keeps headers in a Map with structured values; the reply checks want plain text. */
export function flattenHeaders(map) {
  const out = {};
  for (const name of HEADERS) {
    const v = map?.get?.(name);
    if (v === undefined || v === null) continue;
    out[name] = typeof v === 'object' ? String(v.value ?? v.text ?? '') || '1' : String(v);
  }
  return out;
}

