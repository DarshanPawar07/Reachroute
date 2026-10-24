import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { API_BASE } from '../api.js';
import { Logo } from './AuthShell.jsx';
import Icon from './Icon.jsx';
import { Alert, Button } from './ui.jsx';

const groups = [
  { items: [{ to: '/', label: 'Dashboard', icon: 'home', end: true }] },
  {
    title: 'Send',
    items: [
      { to: '/whatsapp', label: 'WhatsApp', icon: 'whatsapp', dot: 'bg-wa' },
      { to: '/email', label: 'Email', icon: 'mail', dot: 'bg-[#7d93f5]' },
    ],
  },
  {
    title: 'Manage',
    items: [
      { to: '/lists', label: 'Contact lists', icon: 'list' },
      { to: '/usage', label: 'Usage', icon: 'chart' },
      { to: '/notifications', label: 'Alerts', icon: 'bell', badge: true },
    ],
  },
  { title: 'Your account', items: [{ to: '/account', label: 'Account', icon: 'user' }] },
];

/** Shown to accounts that have not confirmed their email address yet. */
function VerifyBanner() {
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  useEffect(() => {
    api('/api/auth/me')
      .then(setMe)
      .catch(() => {});
  }, []);

  if (!me || me.user.emailVerified) return null;

  const resend = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await api('/api/auth/resend-verification', { method: 'POST' });
      if (res.alreadyVerified) setMe({ ...me, user: { ...me.user, emailVerified: true } });
      else setNote({ kind: 'success', text: res.emailSent ? 'A new link is on its way. Check your inbox and spam folder.' : 'Email sending is not set up on this server yet, so no email could be sent.' });
    } catch (err) {
      setNote({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 space-y-2">
      <Alert kind="warn">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            Please confirm your email address ({me.user.email}). We sent you a link when you signed up.
            {me.verificationRequired && ' You cannot start campaigns until you do.'}
          </span>
          <Button variant="secondary" disabled={busy} onClick={resend}>
            {busy ? 'Sending...' : 'Send a new link'}
          </Button>
        </div>
      </Alert>
      {note && <Alert kind={note.kind}>{note.text}</Alert>}
    </div>
  );
}

/** Shown when the Terms or Privacy Policy changed (or were never accepted) and the server requires acceptance. */
function TermsBanner() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/account/legal')
      .then(setStatus)
      .catch(() => {});
  }, []);

  if (!status?.required || status.pending.length === 0) return null;

  const accept = async () => {
    setBusy(true);
    setError('');
    try {
      const versions = Object.fromEntries(status.documents.filter((d) => status.pending.includes(d.doc)).map((d) => [d.doc, d.currentVersion]));
      setStatus(await api('/api/account/legal/accept', { method: 'POST', body: { versions } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 space-y-2">
      <Alert kind="warn">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            Please read and accept the{' '}
            {status.documents
              .filter((d) => status.pending.includes(d.doc))
              .map((d, i) => (
                <span key={d.doc}>
                  {i > 0 && ' and the '}
                  <a href={`${API_BASE}/legal/${d.doc}`} target="_blank" rel="noreferrer" className="underline">
                    {d.title}
                  </a>
                </span>
              ))}
            . You cannot start campaigns until you do.
          </span>
          <Button variant="secondary" disabled={busy} onClick={accept}>
            {busy ? 'Saving...' : 'I accept'}
          </Button>
        </div>
      </Alert>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

export default function Layout() {
  const { session, logout } = useAuth();
  const [unread, setUnread] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    api('/api/auth/me')
      .then((r) => setIsAdmin(r.user.role === 'admin'))
      .catch(() => {});
  }, []);

  // Number on the "Alerts" item: checked every 30 seconds, and straight away when the alerts page changes something.
  const refreshUnread = useCallback(() => {
    api('/api/notifications/unread-count')
      .then((r) => setUnread(r.unread))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshUnread();
    const timer = setInterval(refreshUnread, 30_000);
    window.addEventListener('alerts-changed', refreshUnread);
    return () => {
      clearInterval(timer);
      window.removeEventListener('alerts-changed', refreshUnread);
    };
  }, [refreshUnread]);

  const shown = isAdmin ? [...groups, { items: [{ to: '/admin', label: 'Admin', icon: 'shield' }] }] : groups;

  return (
    <div className="min-h-screen md:flex">
      <aside className="bg-stone-900 text-stone-300 md:sticky md:top-0 md:flex md:h-screen md:w-64 md:shrink-0 md:flex-col">
        <div className="px-5 py-5">
          <NavLink to="/" aria-label="Bulk Messenger home">
            <Logo light />
          </NavLink>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:gap-0 md:overflow-y-auto md:pb-4" aria-label="Main">
          {shown.map((group, gi) => (
            <div key={gi} className="flex gap-1 md:mb-5 md:flex-col">
              {group.title && <div className="hidden px-3 pb-1.5 text-[0.8rem] font-medium text-stone-500 md:block">{group.title}</div>}
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `flex items-center gap-3 whitespace-nowrap rounded-xl px-3 py-2.5 text-sm font-medium transition ${isActive ? 'bg-white/10 text-white' : 'text-stone-300 hover:bg-white/5 hover:text-white'}`
                  }
                >
                  <Icon name={item.icon} className="h-[1.15rem] w-[1.15rem] shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {item.dot && <span className={`hidden h-2 w-2 rounded-full md:block ${item.dot}`} />}
                  {item.badge && unread > 0 && (
                    <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs font-semibold text-white" aria-label={`${unread} unread alerts`}>
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-4 text-sm">
          <span className="truncate text-stone-400" title={session?.email}>
            {session?.email}
          </span>
          <button onClick={logout} className="inline-flex shrink-0 items-center gap-1.5 text-stone-200 hover:text-white">
            <Icon name="logout" className="h-4 w-4" />
            Log out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 md:py-10">
        <div className="mx-auto max-w-4xl">
          <VerifyBanner />
          <TermsBanner />
          <Outlet />
        </div>
      </main>
    </div>
  );
}
