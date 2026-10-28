import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';

export function Logo({ light = false }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-teal-500 to-teal-800">
        <svg viewBox="0 0 64 64" className="h-9 w-9" aria-hidden="true">
          <path fill="#fff" d="M32 9c13.3 0 24 9.2 24 20.5S45.300 50 32 50c-2.800 0-5.500-.4-8-1.200L12.500 55c-1 .5-2-.4-1.700-1.500l2.500-9.200C9.400 41 8 35.500 8 29.500 8 18.200 18.700 9 32 9z" />
          <g fill="none" stroke="#0e7a6b" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 30h8c5 0 6-8 12-8M27 30c5 0 6 8 12 8" />
            <circle cx="19" cy="30" r="2" fill="#0e7a6b" />
            <path d="M36 18l5 4-5 4M36 34l5 4-5 4" />
          </g>
        </svg>
      </span>
      <span className={`font-display text-2xl font-semibold tracking-tight ${light ? 'text-white' : 'text-stone-900'}`}>Reachroute</span>
    </span>
  );
}

const points = [
  'Every email carries an unsubscribe link, added for you.',
  'Messages are paced to protect your number and your sender reputation.',
  'See who received what, then download the report.',
];

/** The small route drawing under the points: the same idea as the home page, lit for a dark background. */
function Route() {
  const stops = [
    { y: 18, label: 'WhatsApp', color: '#3ecf8e', live: true },
    { y: 62, label: 'Email', color: '#8ea2ff', live: true },
    { y: 106, label: 'Instagram', color: '#e275a8', live: false },
    { y: 150, label: 'Facebook Messenger', color: '#5cb6ee', live: false },
  ];
  return (
    <svg viewBox="0 0 340 168" className="w-full max-w-[21rem]" role="img" aria-label="WhatsApp and email are available now. Instagram and Facebook Messenger are planned.">
      <rect x="0" y="62" width="74" height="44" rx="12" fill="#ffffff" fillOpacity="0.1" />
      <text x="37" y="89" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="600" fontFamily="Bricolage Grotesque, Figtree, sans-serif">Your list</text>
      {stops.map((s) => (
        <g key={s.label}>
          <path d={`M74 84H104C128 84 128 ${s.y} 152 ${s.y}H168`} fill="none" stroke={s.color} strokeWidth={s.live ? 3.5 : 2.5} strokeLinecap="round" strokeDasharray={s.live ? undefined : '1 7'} opacity={s.live ? 0.95 : 0.8} />
          <circle cx="176" cy={s.y} r="7" fill={s.live ? '#12242d' : 'none'} stroke={s.color} strokeWidth="3" strokeDasharray={s.live ? undefined : '3 3'} />
          <text x="192" y={s.y + 4.5} fill={s.live ? '#fff' : '#9fb2ab'} fontSize="13" fontFamily="Figtree, sans-serif">{s.label}</text>
        </g>
      ))}
    </svg>
  );
}

/** The page around login, sign-up, forgot-password, reset-password and verify-email. */
export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="hidden flex-col justify-between bg-stone-900 p-12 text-stone-200 lg:flex">
        <Link to="/" aria-label="Reachroute home">
          <Logo light />
        </Link>
        <div className="max-w-md">
          <p className="font-display text-4xl font-semibold leading-[1.1] text-white">Bulk WhatsApp and email, for people who asked to hear from you.</p>
          <ul className="mt-8 space-y-4 text-[0.95rem] leading-relaxed text-stone-300">
            {points.map((p) => (
              <li key={p} className="flex gap-3">
                <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <Route />
      </aside>

      <main className="flex flex-col px-5 py-6 sm:px-10">
        <div className="flex items-center justify-between">
          <Link to="/" className="lg:invisible" aria-label="Reachroute home">
            <Logo />
          </Link>
          <Link to="/" className="text-sm font-medium text-stone-600 hover:text-stone-900">
            Back to home
          </Link>
        </div>
        <div className="grid flex-1 place-items-center py-8">
          <div className="w-full max-w-md">
            <h1 className="text-[1.9rem] font-semibold leading-tight">{title}</h1>
            {subtitle && <p className="mt-2 text-[0.97rem] leading-relaxed text-stone-600">{subtitle}</p>}
            <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-6 shadow-[0_1px_2px_rgba(18,36,45,0.04)] sm:p-7">{children}</div>
            {footer && <p className="mt-5 text-center text-sm text-stone-600">{footer}</p>}
          </div>
        </div>
      </main>
    </div>
  );
}
