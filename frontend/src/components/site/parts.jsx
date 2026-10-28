// Small building blocks shared by the public pages.
import { Link } from 'react-router-dom';
import Icon from '../Icon.jsx';

/** Literal class names (not built from strings) so Tailwind can find them. */
export const CH = {
  whatsapp: { text: 'text-wa', soft: 'bg-wa-soft', bg: 'bg-wa', border: 'border-wa', ring: 'ring-wa/30' },
  email: { text: 'text-mail', soft: 'bg-mail-soft', bg: 'bg-mail', border: 'border-mail', ring: 'ring-mail/30' },
  instagram: { text: 'text-ig', soft: 'bg-ig-soft', bg: 'bg-ig', border: 'border-ig', ring: 'ring-ig/30' },
  facebook: { text: 'text-fb', soft: 'bg-fb-soft', bg: 'bg-fb', border: 'border-fb', ring: 'ring-fb/30' },
};

export const Container = ({ className = '', children }) => <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>;

/** A page section with vertical rhythm. `tone` picks the background. */
export function Section({ id, tone = 'plain', className = '', children, label }) {
  const tones = { plain: '', soft: 'bg-white border-y border-stone-200', ink: 'bg-stone-900 text-stone-200' };
  return (
    <section id={id} aria-label={label} className={`py-16 sm:py-24 ${tones[tone]} ${className}`}>
      <Container>{children}</Container>
    </section>
  );
}

export const H1 = ({ children, className = '' }) => (
  <h1 className={`text-[2.4rem] font-semibold leading-[1.06] tracking-tight sm:text-5xl lg:text-[3.5rem] ${className}`}>{children}</h1>
);

export const H2 = ({ children, className = '', light = false }) => (
  <h2 className={`text-[1.85rem] font-semibold leading-[1.12] sm:text-4xl ${light ? '!text-white' : ''} ${className}`}>{children}</h2>
);

export const Lead = ({ children, className = '', light = false }) => (
  <p className={`max-w-2xl text-[1.08rem] leading-relaxed sm:text-lg ${light ? 'text-stone-300' : 'text-stone-600'} ${className}`}>{children}</p>
);

/** Says whether a channel works today or is only planned. */
export function StatusChip({ status }) {
  return status === 'live' ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Available now
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-stone-400 px-2.5 py-1 text-xs font-semibold text-stone-600">Planned, not built yet</span>
  );
}

export function ChannelBadge({ channel, className = 'h-10 w-10' }) {
  const c = CH[channel.key];
  return (
    <span className={`grid shrink-0 place-items-center rounded-xl ${c.soft} ${c.text} ${className}`}>
      <Icon name={channel.icon} className="h-5 w-5" />
    </span>
  );
}

/** Link styled as a button (the shared LinkButton is for app screens; these are larger). */
export function BigLink({ to, variant = 'accent', children, className = '' }) {
  const v = {
    accent: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
    dark: 'bg-stone-900 text-white hover:bg-stone-700',
    light: 'bg-white text-stone-900 hover:bg-stone-100',
    outline: 'border border-stone-300 bg-white text-stone-900 hover:border-stone-500',
    outlineLight: 'border border-white/30 text-white hover:bg-white/10',
  }[variant];
  return (
    <Link to={to} className={`inline-flex items-center justify-center rounded-xl px-6 py-3.5 text-[0.95rem] font-semibold transition ${v} ${className}`}>
      {children}
    </Link>
  );
}

/** Visible breadcrumbs, matching the BreadcrumbList data sent to search engines. */
export function Breadcrumbs({ items }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-6 text-sm text-stone-500">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {items.map((c, i) => (
          <li key={c.path} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden="true" className="text-stone-300">/</span>}
            {i === items.length - 1 ? (
              <span aria-current="page" className="font-medium text-stone-800">{c.name}</span>
            ) : (
              <Link to={c.path} className="hover:text-stone-900 hover:underline">{c.name}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
