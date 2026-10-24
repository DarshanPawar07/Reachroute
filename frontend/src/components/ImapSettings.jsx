import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate } from '../lib/kinds.js';
import { Alert, Button, Card, Field, Input, Select } from './ui.jsx';

const EMPTY = { host: '', port: 993, secure: true, user: '', pass: '' };

/** Where replies are read from: the mailbox the owner already uses, over IMAP. */
export default function ImapSettings() {
  const [info, setInfo] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [hasPassword, setHasPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const apply = (res) => {
    setInfo(res);
    if (res.settings) {
      setForm({ ...EMPTY, host: res.settings.host, port: res.settings.port, secure: res.settings.secure, user: res.settings.user });
      setHasPassword(res.settings.hasPassword);
    }
  };

  useEffect(() => {
    api('/api/email/imap')
      .then(apply)
      .catch((e) => setMessage({ kind: 'error', text: e.message }));
  }, []);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const run = async (fn, okText) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fn();
      if (okText) setMessage({ kind: 'success', text: typeof okText === 'function' ? okText(res) : okText });
      return res;
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    const res = await run(
      () => api('/api/email/imap', { method: 'PUT', body: { ...form, port: Number(form.port) } }),
      'Connected. New replies are now read automatically. Mail that arrived before now is not read.'
    );
    if (res) {
      setInfo({ ...info, settings: res.settings });
      setHasPassword(true);
      setForm({ ...form, pass: '' });
    }
  };

  const check = () => run(() => api('/api/email/imap/check', { method: 'POST' }), (r) => (r.busy ? 'A check is already running.' : r.stored ? `${r.stored} new ${r.stored === 1 ? 'reply' : 'replies'} found.` : 'No new replies.')).then(() => api('/api/email/imap').then(apply).catch(() => {}));

  const toggle = async (enabled) => {
    const res = await run(() => api('/api/email/imap/enabled', { method: 'POST', body: { enabled } }), enabled ? 'Reading replies again.' : 'Paused. No mail is read until you turn it back on.');
    if (res) setInfo({ ...info, settings: res.settings });
  };

  const remove = async () => {
    if (!window.confirm('Remove the mailbox details? The saved password is deleted. Replies already received stay.')) return;
    const res = await run(() => api('/api/email/imap', { method: 'DELETE' }), 'Removed.');
    if (res) {
      setInfo({ ...info, settings: null });
      setForm(EMPTY);
      setHasPassword(false);
    }
  };

  const applyPreset = (e) => {
    const p = info?.providers.find((x) => x.name === e.target.value);
    if (p) setForm({ ...form, host: p.host, port: p.port, secure: true });
  };

  if (!info) return message ? <Alert kind={message.kind}>{message.text}</Alert> : null;
  const s = info.settings;
  const note = info.providers.find((p) => p.host === form.host)?.note;

  return (
    <Card>
      <h2 className="text-lg font-semibold">Replies</h2>
      <p className="mb-4 mt-1 text-sm text-stone-600">
        Connect the mailbox where replies arrive. We only read the Inbox, only for people you emailed in a campaign, and only mail that arrives after you connect. Someone who replies "unsubscribe" or "stop" is not emailed again.
      </p>
      {!info.available && <Alert kind="warn">Reading replies is switched off on this server.</Alert>}

      {s && (
        <div className="mb-4 space-y-2 text-sm">
          <p>
            {s.enabled ? 'Reading' : 'Paused:'} <strong>{s.user}</strong> at {s.host}.{' '}
            {s.lastCheckedAt ? `Last checked ${fmtDate(s.lastCheckedAt)}.` : 'Not checked yet.'} Checked about every {Math.round(info.pollSeconds / 60)} minutes.
          </p>
          {s.lastError && <Alert kind="warn">{s.lastError}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy || !s.enabled} onClick={check}>
              Check now
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => toggle(!s.enabled)}>
              {s.enabled ? 'Pause' : 'Resume'}
            </Button>
            <Button variant="danger" disabled={busy} onClick={remove}>
              Remove
            </Button>
          </div>
        </div>
      )}

      <form onSubmit={save} className="space-y-4">
        <Field label="Provider preset" hint="Fills in the server. Brevo and Amazon SES have no mailbox: use the mailbox where your Reply-to address lands.">
          <Select defaultValue="" onChange={applyPreset}>
            <option value="">Choose a provider...</option>
            {info.providers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        {note && <Alert kind="info">{note}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field label="IMAP host">
              <Input required value={form.host} onChange={set('host')} placeholder="imap.example.com" />
            </Field>
          </div>
          <Field label="Port">
            <Input required type="number" min="1" max="65535" value={form.port} onChange={set('port')} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.secure} onChange={set('secure')} />
          Use SSL/TLS (on for port 993)
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mailbox user name" hint="Usually the full email address.">
            <Input required value={form.user} onChange={set('user')} autoComplete="off" />
          </Field>
          <Field label="Mailbox password" hint={hasPassword ? 'Saved. Leave blank to keep it.' : 'Gmail, Outlook and Yahoo need an app password.'}>
            <Input type="password" value={form.pass} onChange={set('pass')} autoComplete="new-password" placeholder={hasPassword ? '••••••••' : ''} />
          </Field>
        </div>
        {message && <Alert kind={message.kind}>{message.text}</Alert>}
        <Button type="submit" disabled={busy || !info.available}>
          {busy ? 'Working...' : s ? 'Save and reconnect' : 'Connect mailbox'}
        </Button>
      </form>
    </Card>
  );
}
