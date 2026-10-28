import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import AuthShell from '../components/AuthShell.jsx';
import { AuthField, AuthInput, SubmitButton, emailProblem } from '../components/auth/fields.jsx';
import ServerNotice from '../components/auth/ServerNotice.jsx';
import useServerCheck from '../components/auth/useServerCheck.js';
import { Alert } from '../components/ui.jsx';

export default function ForgotPassword() {
  const server = useServerCheck();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState({});
  const [sent, setSent] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const problem = emailProblem(email);
    if (problem) return setError({ email: problem });
    setBusy(true);
    setError({});
    try {
      await api('/api/auth/forgot-password', { method: 'POST', body: { email: email.trim() } });
      setSent(email.trim());
    } catch (err) {
      if (['invalid_email', 'email_required', 'no_account'].includes(err.code)) setError({ email: err.message, code: err.code });
      else setError({ form: err.message, kind: err.code === 'cooldown' ? 'info' : err.code === 'server_down' ? 'warn' : 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={sent ? 'Check your email' : 'Forgot your password?'}
      subtitle={sent ? undefined : 'Enter the email you signed up with and we will send you a link to choose a new one.'}
      footer={<Link to="/login" className="font-semibold text-emerald-700 hover:underline">Back to log in</Link>}
    >
      {sent ? (
        <div className="space-y-4">
          <Alert kind="success">A reset link is on its way to <strong>{sent}</strong>. It works for 1 hour.</Alert>
          <p className="text-sm leading-relaxed text-stone-600">Nothing arrived? Look in your spam folder, wait a minute, and ask again.</p>
          <button type="button" onClick={() => { setSent(''); setError({}); }} className="text-sm font-semibold text-emerald-700 hover:underline">Use a different email</button>
        </div>
      ) : (
        <>
          <ServerNotice info={server} />
          <form onSubmit={submit} className="space-y-4" noValidate>
            <AuthField
              id="email"
              label="Email"
              error={error.email && <>{error.email} {error.code === 'no_account' && <Link to="/register" className="font-semibold underline">Create an account</Link>}</>}
            >
              <AuthInput id="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} invalid={Boolean(error.email)} placeholder="you@example.com" value={email} onChange={(e) => { setEmail(e.target.value); setError({}); }} />
            </AuthField>
            {error.form && <Alert kind={error.kind}>{error.form}</Alert>}
            <SubmitButton busy={busy}>Send reset link</SubmitButton>
          </form>
        </>
      )}
    </AuthShell>
  );
}
