import { useMemo, useState } from 'react';

// Channel colours come from the theme (index.css): WhatsApp green and email indigo. Both pass the colour checks on white.
const WA = 'var(--color-wa)';
const MAIL = 'var(--color-mail)';
const PLOT_H = 160; // height of the bars in px

const shortDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/** A round number at or above n, for the top of the axis: 7 -> 10, 130 -> 200. */
const niceMax = (n) => {
  if (n <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(n));
  const f = n / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};

/** What a day looks like in the tooltip and the table. */
const total = (d) => d.whatsapp + d.email;

/**
 * Messages sent per day, one bar per day, stacked by channel (WhatsApp at the bottom, email on top).
 *   days  [{ date: 'YYYY-MM-DD', whatsapp: n, email: n }], oldest first
 * Hover or focus a day to read its numbers. "Show as table" gives the same data as text.
 */
export default function SentChart({ days }) {
  const [active, setActive] = useState(null);
  const [asTable, setAsTable] = useState(false);

  const top = useMemo(() => niceMax(Math.max(0, ...days.map(total))), [days]);
  const px = (n) => (n > 0 ? Math.max(3, Math.round((n / top) * PLOT_H)) : 0);
  const shown = active === null ? null : days[active];
  const labelAt = useMemo(() => new Set([0, Math.floor((days.length - 1) / 2), days.length - 1]), [days.length]);
  const sum = useMemo(() => days.reduce((t, d) => ({ whatsapp: t.whatsapp + d.whatsapp, email: t.email + d.email }), { whatsapp: 0, email: 0 }), [days]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-4 text-sm text-stone-700">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-[3px]" style={{ background: WA }} /> WhatsApp <span className="tabular-nums text-stone-500">{sum.whatsapp}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-[3px]" style={{ background: MAIL }} /> Email <span className="tabular-nums text-stone-500">{sum.email}</span>
          </span>
        </div>
        <button type="button" onClick={() => setAsTable((v) => !v)} className="text-xs text-stone-600 underline">
          {asTable ? 'Show chart' : 'Show as table'}
        </button>
      </div>

      {asTable ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white text-[0.8rem] font-semibold text-stone-500">
              <tr>
                <th className="py-2 pr-3">Day</th>
                <th className="py-2 pr-3">WhatsApp</th>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 tabular-nums">
              {[...days].reverse().map((d) => (
                <tr key={d.date}>
                  <td className="py-1.5 pr-3">{shortDate(d.date)}</td>
                  <td className="py-1.5 pr-3">{d.whatsapp}</td>
                  <td className="py-1.5 pr-3">{d.email}</td>
                  <td className="py-1.5 font-medium">{total(d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex gap-2">
          {/* y axis: three recessive ticks */}
          <div className="relative w-9 shrink-0 text-right text-[11px] tabular-nums text-stone-500" style={{ height: PLOT_H + 20 }} aria-hidden="true">
            {[top, top / 2, 0].map((v) => (
              <span key={v} className="absolute right-0 -translate-y-1/2" style={{ top: (1 - v / top) * PLOT_H + 4 }}>
                {v}
              </span>
            ))}
          </div>

          <div className="relative min-w-0 flex-1" style={{ height: PLOT_H + 20 }}>
            {[0, 0.5, 1].map((f) => (
              <div key={f} className={`absolute inset-x-0 border-t ${f === 1 ? 'border-stone-300' : 'border-dashed border-stone-200'}`} style={{ top: (1 - f) * PLOT_H + 4 }} aria-hidden="true" />
            ))}
            <div className="absolute inset-x-0 top-1 flex items-end gap-[3px]" style={{ height: PLOT_H }}>
              {days.map((d, i) => (
                <div
                  key={d.date}
                  tabIndex={0}
                  role="img"
                  aria-label={`${shortDate(d.date)}: ${d.whatsapp} WhatsApp, ${d.email} email`}
                  className="flex h-full min-w-0 flex-1 cursor-default flex-col justify-end outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                >
                  <div style={{ opacity: active === null || active === i ? 1 : 0.5 }}>
                    {d.email > 0 && <div style={{ height: px(d.email), background: MAIL, borderRadius: '3px 3px 0 0', marginBottom: d.whatsapp > 0 ? 2 : 0 }} />}
                    {d.whatsapp > 0 && <div style={{ height: px(d.whatsapp), background: WA, borderRadius: d.email > 0 ? 0 : '3px 3px 0 0' }} />}
                  </div>
                </div>
              ))}
            </div>
            {/* x axis: first, middle and last day */}
            <div className="absolute inset-x-0 flex text-[11px] text-stone-500" style={{ top: PLOT_H + 8 }} aria-hidden="true">
              {days.map((d, i) => (
                <span key={d.date} className="relative flex-1">
                  {labelAt.has(i) && (
                    <span className={`absolute whitespace-nowrap ${i === 0 ? 'left-0' : i === days.length - 1 ? 'right-0' : '-translate-x-1/2'}`}>{shortDate(d.date)}</span>
                  )}
                </span>
              ))}
            </div>

            {shown && (
              <div
                className="pointer-events-none absolute top-0 z-10 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs shadow-sm"
                style={{ left: `${((active + 0.5) / days.length) * 100}%`, transform: `translateX(${active > days.length / 2 ? '-105%' : '5%'})` }}
              >
                <div className="mb-1 font-medium text-stone-800">{shortDate(shown.date)}</div>
                {[
                  ['WhatsApp', shown.whatsapp, WA],
                  ['Email', shown.email, MAIL],
                ].map(([label, n, color]) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} />
                    <span className="font-semibold tabular-nums text-stone-900">{n}</span>
                    <span className="text-stone-500">{label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
