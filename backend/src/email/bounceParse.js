// Reading "your email could not be delivered" notices (bounces). Pure: no database, no network.
//
// Only a dead ADDRESS counts: the mailbox does not exist, was closed, or the domain does not exist. A full mailbox,
// a temporary problem, or a refusal because of spam/policy/size says nothing about the person's address, and stopping
// to email them because of it would be wrong (the same rule the provider webhooks follow).

const EMAIL = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;
const EMAIL_G = new RegExp(EMAIL.source, 'gi');
const ROBOT = /^(mailer-daemon|postmaster)(\+.*)?@/i;
const BOUNCE_SUBJECT = /(undeliver|delivery (status notification|failure|has failed|incomplete)|returned mail|failure notice|mail delivery (failed|subsystem)|could not be delivered|couldn'?t be delivered|not delivered|wasn'?t delivered)/i;

// The server blames the sender or the moment, not the address.
const NOT_THE_ADDRESS = /(spam|blocked|block ?list|black ?list|reputation|policy|\brbl\b|denied|dmarc|\bspf\b|dkim|not authori[sz]ed|unauthenticated|rate limit|too many|throttl|grey ?list|try again|temporar|quota|mailbox full|over quota|storage|too large|size limit|message size)/i;
const ADDRESS_IS_DEAD = /((user|recipient|mailbox|address|account|e-?mail).{0,60}(unknown|not found|does not exist|doesn'?t exist|not exist|invalid|no such|disabled|inactive|unavailable|rejected|not valid))|no such (user|recipient|mailbox)|unknown (user|recipient)|user unknown|invalid (recipient|address|mailbox)|recipient (not found|rejected|address rejected)|(domain|host) (not found|does not exist|has no mail)|nxdomain|\bno mx\b|unrout?eable|unable to route/i;

/** Fields of each recipient block in a delivery-status report (RFC 3464). */
function dsnBlocks(text) {
  const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  const out = [];
  for (const block of blocks) {
    const fields = {};
    let last = null;
    for (const line of block.split('\n')) {
      if (/^[ \t]+\S/.test(line) && last) {
        fields[last] += ` ${line.trim()}`; // a long value continues on the next line
        continue;
      }
      const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
      if (m) {
        last = m[1].toLowerCase();
        fields[last] = m[2].trim();
      }
    }
    const who = fields['final-recipient'] || fields['original-recipient'];
    if (who) {
      const email = (who.split(';').pop() || '').match(EMAIL)?.[0];
      if (email) out.push({ email: email.toLowerCase(), action: (fields.action || '').toLowerCase(), status: fields.status || '', diagnostic: fields['diagnostic-code'] || '' });
    }
  }
  return out;
}

/** Decide what one failure means. Returns { hard: true } or { hard: false, why }. */
export function classify({ status = '', diagnostic = '', action = '' }) {
  if (action && action !== 'failed') return { hard: false, why: `not a failure (${action})` };
  const code = String(status).match(/\b([245])\.(\d{1,3})\.(\d{1,3})\b/) || String(diagnostic).match(/\b([245])\.(\d{1,3})\.(\d{1,3})\b/);
  const [cls, subject, detail] = code ? [code[1], Number(code[2]), Number(code[3])] : ['', -1, -1];
  const words = `${diagnostic} ${status}`;

  if (cls === '4') return { hard: false, why: 'temporary problem' };
  if (cls === '5' && (subject === 7 || (subject === 2 && detail === 2) || (subject === 3 && detail === 4))) return { hard: false, why: 'the server refused the message, not the address' };
  if (cls === '5' && subject === 1 && (detail === 7 || detail === 8)) return { hard: false, why: 'a problem with the sender address' };

  const deadByCode = cls === '5' && ((subject === 1) || (subject === 2 && detail === 1));
  if (deadByCode) return NOT_THE_ADDRESS.test(words) && !ADDRESS_IS_DEAD.test(words) ? { hard: false, why: 'the server blamed the message, not the address' } : { hard: true };
  // no clear code: only an explicit "no such user" style message is trusted
  if (ADDRESS_IS_DEAD.test(words) && !NOT_THE_ADDRESS.test(words)) return { hard: true };
  return { hard: false, why: 'the reason was not clear' };
}

/**
 * Look at one received mail. msg: { from: { address }, subject, text, headers, dsn }
 * where `dsn` is the text of the "message/delivery-status" part, when there is one.
 * Returns { isBounce, hard: [{ email, detail }], ignored: [{ email, why }] }.
 * `ownEmail` (optional) is never reported as a bounced address.
 */
export function parseBounce(msg, { ownEmail = '' } = {}) {
  const from = String(msg?.from?.address || '');
  const own = String(ownEmail || '').toLowerCase();
  const none = { isBounce: false, hard: [], ignored: [] };

  const blocks = dsnBlocks(msg?.dsn);
  const isBounce = blocks.length > 0 || (ROBOT.test(from) && BOUNCE_SUBJECT.test(String(msg?.subject || '')));
  if (!isBounce) return none;

  const hard = new Map();
  const ignored = [];
  const take = (email, verdict, detail) => {
    if (!email || email === own || ROBOT.test(email)) return;
    if (verdict.hard) {
      if (!hard.has(email)) hard.set(email, { email, detail: String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 300) });
    } else if (!ignored.some((i) => i.email === email)) {
      ignored.push({ email, why: verdict.why });
    }
  };

  if (blocks.length) {
    for (const b of blocks) take(b.email, classify(b), `${b.status} ${b.diagnostic}`);
  } else {
    // A bounce without a delivery-status report (some servers write only a message): judge the whole text.
    const text = String(msg?.text || '').slice(0, 20_000);
    const verdict = classify({ status: '', diagnostic: text });
    const found = [...new Set((text.match(EMAIL_G) || []).map((e) => e.toLowerCase()))].slice(0, 20);
    const snippet = (text.match(/.{0,80}(user unknown|no such user|does not exist|not found|invalid recipient|unrout?eable)[^\n]{0,120}/i) || [''])[0];
    for (const email of found) take(email, verdict, snippet);
  }

  // a hard failure for an address outranks "unclear" for the same one
  const done = new Set(hard.keys());
  return { isBounce: true, hard: [...hard.values()], ignored: ignored.filter((i) => !done.has(i.email)) };
}
