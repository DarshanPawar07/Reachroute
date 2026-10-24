import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtSize } from '../lib/kinds.js';
import { Alert, Button, Card, Field, Input, PageHeader } from '../components/ui.jsx';

function ChangePassword() {
  const { replaceToken } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setDone(false);
    if (next !== confirm) return setError('The two new passwords do not match.');
    setBusy(true);
    try {
      const res = await api('/api/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      replaceToken(res.token); // this device stays signed in, every other one is signed out
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} className="space-y-4">
        <h2 className="text-lg font-semibold">Change password</h2>
        <Field label="Current password">
          <Input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" hint="At least 8 characters">
          <Input type="password" required minLength={8} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Repeat the new password">
          <Input type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {error && <Alert>{error}</Alert>}
        {done && <Alert kind="success">Password changed. Every other device was signed out.</Alert>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Please wait...' : 'Change password'}
        </Button>
      </form>
    </Card>
  );
}

function SignOutEverywhere() {
  const { replaceToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const run = async () => {
    if (!window.confirm('Sign out of every other browser and device? You stay signed in here.')) return;
    setBusy(true);
    setError('');
    setDone(false);
    try {
      const res = await api('/api/auth/logout-all', { method: 'POST' });
      replaceToken(res.token);
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold">Sign out other devices</h2>
      <p className="text-sm text-stone-600">Used a shared computer, or lost a phone? This ends every other login right away. Campaigns that are already running keep going.</p>
      {error && <Alert>{error}</Alert>}
      {done && <Alert kind="success">Every other device was signed out.</Alert>}
      <Button variant="secondary" disabled={busy} onClick={run}>
        {busy ? 'Please wait...' : 'Sign out other devices'}
      </Button>
    </Card>
  );
}

function PlanAndStorage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/api/account/plan')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return null;
  const { usage } = data;
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold">Your plan: {data.plan.name}</h2>
      <p className="text-sm text-stone-600">
        Saved: {usage.lists} contact list{usage.lists === 1 ? '' : 's'}, {usage.templates} template{usage.templates === 1 ? '' : 's'}, {usage.attachments} attachment
        {usage.attachments === 1 ? '' : 's'} ({fmtSize(usage.storageBytes)}).
      </p>
      <table className="w-full text-left text-sm">
        <tbody className="divide-y divide-stone-100">
          {data.limits.map((l) => (
            <tr key={l.key}>
              <td className="py-1.5 pr-3">{l.label}</td>
              <td className="py-1.5 pr-3 font-medium tabular-nums">{l.value}</td>
              <td className="py-1.5 text-xs text-stone-500">{l.source === 'account' ? 'set for your account' : l.source === 'plan' ? 'from your plan' : 'standard'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function Account() {
  const { session } = useAuth();
  return (
    <>
      <PageHeader title="Account" subtitle={session?.email} />
      <div className="max-w-lg space-y-4">
        <PlanAndStorage />
        <ChangePassword />
        <SignOutEverywhere />
      </div>
    </>
  );
}
