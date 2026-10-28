import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import AuthShell from '../components/AuthShell.jsx';
import { Alert } from '../components/ui.jsx';

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const [token] = useState(() => params.get('token') || '');
  const [state, setState] = useState(token ? { status: 'working' } : { status: 'error', message: 'This page needs the link from your email.' });
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return; // the link works once, so make sure it is only used once
    started.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    api('/api/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setState({ status: 'ok' }))
      .catch((err) => setState({ status: 'error', message: err.message }));
  }, [token]);

  return (
    <AuthShell title="Confirm your email">
      <div className="space-y-4">
        {state.status === 'working' && <p className="text-sm text-stone-600">Confirming...</p>}
        {state.status === 'ok' && <Alert kind="success">Thank you. Your email address is confirmed.</Alert>}
        {state.status === 'error' && <Alert>{state.message}</Alert>}
        {state.status !== 'working' && (
          <Link to="/dashboard" className="inline-block text-sm font-medium underline">
            Continue to the app
          </Link>
        )}
      </div>
    </AuthShell>
  );
}
