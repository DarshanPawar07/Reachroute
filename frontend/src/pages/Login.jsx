import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { API_BASE } from '../api.js';
import { useAuth } from '../auth.jsx';
import AuthShell from '../components/AuthShell.jsx';
import { AuthField, AuthInput, PasswordInput, SubmitButton, emailProblem } from '../components/auth/fields.jsx';
import OAuthButtons from '../components/auth/OAuthButtons.jsx';
import OtpStep from '../components/auth/OtpStep.jsx';
import ServerNotice from '../components/auth/ServerNotice.jsx';
import useServerCheck from '../components/auth/useServerCheck.js';
import { Alert } from '../components/ui.jsx';

// Which field each kind of server answer belongs to. Anything else is shown above the form.
const EMAIL_CODES = ['invalid_email', 'email_required', 'no_account', 'email_taken'];
const PASSWORD_CODES = ['wrong_password', 'password_required', 'use_oauth'];

export default function Login({ initialMode = 'login' }) {
  const { session, login, register, completeLogin } = useAuth();
  const navigate = useNavigate();
  const wanted = useLocation().state?.from;
  const after = typeof wanted === 'string' && /^\/[a-z]/i.test(wanted) ? wanted : '/dashboard'; // where the person was headed before being asked to log in
  const server = useServerCheck();
  const [mode, setMode] = useState(initialMode); // 'login' | 'register' | 'otp'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // { token, email, sendNow } while the sign-up code is being typed

  if (session) return <Navigate to={after} replace />;

  const switchMode = (next) => {
    setMode(next);
    setErrors({});
    window.history.replaceState(null, '', next === 'login' ? '/login' : '/register');
  };

  const validate = () => {
    const found = {};
    const e = emailProblem(email);
    if (e) found.email = e;
    if (!password) found.password = mode === 'login' ? 'Enter your password.' : 'Choose a password.';
    else if (mode === 'register' && password.length < 8) found.password = 'Use at least 8 characters.';
    if (mode === 'register' && !accepted) found.terms = 'Tick the box to accept the Terms and Privacy Policy.';
    return found;
  };

  const finish = () => {
    completeLogin({ token: pending.token, email: pending.email });
    navigate(after);
  };

  const submit = async (ev) => {
    ev.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    try {
      const data = mode === 'login' ? await login(email.trim(), password, { defer: true }) : await register(email.trim(), password, accepted, { defer: true });
      if (data.user.emailVerified === false) {
        setPending({ token: data.token, email: data.user.email, sendNow: mode === 'login' });
        setMode('otp');
      } else {
        completeLogin({ token: data.token, email: data.user.email });
        navigate(after);
      }
    } catch (err) {
      if (EMAIL_CODES.includes(err.code)) setErrors({ email: err.message, code: err.code });
      else if (PASSWORD_CODES.includes(err.code)) setErrors({ password: err.message, code: err.code });
      else setErrors({ form: err.message, serverDown: err.code === 'server_down' });
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'otp' && pending) {
    return (
      <AuthShell title="Check your email" subtitle="One more step. Enter the code we sent you to confirm this is your address." footer={<>Wrong account? <button className="font-semibold text-emerald-700 hover:underline" onClick={() => { setPending(null); switchMode('login'); }}>Back to log in</button></>}>
        <OtpStep email={pending.email} token={pending.token} sendNow={pending.sendNow} onVerified={finish} onBack={() => { setPending(null); switchMode('register'); }} />
      </AuthShell>
    );
  }

  const login_ = mode === 'login';
  return (
    <AuthShell
      title={login_ ? 'Welcome back' : 'Create your free account'}
      subtitle={login_ ? 'Log in to send your next campaign.' : 'No card needed. 50 WhatsApp messages and 100 emails, free.'}
      footer={
        <>
          {login_ ? 'New to Reachroute?' : 'Already have an account?'}{' '}
          <button className="font-semibold text-emerald-700 hover:underline" onClick={() => switchMode(login_ ? 'register' : 'login')}>
            {login_ ? 'Create an account' : 'Log in'}
          </button>
        </>
      }
    >
      <ServerNotice info={server} />
      <OAuthButtons intent={login_ ? 'login' : 'signup'} termsAccepted={login_ || accepted} />
      <form onSubmit={submit} className="space-y-4" noValidate>
        <AuthField
          id="email"
          label="Email"
          error={
            errors.email && (
              <>
                {errors.email}{' '}
                {errors.code === 'no_account' && <button type="button" onClick={() => switchMode('register')} className="font-semibold underline">Create an account</button>}
                {errors.code === 'email_taken' && <button type="button" onClick={() => switchMode('login')} className="font-semibold underline">Log in</button>}
              </>
            )
          }
        >
          <AuthInput id="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} invalid={Boolean(errors.email)} placeholder="you@example.com" value={email} onChange={(e) => { setEmail(e.target.value); setErrors((x) => ({ ...x, email: undefined })); }} />
        </AuthField>

        <AuthField
          id="password"
          label="Password"
          hint={login_ ? undefined : 'At least 8 characters.'}
          error={errors.password}
          aside={login_ && <Link to="/forgot-password" className="text-sm font-medium text-stone-600 hover:text-stone-900 hover:underline">Forgot password?</Link>}
        >
          <PasswordInput id="password" autoComplete={login_ ? 'current-password' : 'new-password'} invalid={Boolean(errors.password)} value={password} onChange={(e) => { setPassword(e.target.value); setErrors((x) => ({ ...x, password: undefined })); }} />
        </AuthField>

        {!login_ && (
          <div>
            <label className="flex items-start gap-2.5 text-sm leading-relaxed">
              <input type="checkbox" className="mt-1" checked={accepted} onChange={(e) => { setAccepted(e.target.checked); setErrors((x) => ({ ...x, terms: undefined })); }} />
              <span>
                I agree to the{' '}
                <a href={`${API_BASE}/legal/terms`} target="_blank" rel="noreferrer" className="font-medium underline">Terms of Service</a> and the{' '}
                <a href={`${API_BASE}/legal/privacy`} target="_blank" rel="noreferrer" className="font-medium underline">Privacy Policy</a>.
              </span>
            </label>
            {errors.terms && <p role="alert" className="mt-1.5 text-[0.85rem] text-red-700">{errors.terms}</p>}
          </div>
        )}

        {errors.form && <Alert kind={errors.serverDown ? 'warn' : 'error'}>{errors.form}</Alert>}
        <SubmitButton busy={busy} busyText={login_ ? 'Logging in...' : 'Creating account...'}>{login_ ? 'Log in' : 'Create account'}</SubmitButton>
      </form>
    </AuthShell>
  );
}
