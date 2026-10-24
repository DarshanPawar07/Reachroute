import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';

export function Logo({ light = false }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-600 text-white">
        <Icon name="chat" className="h-5 w-5" />
      </span>
      <span className={`font-display text-xl font-semibold tracking-tight ${light ? 'text-white' : 'text-stone-900'}`}>Bulk Messenger</span>
    </span>
  );
}

const points = [
  'Every email carries an unsubscribe link, added for you.',
  'Messages are paced to protect your number and your sender reputation.',
  'See who received what, then download the report.',
];

/** The page around the login, forgot-password, reset-password and verify-email forms. */
export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="hidden flex-col justify-between bg-stone-900 p-12 text-stone-200 lg:flex">
        <Logo light />
        <div className="max-w-md">
          <h2 className="font-display text-4xl font-semibold leading-[1.1] text-white">Email and WhatsApp campaigns, from one place.</h2>
          <ul className="mt-8 space-y-4 text-[0.95rem] leading-relaxed text-stone-300">
            {points.map((p) => (
              <li key={p} className="flex gap-3">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex gap-3 text-sm">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5">
            <span className="h-2 w-2 rounded-full bg-wa" /> WhatsApp
          </span>
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5">
            <span className="h-2 w-2 rounded-full bg-[#7d93f5]" /> Email
          </span>
        </div>
      </aside>

      <main className="grid place-items-center p-5 sm:p-10">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-8 block lg:hidden">
            <Logo />
          </Link>
          <h1 className="text-[1.75rem] font-semibold leading-tight">{title}</h1>
          {subtitle && <p className="mb-6 mt-1.5 text-[0.95rem] text-stone-600">{subtitle}</p>}
          {!subtitle && <div className="mb-6" />}
          {children}
          {footer && <p className="mt-5 text-sm text-stone-600">{footer}</p>}
        </div>
      </main>
    </div>
  );
}
