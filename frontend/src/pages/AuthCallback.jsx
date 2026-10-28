import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import AuthShell from '../components/AuthShell.jsx';
import { Alert } from '../components/ui.jsx';
import { BigLink } from '../components/site/parts.jsx';

const NAMES = { google: 'Google', github: 'GitHub' };

/** What each sign-in problem means for the person, and where to go next. The server sends only a short reason code. */
function explain(error, provider, email) {
  const who = NAMES[provider] || 'that provider';
  switch (error) {
    case 'no_account':
      return { text: `There is no Reachroute account for ${email || `your ${who} email`} yet.`, action: { label: 'Create an account', to: '/register' } };
    case 'terms_required':
      return { text: `To create an account you must accept the Terms and Privacy Policy. Tick the box on the sign-up page, then choose ${who} again.`, action: { label: 'Go to sign up', to: '/register' } };
    case 'denied':
      return { text: `You cancelled the ${who} sign-in. Nothing was changed.`, action: { label: 'Back to log in', to: '/login' } };
    case 'no_verified_email':
      return { text: `${who} did not give us a confirmed email address. Confirm your email on ${who}, or sign up with your email and a password instead.`, action: { label: 'Sign up with email', to: '/register' } };
    case 'bad_state':
      return { text: 'That sign-in took too long, or was started in a different browser. Please try again.', action: { label: 'Back to log in', to: '/login' } };
    case 'suspended':
      return { text: 'This account has been suspended. Please contact support.', action: { label: 'Contact us', to: '/contact' } };
    case 'not_configured':
      return { text: `Signing in with ${who} is not available yet. Use your email and password instead.`, action: { label: 'Back to log in', to: '/login' } };
    case 'provider_error':
      return { text: `${who} could not complete the sign-in. Please try again in a moment.`, action: { label: 'Back to log in', to: '/login' } };
    default:
      return { text: 'Something went wrong on our side while signing you in. Please try again.', action: { label: 'Back to log in', to: '/login' } };
  }
}

/** Where Google / GitHub send the person back to. The result is in the #fragment of the address. */
export default function AuthCallback() {
  const { completeLogin } = useAuth();
  const navigate = useNavigate();
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, '', window.location.pathname); // take the token out of the address bar and the history
    if (p.get('token') && p.get('email')) {
      completeLogin({ token: p.get('token'), email: p.get('email') });
      navigate('/dashboard', { replace: true });
    } else {
      setProblem(explain(p.get('error') || 'unknown', p.get('provider'), p.get('email')));
    }
    // runs once, on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!problem) return <AuthShell title="Signing you in"><p className="text-sm text-stone-600">One moment...</p></AuthShell>;
  return (
    <AuthShell title="We could not sign you in" footer={<Link to="/" className="font-semibold text-emerald-700 hover:underline">Back to home</Link>}>
      <div className="space-y-4">
        <Alert>{problem.text}</Alert>
        <BigLink to={problem.action.to} variant="dark" className="w-full">{problem.action.label}</BigLink>
      </div>
    </AuthShell>
  );
}
