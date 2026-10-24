import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Alert, Button, Card, PageHeader, Stat } from '../components/ui.jsx';

const RANGES = [7, 30, 90];
const SENT = '#059669'; // emerald
const FAILED = '#dc2626'; // red
// Failed also gets stripes, so the two series never depend on red-vs-green alone.
const FAILED_FILL = `repeating-linear-gradient(135deg, ${FAILED} 0 3px, #fecaca 3px 6px)`;

const shortDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

function Legend() {
  return (
    <div className="flex gap-4 text-xs text-stone-600" aria-hidden="true">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-sm" style={{ background: SENT }} /> Sent
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-sm" style={{ background: FAILED_FILL }} /> Failed
      </span>
    </div>
  );
}

/** Stacked daily bars: sent at the bottom, failed on top. Hover or focus a day to read its numbers. */
function DailyBars({ daily }) {
  const [active, setActive] = useState(null);
  const max = Math.max(1, ...daily.map((d) => d.sent + d.failed));
  const H = 140; // plot height in px
  const px = (n) => (n > 0 ? Math.max(3, Math.round((n / max) * H)) : 0);
  const labelAt = new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1]);
  const shown = active === null ? null : daily[active];

  return (
    <div>
      <div className="relative" style={{ height: H + 8 }}>
        <div className="absolute inset-x-0 top-0 flex justify-between text-[10px] text-stone-400" aria-hidden="true">
          <span>{max}</span>
        </div>
        <div className="absolute inset-x-0 top-[6px] border-t border-dashed border-stone-200" aria-hidden="true" />
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-[2px] border-b border-stone-300" style={{ height: H }}>
          {daily.map((d, i) => (
            <div
              key={d.date}
              tabIndex={0}
              role="img"
              aria-label={`${shortDate(d.date)}: ${d.sent} sent, ${d.failed} failed`}
              className="flex h-full min-w-0 flex-1 cursor-default flex-col justify-end outline-none"
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              <div style={{ opacity: active === null || active === i ? 1 : 0.55 }}>
                {d.failed > 0 && (
                  <div style={{ height: px(d.failed), background: FAILED_FILL, borderRadius: d.sent > 0 ? '3px 3px 0 0' : '3px 3px 0 0', marginBottom: d.sent > 0 ? 2 : 0 }} />
                )}
                {d.sent > 0 && <div style={{ height: px(d.sent), background: SENT, borderRadius: d.failed > 0 ? '0' : '3px 3px 0 0' }} />}
              </div>
            </div>
          ))}
        </div>
        {shown && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs shadow-sm"
            style={{ left: `${((active + 0.5) / daily.length) * 100}%`, transform: `translateX(${active > daily.length / 2 ? '-105%' : '5%'})` }}
          >
            <div className="mb-1 font-medium text-stone-800">{shortDate(shown.date)}</div>
            <div className="flex items-center gap-2">
              <span className="inline-block h-0.5 w-3" style={{ background: SENT }} />
              <span className="font-semibold tabular-nums text-stone-900">{shown.sent}</span>
              <span className="text-stone-500">sent</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block h-0.5 w-3" style={{ background: FAILED }} />
              <span className="font-semibold tabular-nums text-stone-900">{shown.failed}</span>
              <span className="text-stone-500">failed</span>
            </div>
          </div>
        )}
      </div>
      <div className="mt-1 flex text-[10px] text-stone-500" aria-hidden="true">
        {daily.map((d, i) => (
          <div key={d.date} className="min-w-0 flex-1 text-center">
            {labelAt.has(i) ? <span className="whitespace-nowrap">{shortDate(d.date)}</span> : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

function DailyTable({ daily }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-white text-[0.8rem] font-semibold text-stone-500">
          <tr>
            <th className="py-2 pr-3">Day</th>
            <th className="py-2 pr-3 text-right">Sent</th>
            <th className="py-2 pr-3 text-right">Failed</th>
            <th className="py-2 text-right">Skipped</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100 tabular-nums">
          {[...daily].reverse().map((d) => (
            <tr key={d.date}>
              <td className="py-1.5 pr-3">{shortDate(d.date)}</td>
              <td className="py-1.5 pr-3 text-right">{d.sent}</td>
              <td className="py-1.5 pr-3 text-right">{d.failed}</td>
              <td className="py-1.5 text-right">{d.skipped}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChannelCard({ title, s, days }) {
  const [table, setTable] = useState(false);
  const empty = s.sent + s.failed + s.skipped === 0;
  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-xs text-stone-500">
          {s.remainingToday} of {s.dailyCap} left today
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sent" value={s.sent} sub={`last ${days} days`} />
        <Stat label="Failed" value={s.failed} />
        <Stat label="Skipped" value={s.skipped} />
        <Stat label="Success rate" value={s.successRate === null ? '-' : `${s.successRate}%`} sub={`${s.campaigns.total} campaign${s.campaigns.total === 1 ? '' : 's'}`} />
      </div>

      {empty ? (
        <p className="text-sm text-stone-500">Nothing sent in this period yet.</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <Legend />
            <button onClick={() => setTable((t) => !t)} className="text-xs underline">
              {table ? 'Show chart' : 'Show as table'}
            </button>
          </div>
          {table ? <DailyTable daily={s.daily} /> : <DailyBars daily={s.daily} />}
        </>
      )}

      {s.topFailures.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-medium">Most common reasons for failures</h3>
          <ul className="divide-y divide-stone-100 text-sm">
            {s.topFailures.map((f) => (
              <li key={f.reason} className="flex justify-between gap-3 py-1.5">
                <span className="min-w-0 break-words text-stone-700">{f.reason}</span>
                <span className="shrink-0 tabular-nums text-stone-500">{f.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export default function Usage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    api(`/api/stats?days=${days}&tz=${tz}`)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError('');
        }
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <>
      <PageHeader title="Usage" subtitle="What you sent, what failed, and how much of today's limit is left." />
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          {RANGES.map((r) => (
            <Button key={r} variant={days === r ? 'primary' : 'secondary'} onClick={() => setDays(r)}>
              Last {r} days
            </Button>
          ))}
        </div>
        {error && <Alert>{error}</Alert>}
        {!data && !error && <p className="text-sm text-stone-500">Loading...</p>}
        {data && (
          <div style={{ opacity: loading ? 0.6 : 1 }} className="space-y-4">
            <ChannelCard title="WhatsApp" s={data.whatsapp} days={data.days} />
            <ChannelCard title="Email" s={data.email} days={data.days} />
            <Card>
              <h2 className="mb-3 text-lg font-semibold">People who said no</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat label="Replied STOP (WhatsApp)" value={data.optOuts.whatsappStopped} />
                <Stat label="Unsubscribed (email)" value={data.optOuts.emailUnsubscribed} />
                <Stat label="Bounced (email)" value={data.optOuts.emailBounced} sub="address does not exist" />
              </div>
              <p className="mt-3 text-xs text-stone-500">These people are never contacted again, in any campaign.</p>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
