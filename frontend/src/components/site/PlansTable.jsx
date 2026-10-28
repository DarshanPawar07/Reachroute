import { Link } from 'react-router-dom';
import { COMPARE_ROWS, INCLUDED_EVERYWHERE, PLANS } from '../../site/plans.js';
import Icon from '../Icon.jsx';

/** The plan cards. `featured` marks the free plan, which is the one most people begin with. */
export function PlanCards() {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {PLANS.map((p) => {
        const free = p.key === 'free';
        return (
          <article key={p.key} className={`flex flex-col rounded-2xl border p-6 ${free ? 'border-emerald-600 bg-white ring-4 ring-emerald-600/10' : 'border-stone-200 bg-white'}`}>
            <h3 className="text-xl font-semibold">{p.name}</h3>
            <p className="mt-4 flex items-baseline gap-2">
              <span className="font-display text-4xl font-semibold tracking-tight text-stone-900">{p.priceLabel}</span>
              <span className="text-sm text-stone-500">{p.period}</span>
            </p>
            {p.yearlyLabel && <p className="mt-1 text-sm font-medium text-emerald-700">or {p.yearlyLabel}</p>}
            <p className="mt-3 text-[0.95rem] leading-relaxed text-stone-600">{p.blurb}</p>
            <ul className="mb-7 mt-5 space-y-2.5 text-[0.95rem] text-stone-800">
              {p.highlights.map((h) => (
                <li key={h} className="flex gap-2.5">
                  <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  {h}
                </li>
              ))}
            </ul>
            <Link
              to={p.cta.to}
              className={`mt-auto inline-flex justify-center rounded-xl px-4 py-3 text-sm font-semibold transition ${free ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'border border-stone-300 text-stone-900 hover:border-stone-500'}`}
            >
              {p.cta.label}
            </Link>
          </article>
        );
      })}
    </div>
  );
}

/** Every limit, side by side. A real table, so it reads well to screen readers and search engines. */
export function CompareTable() {
  return (
    <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white">
      <table className="w-full min-w-[40rem] border-collapse text-left text-[0.95rem]">
        <caption className="sr-only">What each Reachroute plan allows</caption>
        <thead>
          <tr className="border-b border-stone-200 bg-stone-50">
            <th scope="col" className="px-5 py-4 font-semibold text-stone-500">Limit</th>
            {PLANS.map((p) => (
              <th key={p.key} scope="col" className="px-5 py-4 font-display text-lg font-semibold text-stone-900">{p.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARE_ROWS.map((r) => (
            <tr key={r.key} className="border-b border-stone-100 last:border-0">
              <th scope="row" className="px-5 py-3.5 font-medium text-stone-700">{r.label}</th>
              {PLANS.map((p) => (
                <td key={p.key} className="px-5 py-3.5 tabular-nums text-stone-800">{p.limits ? p.limits[r.key] : 'Set for you'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function IncludedList() {
  return (
    <ul className="grid gap-x-10 gap-y-3 sm:grid-cols-2">
      {INCLUDED_EVERYWHERE.map((t) => (
        <li key={t} className="flex gap-3 text-[1rem] text-stone-800">
          <Icon name="check" className="mt-1 h-4 w-4 shrink-0 text-emerald-600" />
          {t}
        </li>
      ))}
    </ul>
  );
}
