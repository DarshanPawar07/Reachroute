import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import ImapSettings from '../components/ImapSettings.jsx';
import SenderVerify from '../components/SenderVerify.jsx';
import { Alert, Button, Card, Field, Input, PageHeader, Select } from '../components/ui.jsx';

const PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  brevo: { host: 'smtp-relay.brevo.com', port: 587, secure: false },
  ses: { host: 'email-smtp.ap-south-1.amazonaws.com', port: 587, secure: false },
};

const EMPTY = { host: '', port: 587, secure: false, user: '', pass: '', fromName: '', fromEmail: '', replyTo: '' };

export default function EmailSettings() {
  const [form, setForm] = useState(EMPTY);
  const [hasPassword, setHasPassword] = useState(false);
  const [sender, setSender] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { kind, text }

  useEffect(() => {
    api('/api/email/settings')
      .then(({ settings, sender: status }) => {
        setSender(status);
        if (settings) {
          setForm({ ...EMPTY, ...settings, pass: '' });
          setHasPassword(settings.hasPassword);
        }
      })
      .catch((e) => setMessage({ kind: 'error', text: e.message }))
      .finally(() => setLoaded(true));
  }, []);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const applyPreset = (e) => {
    const preset = PRESETS[e.target.value];
    if (preset) setForm({ ...form, ...preset });
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api('/api/email/settings', { method: 'PUT', body: { ...form, port: Number(form.port) } });
      if (saved.sender) setSender(saved.sender);
      setHasPassword(hasPassword || form.pass.length > 0);
      setForm({ ...form, pass: '' });
      setMessage({ kind: 'success', text: 'Settings saved. Use "Send test email" to check them, then verify your sending address below.' });
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
      setMessage({ kind: 'success', text: `Test email sent to ${res.sentTo}. Check your inbox.` });
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return <p className="text-sm text-stone-500">Loading...</p>;

  return (
    <>
      <PageHeader
        title="Email settings"
        subtitle="Emails are sent through your own SMTP account, so they come from your address."
        actions={
          <Link to="/email" className="text-sm underline">
            Back to email
          </Link>
        }
      />

      <div className="mb-4">
        <SenderVerify sender={sender} onChange={setSender} />
      </div>

      <Card>
        <form onSubmit={save} className="space-y-4">
          <Field label="Provider preset" hint="Fills in the server details. You can still edit them.">
            <Select defaultValue="" onChange={applyPreset}>
              <option value="">Choose a provider...</option>
              <option value="gmail">Gmail (needs an app password)</option>
              <option value="outlook">Outlook / Microsoft 365</option>
              <option value="brevo">Brevo</option>
              <option value="ses">Amazon SES (Mumbai)</option>
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Field label="SMTP host">
                <Input required value={form.host} onChange={set('host')} placeholder="smtp.example.com" />
              </Field>
            </div>
            <Field label="Port">
              <Input required type="number" min="1" max="65535" value={form.port} onChange={set('port')} />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.secure} onChange={set('secure')} />
            Use SSL/TLS from the start (turn on for port 465, leave off for 587)
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="SMTP username">
              <Input value={form.user} onChange={set('user')} autoComplete="off" />
            </Field>
            <Field label="SMTP password" hint={hasPassword ? 'Saved. Leave blank to keep it.' : undefined}>
              <Input
                type="password"
                value={form.pass}
                onChange={set('pass')}
                autoComplete="new-password"
                placeholder={hasPassword ? '••••••••' : ''}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From name">
              <Input value={form.fromName} onChange={set('fromName')} placeholder="Darshan from Acme" />
            </Field>
            <Field label="From email" hint="Must be an address your SMTP account is allowed to send from.">
              <Input required type="email" value={form.fromEmail} onChange={set('fromEmail')} />
            </Field>
          </div>

          <Field label="Reply-to (optional)">
            <Input type="email" value={form.replyTo} onChange={set('replyTo')} />
          </Field>

          {message && <Alert kind={message.kind}>{message.text}</Alert>}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Working...' : 'Save settings'}
            </Button>
            <Button variant="secondary" onClick={sendTest} disabled={busy}>
              Send test email
            </Button>
          </div>
        </form>
      </Card>

      <div className="mt-4">
        <ImapSettings />
      </div>

      <div className="mt-4">
        <Alert kind="info">
          Gmail and Outlook accounts have daily sending caps (around 500 a day for Gmail) and may suspend accounts that
          send unsolicited bulk mail. For larger lists, use a sending service such as Brevo or Amazon SES with your own domain.
        </Alert>
      </div>
    </>
  );
}
