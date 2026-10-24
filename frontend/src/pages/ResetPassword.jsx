import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import AuthShell from '../components/AuthShell.jsx';
import { Alert, Button, Card, Field, Input } from '../components/ui.jsx';

export default function ResetPassword() {
  const [params] = useSearchParams();
  // Keep the token in memory and take it out of the address bar, so it is not left in the browser history.
  const [token] = useState(() => params.get('token') || '');
  useEffect(() => {
    if (token) window.history.replaceState(null, '', window.location.pathname);
  }, [token]);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Choose a new password" subtitle="Pick something you have not used elsewhere.">
      <Card className="space-y-4">
        {done ? (
          <>
            <Alert kind="success">Your password was changed. You can log in with it now.</Alert>
            <Link to="/login" className="inline-block text-sm font-medium underline">
              Go to log in
            </Link>
          </>
        ) : !token ? (
          <>
            <Alert>This page needs the link from your email. Open the link again, or ask for a new one.</Alert>
            <Link to="/forgot-password" className="inline-block text-sm font-medium underline">
              Ask for a new link
            </Link>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <Field label="New password" hint="At least 8 characters">
              <Input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Repeat the new password">
              <Input type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            {error && (
              <Alert>
                {error}{' '}
                {/invalid or has expired/i.test(error) && (
                  <Link to="/forgot-password" className="font-medium underline">
                    Ask for a new link
                  </Link>
                )}
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Please wait...' : 'Change password'}
            </Button>
          </form>
        )}
      </Card>
    </AuthShell>
  );
}
