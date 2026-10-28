import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import AuthShell from '../components/AuthShell.jsx';
import { AuthField, PasswordInput, SubmitButton } from '../components/auth/fields.jsx';
import { Alert } from '../components/ui.jsx';
import { BigLink } from '../components/site/parts.jsx';

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
  const [errors, setErrors] = useState({});
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const found = {};
    if (!password) found.password = 'Choose a new password.';
    else if (password.length < 8) found.password = 'Use at least 8 characters.';
    if (!confirm) found.confirm = 'Type the new password again.';
    else if (password !== confirm) found.confirm = 'The two passwords do not match.';
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      setErrors({ form: err.message, expired: /invalid or has expired/i.test(err.message), down: err.code === 'server_down' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={done ? 'Password changed' : 'Choose a new password'} subtitle={done ? undefined : 'Pick something you have not used on other sites.'} footer={!done && <Link to="/login" className="font-semibold text-emerald-700 hover:underline">Back to log in</Link>}>
      {done ? (
        <div className="space-y-4">
          <Alert kind="success">Your password was changed, and every device was logged out. Log in with the new one.</Alert>
          <BigLink to="/login" className="w-full">Go to log in</BigLink>
        </div>
      ) : !token ? (
        <div className="space-y-4">
          <Alert>This page needs the link from your email. Open the link again, or ask for a new one.</Alert>
          <BigLink to="/forgot-password" variant="dark" className="w-full">Ask for a new link</BigLink>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <AuthField id="password" label="New password" hint="At least 8 characters." error={errors.password}>
            <PasswordInput id="password" autoComplete="new-password" invalid={Boolean(errors.password)} value={password} onChange={(e) => { setPassword(e.target.value); setErrors({}); }} />
          </AuthField>
          <AuthField id="confirm" label="Repeat the new password" error={errors.confirm}>
            <PasswordInput id="confirm" autoComplete="new-password" invalid={Boolean(errors.confirm)} value={confirm} onChange={(e) => { setConfirm(e.target.value); setErrors({}); }} />
          </AuthField>
          {errors.form && (
            <Alert kind={errors.down ? 'warn' : 'error'}>
              {errors.form} {errors.expired && <Link to="/forgot-password" className="font-semibold underline">Ask for a new link</Link>}
            </Alert>
          )}
          <SubmitButton busy={busy}>Change password</SubmitButton>
        </form>
      )}
    </AuthShell>
  );
}
