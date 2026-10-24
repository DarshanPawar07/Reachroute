import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import AuthShell from '../components/AuthShell.jsx';
import { Alert, Button, Card, Field, Input } from '../components/ui.jsx';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api('/api/auth/forgot-password', { method: 'POST', body: { email } });
      setDone(res.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Forgot your password?"
      subtitle="Enter your email and we will send you a link to choose a new one."
      footer={
        <Link to="/login" className="font-medium text-stone-900 underline">
          Back to log in
        </Link>
      }
    >
      <Card>
        {done ? (
          <div className="space-y-3">
            <Alert kind="success">{done}</Alert>
            <p className="text-xs text-stone-500">Nothing arrived? Check your spam folder, wait a minute, and try again.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email">
              <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            {error && <Alert>{error}</Alert>}
            <Button type="submit" className="w-full" disabled={busy || !email.trim()}>
              {busy ? 'Please wait...' : 'Send reset link'}
            </Button>
          </form>
        )}
      </Card>
    </AuthShell>
  );
}
