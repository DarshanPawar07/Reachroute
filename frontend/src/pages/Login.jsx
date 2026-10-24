import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { API_BASE } from '../api.js';
import { useAuth } from '../auth.jsx';
import AuthShell from '../components/AuthShell.jsx';
import { Alert, Button, Card, Field, Input } from '../components/ui.jsx';

export default function Login() {
  const { session, login, register } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await (mode === 'login' ? login(email, password) : register(email, password, accepted));
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={mode === 'login' ? 'Welcome back' : 'Create your account'}
      subtitle={mode === 'login' ? 'Log in to send your next campaign.' : 'Free to start. No card needed.'}
      footer={
        <>
          {mode === 'login' ? 'New here?' : 'Already have an account?'}{' '}
          <button
            className="font-semibold text-emerald-700 underline"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError('');
            }}
          >
            {mode === 'login' ? 'Create an account' : 'Log in'}
          </button>
        </>
      }
    >
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" hint={mode === 'register' ? 'At least 8 characters' : undefined}>
            <Input
              type="password"
              required
              minLength={mode === 'register' ? 8 : undefined}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {mode === 'login' && (
            <div className="-mt-2 text-right">
              <Link to="/forgot-password" className="text-sm text-stone-600 underline">
                Forgot password?
              </Link>
            </div>
          )}
          {mode === 'register' && (
            <label className="flex items-start gap-2.5 text-sm">
              <input type="checkbox" required className="mt-1 h-4 w-4 accent-emerald-600" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <span>
                I agree to the{' '}
                <a href={`${API_BASE}/legal/terms`} target="_blank" rel="noreferrer" className="underline">
                  Terms of Service
                </a>{' '}
                and the{' '}
                <a href={`${API_BASE}/legal/privacy`} target="_blank" rel="noreferrer" className="underline">
                  Privacy Policy
                </a>
                .
              </span>
            </label>
          )}
          {error && <Alert>{error}</Alert>}
          <Button type="submit" variant="accent" className="w-full" disabled={busy || (mode === 'register' && !accepted)}>
            {busy ? 'Please wait...' : mode === 'login' ? 'Log in' : 'Create account'}
          </Button>
        </form>
      </Card>
    </AuthShell>
  );
}
