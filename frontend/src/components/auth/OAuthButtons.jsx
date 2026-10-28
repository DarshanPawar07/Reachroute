import { useEffect, useState } from 'react';
import { API_BASE, api } from '../../api.js';

const Google = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
    <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z" />
    <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.5 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z" />
    <path fill="#FBBC05" d="M5.4 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.4a12 12 0 0 0 0 10.8l4-3.1z" />
    <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.5 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8z" />
  </svg>
);
const GitHub = () => (
  <svg viewBox="0 0 16 16" className="h-5 w-5" aria-hidden="true" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
const LOOK = { google: { label: 'Google', icon: <Google /> }, github: { label: 'GitHub', icon: <GitHub /> } };

/**
 * "Continue with Google / GitHub". Only the providers the server has switched on are shown; with none, nothing is drawn.
 * `intent` is 'login' or 'signup'. On sign-up the Terms box must be ticked first, because a new account is made.
 */
export default function OAuthButtons({ intent, termsAccepted = true }) {
  const [providers, setProviders] = useState([]);
  useEffect(() => {
    let alive = true;
    api('/api/auth/oauth/providers')
      .then((r) => alive && setProviders(r.providers || []))
      .catch(() => {}); // the form itself reports a server that is down
    return () => {
      alive = false;
    };
  }, []);

  if (providers.length === 0) return null;
  const blocked = intent === 'signup' && !termsAccepted;
  const href = (p) => `${API_BASE}/api/auth/oauth/${p}/start?intent=${intent}${termsAccepted ? '&terms=1' : ''}`;

  return (
    <div className="mb-5">
      <div className={`grid gap-3 ${providers.length > 1 ? 'sm:grid-cols-2' : ''}`}>
        {providers.map((p) => {
          const look = LOOK[p];
          if (!look) return null;
          const cls = 'inline-flex items-center justify-center gap-2.5 rounded-xl border border-stone-300 bg-white px-4 py-3 text-[0.95rem] font-semibold text-stone-800 transition';
          return blocked ? (
            <button key={p} type="button" disabled aria-disabled="true" aria-label={`Sign up with ${look.label}`} title="Tick the box about the Terms first" className={`${cls} cursor-not-allowed opacity-50`}>
              {look.icon}
              {look.label}
            </button>
          ) : (
            <a key={p} href={href(p)} aria-label={`${intent === 'signup' ? 'Sign up with' : 'Continue with'} ${look.label}`} className={`${cls} hover:border-stone-500 hover:bg-stone-50`}>
              {look.icon}
              {look.label}
            </a>
          );
        })}
      </div>
      {blocked && <p className="mt-2 text-center text-[0.8rem] text-stone-500">Tick the box about the Terms below to use Google or GitHub.</p>}
      <div className="mt-5 flex items-center gap-3 text-[0.8rem] text-stone-500" aria-hidden="true">
        <span className="h-px flex-1 bg-stone-200" />
        or with your email
        <span className="h-px flex-1 bg-stone-200" />
      </div>
    </div>
  );
}
