import { useState } from 'react';

const base =
  'w-full rounded-xl border bg-white px-3.5 py-3 text-[0.95rem] text-stone-900 outline-none transition placeholder:text-stone-400 focus:ring-4 disabled:bg-stone-100';
const ok = 'border-stone-300 focus:border-emerald-500 focus:ring-emerald-100';
const err = 'border-red-400 focus:border-red-500 focus:ring-red-100';

/** A label, the input, and (when something is wrong with it) the reason, right under it. */
export function AuthField({ label, id, error, hint, aside, children }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-semibold text-stone-800">{label}</label>
        {aside}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-[0.85rem] leading-snug text-red-700">{error}</p>
      ) : (
        hint && <p className="mt-1.5 text-[0.8rem] leading-snug text-stone-500">{hint}</p>
      )}
    </div>
  );
}

export const AuthInput = ({ id, invalid, ...props }) => (
  <input id={id} aria-invalid={invalid ? 'true' : undefined} aria-describedby={invalid ? `${id}-error` : undefined} className={`${base} ${invalid ? err : ok}`} {...props} />
);

export function PasswordInput({ id, invalid, ...props }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input id={id} type={shown ? 'text' : 'password'} aria-invalid={invalid ? 'true' : undefined} aria-describedby={invalid ? `${id}-error` : undefined} className={`${base} pr-16 ${invalid ? err : ok}`} {...props} />
      <button type="button" onClick={() => setShown((v) => !v)} aria-pressed={shown} className="absolute inset-y-0 right-0 px-3.5 text-sm font-medium text-stone-500 hover:text-stone-900">
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

export const SubmitButton = ({ busy, children, busyText = 'Please wait...', ...props }) => (
  <button type="submit" disabled={busy || props.disabled} className="inline-flex w-full items-center justify-center rounded-xl bg-emerald-600 px-4 py-3 text-[0.95rem] font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50" {...props}>
    {busy ? busyText : children}
  </button>
);

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

/** What is wrong with a typed email address, in words, or '' when it looks fine. */
export function emailProblem(raw) {
  const v = String(raw || '').trim();
  if (!v) return 'Enter your email address.';
  if (!v.includes('@')) return 'An email address has an @ in it, like name@gmail.com.';
  if (!EMAIL_RE.test(v)) return 'That does not look like a complete email address. Check it for typos, like name@gmail.com.';
  return '';
}
