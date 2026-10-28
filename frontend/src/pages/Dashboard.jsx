import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';
import SentChart from '../components/SentChart.jsx';
import { fmtDate } from '../lib/kinds.js';
import AllowanceBanner from '../components/AllowanceBanner.jsx';
import GettingStarted from '../components/GettingStarted.jsx';
import { Alert, Badge, Button, Card, LinkButton, PageHeader, Stat } from '../components/ui.jsx';

const RANGES = [7, 30, 90];
const TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

/** One channel: its state, how much of today's limit is used, and the two things you do next. */
function ChannelTile({ name, icon, tint, bar, status, ready, sent, cap, left, openTo, newTo, hint }) {
  const pct = cap ? Math.min(100, Math.round((sent / cap) * 100)) : 0;
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`grid h-11 w-11 place-items-center rounded-xl ${tint}`}>
            <Icon name={icon} className="h-6 w-6" />
          </span>
          <h2 className="text-xl font-semibold">{name}</h2>
        </div>
        {status && <Badge status={status} />}
      </div>

      <div className="mt-6">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-4xl font-semibold tabular-nums">{sent ?? '-'}</span>
          <span className="text-sm text-stone-600">sent in the last 24 hours</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-200" role="img" aria-label={`${pct}% of today's limit used`}>
          <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-sm text-stone-600">{cap ? `${left} of ${cap} left today` : ' '}</p>
      </div>

      {hint && <div className="mt-4">{hint}</div>}

      <div className="mt-auto flex flex-wrap gap-2 pt-6">
        <LinkButton to={newTo} variant="accent" disabled={!ready}>
          <Icon name="plus" className="h-4 w-4" />
          New campaign
        </LinkButton>
        <LinkButton to={openTo} variant="secondary">
          Open {name}
        </LinkButton>
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [range, setRange] = useState(30);
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState('');

  useEffect(() => {
    api('/api/dashboard')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  // The charts: how much went out each day, per channel. A failure here must not hide the rest of the dashboard.
  useEffect(() => {
    let live = true;
    setStatsError('');
    api(`/api/stats?days=${range}&tz=${encodeURIComponent(TIME_ZONE)}`)
      .then((r) => live && setStats(r))
      .catch((e) => live && setStatsError(e.message));
    return () => {
      live = false;
    };
  }, [range]);

  const days = stats ? stats.whatsapp.daily.map((d, i) => ({ date: d.date, whatsapp: d.sent, email: stats.email.daily[i]?.sent || 0 })) : [];
  const sent = stats ? stats.whatsapp.sent + stats.email.sent : 0;
  const failed = stats ? stats.whatsapp.failed + stats.email.failed : 0;
  const rate = sent + failed ? Math.round((sent / (sent + failed)) * 1000) / 10 : null;
  const optOuts = stats ? stats.optOuts.whatsappStopped + stats.optOuts.emailUnsubscribed + stats.optOuts.emailBounced + stats.optOuts.emailComplaints : 0;

  return (
    <>
      <PageHeader title="What would you like to send?" subtitle="Pick a channel to start a campaign. Your limits for today are shown below." />
      <div className="mb-5 space-y-4">
        <AllowanceBanner />
        {data && <GettingStarted data={data} />}
      </div>
      {error && <Alert>{error}</Alert>}

      <div className="grid gap-5 md:grid-cols-2">
        <ChannelTile
          name="WhatsApp"
          icon="whatsapp"
          tint="bg-wa-soft text-wa"
          bar="bg-wa"
          status={data?.whatsapp.status}
          ready={data?.whatsapp.status === 'connected'}
          sent={data?.whatsapp.sentLast24h}
          cap={data?.whatsapp.dailyCap}
          left={data?.whatsapp.remainingToday}
          openTo="/whatsapp"
          newTo="/whatsapp/new"
          hint={
            data && data.whatsapp.status !== 'connected' ? (
              <p className="text-sm text-stone-600">
                Link your WhatsApp number first.{' '}
                <Link className="font-semibold text-emerald-700 underline" to="/whatsapp">
                  Scan the QR code
                </Link>
              </p>
            ) : null
          }
        />
        <ChannelTile
          name="Email"
          icon="mail"
          tint="bg-mail-soft text-mail"
          bar="bg-mail"
          status={data ? (data.email.configured ? 'connected' : 'disconnected') : null}
          ready={Boolean(data?.email.configured)}
          sent={data?.email.sentLast24h}
          cap={data?.email.dailyCap}
          left={data?.email.remainingToday}
          openTo="/email"
          newTo="/email/new"
          hint={
            data && !data.email.configured ? (
              <p className="text-sm text-stone-600">
                Add your SMTP details to start sending.{' '}
                <Link className="font-semibold text-emerald-700 underline" to="/email/settings">
                  Open email settings
                </Link>
              </p>
            ) : null
          }
        />
      </div>

      <Card className="mt-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Activity</h2>
            <p className="text-sm text-stone-600">Messages sent per day, in the last {range} days.</p>
          </div>
          <div className="flex gap-1.5" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <Button key={r} variant={r === range ? 'accent' : 'secondary'} className="!px-3 !py-1.5 text-sm" onClick={() => setRange(r)} aria-pressed={r === range}>
                {r} days
              </Button>
            ))}
          </div>
        </div>
        {statsError && <Alert>{statsError}</Alert>}
        {!stats && !statsError && <p className="py-6 text-sm text-stone-500">Loading...</p>}
        {stats && (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Sent" value={sent} sub={`in ${range} days`} />
              <Stat label="Success rate" value={rate === null ? '-' : `${rate}%`} sub={rate === null ? 'nothing sent yet' : 'of messages tried'} />
              <Stat label="Failed" value={failed} />
              <Stat label="Opted out" value={optOuts} sub="all time" />
            </div>
            {sent + failed === 0 ? (
              <p className="rounded-xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-600">Nothing sent in this period yet. Your daily activity will show up here.</p>
            ) : (
              <SentChart days={days} />
            )}
          </>
        )}
      </Card>

      <Card className="mt-5">
        <h2 className="mb-1 text-lg font-semibold">Recent campaigns</h2>
        {data && data.recent.length === 0 && <p className="py-4 text-sm text-stone-600">Nothing sent yet. Your campaigns will appear here once you start one.</p>}
        <div className="divide-y divide-stone-100">
          {data?.recent.map((c) => (
            <Link key={c.id} to={`/${c.kind}/campaigns/${c.id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-xl px-2 py-3.5 transition hover:bg-stone-50">
              <div className="flex min-w-0 items-center gap-3">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${c.kind === 'whatsapp' ? 'bg-wa-soft text-wa' : 'bg-mail-soft text-mail'}`}>
                  <Icon name={c.kind === 'whatsapp' ? 'whatsapp' : 'mail'} className="h-[1.1rem] w-[1.1rem]" />
                </span>
                <div className="min-w-0">
                  <div className="truncate font-semibold">{c.name}</div>
                  <div className="text-[0.8rem] text-stone-500">
                    {c.sentCount} of {c.total} sent, {fmtDate(c.createdAt)}
                  </div>
                </div>
              </div>
              <Badge status={c.status} />
            </Link>
          ))}
        </div>
      </Card>
    </>
  );
}
