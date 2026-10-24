import { Link } from 'react-router-dom';

const variants = {
  primary: 'bg-stone-900 text-white hover:bg-stone-700',
  accent: 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700',
  secondary: 'border border-stone-300 bg-white text-stone-800 hover:border-stone-400 hover:bg-stone-50',
  danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
};

export const buttonClass = (variant = 'primary', extra = '') =>
  `inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${extra}`;

export function Button({ variant, className, type = 'button', ...props }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}

export function LinkButton({ to, variant, className = '', disabled, children }) {
  if (disabled) {
    return <span className={buttonClass(variant, `cursor-not-allowed opacity-50 ${className}`)}>{children}</span>;
  }
  return (
    <Link to={to} className={buttonClass(variant, className)}>
      {children}
    </Link>
  );
}

export function Card({ className = '', children }) {
  return <section className={`rounded-2xl border border-stone-200 bg-white p-5 shadow-[0_1px_2px_rgba(18,36,45,0.04)] sm:p-6 ${className}`}>{children}</section>;
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-[1.75rem] font-semibold leading-tight">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-xl text-[0.95rem] text-stone-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold text-stone-800">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[0.8rem] leading-snug text-stone-500">{hint}</span>}
    </label>
  );
}

const inputClass =
  'w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100 disabled:bg-stone-100';

export const Input = (props) => <input className={inputClass} {...props} />;
export const Textarea = (props) => <textarea className={inputClass} {...props} />;
export const Select = (props) => <select className={inputClass} {...props} />;

const badgeColors = {
  running: 'bg-mail-soft text-mail',
  preparing: 'bg-mail-soft text-mail',
  sending: 'bg-mail-soft text-mail',
  connecting: 'bg-mail-soft text-mail',
  paused: 'bg-amber-100 text-amber-800',
  needs_verify: 'bg-amber-100 text-amber-800',
  qr: 'bg-amber-100 text-amber-800',
  skipped: 'bg-amber-100 text-amber-800',
  completed: 'bg-emerald-100 text-emerald-800',
  connected: 'bg-emerald-100 text-emerald-800',
  sent: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  logged_out: 'bg-red-100 text-red-800',
  closed: 'bg-red-100 text-red-800',
  cancelled: 'bg-stone-200 text-stone-700',
  pending: 'bg-stone-200 text-stone-700',
  disconnected: 'bg-stone-200 text-stone-700',
};

const badgeText = { needs_verify: 'verify address', qr: 'scan QR', logged_out: 'logged out', closed: 'connection lost' };

export function Badge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${badgeColors[status] || badgeColors.pending}`}>
      {badgeText[status] || status}
    </span>
  );
}

export function ProgressBar({ sent = 0, failed = 0, skipped = 0, total = 0 }) {
  const pct = (n) => (total ? `${(n / total) * 100}%` : '0%');
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-stone-200">
      <div className="bg-emerald-500" style={{ width: pct(sent) }} />
      <div className="bg-red-500" style={{ width: pct(failed) }} />
      <div className="bg-amber-400" style={{ width: pct(skipped) }} />
    </div>
  );
}

const alertColors = {
  error: 'border-red-200 bg-red-50 text-red-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  info: 'border-stone-200 bg-stone-100 text-stone-700',
};

export function Alert({ kind = 'error', children }) {
  return <div className={`rounded-xl border px-4 py-3 text-sm leading-relaxed ${alertColors[kind]}`}>{children}</div>;
}

export function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50/60 px-4 py-3">
      <div className="text-[0.8rem] font-medium text-stone-500">{label}</div>
      <div className="mt-0.5 font-display text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-stone-500">{sub}</div>}
    </div>
  );
}
