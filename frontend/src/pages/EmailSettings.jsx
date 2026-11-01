import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import ImapSettings from '../components/ImapSettings.jsx';
import SenderVerify from '../components/SenderVerify.jsx';
import { Alert, Button, Card, Field, Input, PageHeader } from '../components/ui.jsx';

/**
 * What each provider needs. `simple` providers only need the person's email address and an app password:
 * the server details are filled in and tucked under "Advanced".
 */
const PROVIDERS = {
  gmail: {
    name: 'Gmail',
    host: 'smtp.gmail.com', port: 465, secure: true, simple: true,
    domains: ['gmail.com', 'googlemail.com'],
    limit: 'About 500 emails a day.',
    passwordLabel: 'App password',
    steps: [
      <>Open <a href="https://myaccount.google.com/security" target="_blank" rel="noreferrer" className="font-semibold underline">your Google account security page</a> and turn on <strong>2-Step Verification</strong> if it is off.</>,
      <>Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="font-semibold underline">App passwords</a>, type the name <strong>Reachroute</strong> and press <strong>Create</strong>.</>,
      <>Google shows a 16-letter password. Copy it and paste it below. Spaces do not matter.</>,
    ],
    note: 'Your normal Gmail password will not work here. An app password is a separate password that only works for this one app, and you can delete it any time.',
  },
  outlook: {
    name: 'Outlook / Hotmail',
    host: 'smtp-mail.outlook.com', port: 587, secure: false, simple: true,
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.in', 'hotmail.co.in'],
    limit: 'About 300 emails a day.',
    passwordLabel: 'App password',
    steps: [
      <>Open <a href="https://account.microsoft.com/security" target="_blank" rel="noreferrer" className="font-semibold underline">Microsoft account security</a> and turn on <strong>two-step verification</strong>.</>,
      <>Go to <strong>Advanced security options</strong>, then <strong>App passwords</strong>, and create one.</>,
      <>Copy the password and paste it below.</>,
    ],
    note: 'Microsoft is switching off password sign-in for sending on many accounts, especially work and school ones. If the test fails, use Gmail or Brevo instead.',
  },
  yahoo: {
    name: 'Yahoo',
    host: 'smtp.mail.yahoo.com', port: 465, secure: true, simple: true,
    domains: ['yahoo.com', 'yahoo.in', 'yahoo.co.in', 'ymail.com'],
    limit: 'About 500 emails a day.',
    passwordLabel: 'App password',
    steps: [
      <>Open <a href="https://login.yahoo.com/account/security" target="_blank" rel="noreferrer" className="font-semibold underline">Yahoo account security</a>.</>,
      <>Choose <strong>Generate app password</strong>, pick <strong>Other app</strong>, and name it Reachroute.</>,
      <>Copy the password and paste it below.</>,
    ],
    note: 'Your normal Yahoo password will not work here.',
  },
  zoho: {
    name: 'Zoho Mail',
    host: 'smtp.zoho.in', port: 465, secure: true, simple: true,
    domains: ['zoho.com', 'zohomail.in', 'zohomail.com'],
    limit: 'Depends on your Zoho plan.',
    passwordLabel: 'App password',
    steps: [
      <>Open <a href="https://accounts.zoho.in/home#security/app_password" target="_blank" rel="noreferrer" className="font-semibold underline">Zoho app passwords</a> (use accounts.zoho.com if your account is on the .com site).</>,
      <>Generate a new app password and name it Reachroute.</>,
      <>Copy it and paste it below. If the test fails, open Advanced and change the host to smtp.zoho.com.</>,
    ],
    note: 'IMAP and SMTP must be turned on in Zoho Mail settings.',
  },
  brevo: {
    name: 'Brevo',
    host: 'smtp-relay.brevo.com', port: 587, secure: false, simple: false,
    limit: 'Free plan: 300 emails a day. Built for bulk mail, so it is the better choice for large lists.',
    passwordLabel: 'SMTP key',
    steps: [
      <>Create a free account at <a href="https://www.brevo.com" target="_blank" rel="noreferrer" className="font-semibold underline">brevo.com</a>.</>,
      <>Open <strong>SMTP and API</strong> in the menu, then the <strong>SMTP</strong> tab. Copy the <strong>login</strong> shown there into the SMTP username below.</>,
      <>Press <strong>Generate a new SMTP key</strong>, copy it, and paste it as the SMTP key below.</>,
      <>In Brevo, open <strong>Senders, domains and dedicated IPs</strong> and add the address you want to send from. Brevo emails it a confirmation.</>,
    ],
    note: 'The username is not your email address: it is the SMTP login Brevo shows you.',
  },
  ses: {
    name: 'Amazon SES',
    host: 'email-smtp.ap-south-1.amazonaws.com', port: 587, secure: false, simple: false,
    limit: 'Very cheap at large volumes, but setup takes longer and new accounts start in a sandbox.',
    passwordLabel: 'SMTP password',
    steps: [
      <>In the AWS console open <strong>Amazon SES</strong> in the Mumbai region and verify your sender address or domain.</>,
      <>Open <strong>SMTP settings</strong> and press <strong>Create SMTP credentials</strong>.</>,
      <>Paste the SMTP username and password below. Ask AWS to move your account out of the sandbox before sending to other people.</>,
    ],
    note: 'Best left until you send large volumes. Gmail or Brevo is easier to start with.',
  },
  other: {
    name: 'Another provider',
    host: '', port: 587, secure: false, simple: false,
    limit: '',
    passwordLabel: 'SMTP password',
    steps: [
      <>Ask your email provider or hosting company for the <strong>SMTP</strong> settings: server name, port, username and password.</>,
      <>Port 465 normally means SSL is on. Port 587 means SSL is off (the connection upgrades itself).</>,
    ],
    note: 'Company or website email (like you@yourbusiness.com) usually has these details in the hosting control panel under "Email accounts" or "Connect devices".',
  },
};

const ORDER = ['gmail', 'outlook', 'yahoo', 'zoho', 'brevo', 'ses', 'other'];
const EMPTY = { host: '', port: 587, secure: false, user: '', pass: '', fromName: '', fromEmail: '', replyTo: '' };

const providerFromEmail = (email) => {
  const domain = String(email).split('@')[1]?.toLowerCase();
  return domain ? ORDER.find((k) => PROVIDERS[k].domains?.includes(domain)) : undefined;
};
const providerFromHost = (host) => ORDER.find((k) => PROVIDERS[k].host && PROVIDERS[k].host === host) || (host ? 'other' : '');

function Steps({ done, items }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-3" aria-label="Setup steps">
      {items.map((s, i) => (
        <li key={s.label} className={`rounded-xl border px-4 py-3 text-sm ${done[i] ? 'border-emerald-200 bg-emerald-50' : 'border-stone-200 bg-white'}`}>
          <div className="flex items-center gap-2 font-semibold">
            <span className={`grid h-5 w-5 place-items-center rounded-full text-xs ${done[i] ? 'bg-emerald-600 text-white' : 'bg-stone-200 text-stone-700'}`} aria-hidden="true">{done[i] ? '✓' : i + 1}</span>
            {s.label}
            <span className="sr-only">{done[i] ? ' (done)' : ' (not done yet)'}</span>
          </div>
          <p className="mt-1 text-stone-600">{s.hint}</p>
        </li>
      ))}
    </ol>
  );
}

const TROUBLE = [
  ['The login was refused', 'Use an app password (or SMTP key), not your normal password. Copy it again with no extra spaces. For Gmail, 2-Step Verification must be on.'],
  ['The test email did not arrive', 'Look in spam or promotions first. It is sent to the email address you sign in to Reachroute with.'],
  ['"Connection timed out" or "could not connect"', 'Check the host and port under Advanced. Port 465 needs SSL on, port 587 needs it off.'],
  ['My company email does not work', 'Ask the person who runs your email for the SMTP settings. Some companies block sending from outside apps.'],
  ['I want to send to thousands of people', 'Gmail and Outlook limit daily sending and may suspend accounts that send unwanted bulk mail. Use Brevo or Amazon SES with your own domain.'],
];

export default function EmailSettings() {
  const [form, setForm] = useState(EMPTY);
  const [provider, setProvider] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [sender, setSender] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { kind, text }
  const [saved, setSaved] = useState(false);
  const [tested, setTested] = useState(false);
  const chosenByHand = useRef(false);

  useEffect(() => {
    api('/api/email/settings')
      .then(({ settings, sender: status }) => {
        setSender(status);
        if (settings) {
          setForm({ ...EMPTY, ...settings, pass: '' });
          setHasPassword(settings.hasPassword);
          setProvider(providerFromHost(settings.host));
          setSaved(true);
          chosenByHand.current = true;
        }
      })
      .catch((e) => setMessage({ kind: 'error', text: e.message }))
      .finally(() => setLoaded(true));
  }, []);

  const p = provider ? PROVIDERS[provider] : null;
  const simple = Boolean(p?.simple);

  const choose = (key) => {
    chosenByHand.current = true;
    const next = PROVIDERS[key];
    setProvider(key);
    setForm((f) => ({ ...f, host: next.host, port: next.port, secure: next.secure }));
  };

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  // Simple providers: one address field is both the sign-in name and the "from" address.
  const setEmail = (e) => {
    const value = e.target.value;
    const guess = !chosenByHand.current ? providerFromEmail(value) : undefined;
    setForm((f) => {
      const next = { ...f, fromEmail: value, user: simple || guess ? (f.user === '' || f.user === f.fromEmail ? value : f.user) : f.user };
      return guess ? { ...next, host: PROVIDERS[guess].host, port: PROVIDERS[guess].port, secure: PROVIDERS[guess].secure } : next;
    });
    if (guess) setProvider(guess);
  };

  const connect = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setTested(false);
    try {
      const body = { ...form, port: Number(form.port), user: form.user || form.fromEmail };
      const res = await api('/api/email/settings', { method: 'PUT', body });
      if (res.sender) setSender(res.sender);
      setHasPassword(hasPassword || form.pass.length > 0);
      setForm((f) => ({ ...f, pass: '' }));
      setSaved(true);
      // Straight on to the test, so one press checks everything.
      try {
        const t = await api('/api/email/settings/test', { method: 'POST' });
        setTested(true);
        setMessage({ kind: 'success', text: `Connected. We sent a test email to ${t.sentTo}. Check your inbox (and spam) to see it arrive. Next, confirm your sending address below.` });
      } catch (err) {
        setMessage({ kind: 'error', text: `Your details are saved, but the test failed: ${err.message} See "Something went wrong?" below.` });
      }
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api('/api/email/settings/test', { method: 'POST' });
      setTested(true);
      setMessage({ kind: 'success', text: `Test email sent to ${res.sentTo}. Check your inbox.` });
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return <p className="text-sm text-stone-500">Loading...</p>;

  const verified = Boolean(sender?.verified);

  return (
    <>
      <PageHeader
        title="Connect your email"
        subtitle="Your emails go out from your own address. Setup takes about three minutes."
        actions={
          <Link to="/email" className="text-sm underline">
            Back to email
          </Link>
        }
      />

      <div className="space-y-4">
        <Steps
          done={[saved, tested || verified, verified]}
          items={[
            { label: 'Connect', hint: 'Pick your provider and paste a password.' },
            { label: 'Test', hint: 'We send you one email to check it works.' },
            { label: 'Confirm', hint: 'Type a code we email you, to prove the address is yours.' },
          ]}
        />

        <Card className="space-y-5">
          <div>
            <h2 className="text-lg font-semibold">1. Who provides your email?</h2>
            <p className="text-sm text-stone-600">Pick one. If you type your address below, we choose it for you.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-4" role="group" aria-label="Email provider">
            {ORDER.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={provider === k}
                onClick={() => choose(k)}
                className={`rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition ${provider === k ? 'border-emerald-600 bg-emerald-50 text-emerald-900' : 'border-stone-300 bg-white text-stone-800 hover:border-stone-400'}`}
              >
                {PROVIDERS[k].name}
              </button>
            ))}
          </div>

          {p && (
            <div className="rounded-xl bg-stone-50 p-4 text-sm">
              <h3 className="font-semibold">How to get your {p.passwordLabel.toLowerCase()} ({p.name})</h3>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-stone-800">
                {p.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
              {p.note && <p className="mt-3 text-stone-700">{p.note}</p>}
              {p.limit && <p className="mt-1 text-stone-500">{p.limit}</p>}
            </div>
          )}

          <form onSubmit={connect} className="space-y-4">
            <h2 className="text-lg font-semibold">2. Enter your details</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={simple ? 'Your email address' : 'Send from this email address'} hint={simple ? 'The address your emails will come from.' : 'It must be an address your provider allows you to send from.'}>
                <Input required type="email" value={form.fromEmail} onChange={setEmail} autoComplete="off" placeholder="you@example.com" />
              </Field>
              <Field label={p?.passwordLabel || 'Password'} hint={hasPassword ? 'Saved. Leave blank to keep it.' : simple ? 'The one you just created, not your normal password.' : undefined}>
                <Input type="password" value={form.pass} onChange={set('pass')} autoComplete="new-password" placeholder={hasPassword ? '••••••••' : ''} />
              </Field>
            </div>

            {!simple && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="SMTP username" hint={provider === 'brevo' ? 'The SMTP login from Brevo, not your email address.' : undefined}>
                  <Input value={form.user} onChange={set('user')} autoComplete="off" />
                </Field>
                <Field label="SMTP host">
                  <Input required value={form.host} onChange={set('host')} placeholder="smtp.example.com" />
                </Field>
              </div>
            )}

            <Field label="Your name (shown to people who get your email)">
              <Input value={form.fromName} onChange={set('fromName')} placeholder="Darshan from Acme" />
            </Field>

            <details className="rounded-xl border border-stone-200 px-4 py-3 text-sm" open={!provider}>
              <summary className="cursor-pointer font-semibold">Advanced: server, port and reply-to</summary>
              <div className="mt-3 space-y-4">
                {simple && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="SMTP host"><Input required value={form.host} onChange={set('host')} placeholder="smtp.example.com" /></Field>
                    <Field label="SMTP username" hint="Normally the same as your email address."><Input value={form.user} onChange={set('user')} autoComplete="off" /></Field>
                  </div>
                )}
                {!simple && !provider && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="SMTP host"><Input required value={form.host} onChange={set('host')} placeholder="smtp.example.com" /></Field>
                    <Field label="SMTP username"><Input value={form.user} onChange={set('user')} autoComplete="off" /></Field>
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Port"><Input required type="number" min="1" max="65535" value={form.port} onChange={set('port')} /></Field>
                  <div className="sm:col-span-2">
                    <Field label="Reply-to address (optional)" hint="Where replies go, if different.">
                      <Input type="email" value={form.replyTo} onChange={set('replyTo')} />
                    </Field>
                  </div>
                </div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.secure} onChange={set('secure')} />
                  Use SSL from the start (on for port 465, off for 587)
                </label>
              </div>
            </details>

            {message && <Alert kind={message.kind}>{message.text}</Alert>}

            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="accent" disabled={busy || !provider}>
                {busy ? 'Connecting...' : saved ? 'Save and send a test email' : 'Connect and send a test email'}
              </Button>
              {saved && (
                <Button variant="secondary" onClick={sendTest} disabled={busy}>
                  Send test email again
                </Button>
              )}
            </div>
            {!provider && <p className="text-sm text-stone-500">Pick your provider above to continue.</p>}
          </form>
        </Card>

        <div>
          <h2 className="mb-2 text-lg font-semibold">3. Confirm your sending address</h2>
          {saved ? (
            <SenderVerify sender={sender} onChange={setSender} />
          ) : (
            <Alert kind="info">After you connect, we email a 6-digit code to your sending address. Type it here once to prove the address is yours.</Alert>
          )}
        </div>

        <Card className="space-y-2">
          <h2 className="text-lg font-semibold">Something went wrong?</h2>
          <div className="divide-y divide-stone-100">
            {TROUBLE.map(([q, a]) => (
              <details key={q} className="py-2 text-sm">
                <summary className="cursor-pointer font-semibold">{q}</summary>
                <p className="mt-1.5 text-stone-700">{a}</p>
              </details>
            ))}
          </div>
        </Card>

        <ImapSettings />

        <Alert kind="info">
          Gmail and Outlook accounts have daily sending caps (around 500 a day for Gmail) and may suspend accounts that
          send unsolicited bulk mail. Only email people who asked to hear from you. For larger lists, use a sending service such as Brevo or Amazon SES with your own domain.
        </Alert>
      </div>
    </>
  );
}
