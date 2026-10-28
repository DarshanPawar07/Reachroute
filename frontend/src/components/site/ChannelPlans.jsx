import { Link } from 'react-router-dom';
import { PLANS } from '../../site/plans.js';
import { PATHS } from '../../site/siteConfig.js';
import Icon from '../Icon.jsx';

const SHOWN = ['free', 'pro', 'premium'];

// What we can say about each plan on a channel that is not built yet: nothing about limits or prices, because none are decided.
const PLANNED = {
  free: 'A small allowance so you can try it. Details will be announced.',
  pro: 'More volume for regular use. Limits and price are not decided yet.',
  premium: 'The highest volume. Limits and price are not decided yet.',
};

/** Free, Pro and Premium for one channel: the real limits when the channel works, an honest "planned" when it does not. */
export default function ChannelPlans({ channel, extra }) {
  const live = channel.status === 'live';
  const plans = PLANS.filter((p) => SHOWN.includes(p.key));

  return (
    <div>
      <div className="grid gap-5 md:grid-cols-3">
        {plans.map((p) => {
          const free = p.key === 'free';
          return (
            <article key={p.key} className={`flex flex-col rounded-2xl border p-6 ${free ? 'border-emerald-600 bg-white ring-4 ring-emerald-600/10' : 'border-stone-200 bg-white'}`}>
              <h3 className="text-xl font-semibold">{p.name}</h3>
              <p className="mt-3 flex items-baseline gap-2">
                <span className="font-display text-4xl font-semibold tracking-tight text-stone-900">{live ? p.priceLabel : 'Planned'}</span>
                {live && <span className="text-sm text-stone-500">{p.period}</span>}
              </p>
              {live && p.yearlyLabel && <p className="mt-1 text-sm font-medium text-emerald-700">or {p.yearlyLabel}</p>}
              {live ? (
                <dl className="mb-6 mt-5 divide-y divide-stone-100 text-[0.95rem]">
                  {extra.planRows.map(([label, key]) => (
                    <div key={key} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-2.5">
                      <dt className="text-stone-600">{label}</dt>
                      <dd className="font-semibold tabular-nums text-stone-900">{p.limits[key]}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mb-6 mt-4 leading-relaxed text-stone-600">{PLANNED[p.key]}</p>
              )}
              {live ? (
                <Link
                  to={p.cta.to}
                  className={`mt-auto inline-flex justify-center rounded-xl px-4 py-3 text-sm font-semibold transition ${free ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'border border-stone-300 text-stone-900 hover:border-stone-500'}`}
                >
                  {p.cta.label}
                </Link>
              ) : (
                <Link to={`${PATHS.contact}?topic=${channel.key}`} className="mt-auto inline-flex justify-center rounded-xl border border-stone-300 px-4 py-3 text-sm font-semibold text-stone-900 transition hover:border-stone-500">
                  Tell us you want this
                </Link>
              )}
            </article>
          );
        })}
      </div>
      <p className="mt-5 flex gap-2 text-sm text-stone-500">
        <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        {live ? (
          <span>
            Pro and Premium are paid monthly or yearly through Razorpay, and you can cancel any time. Prices are in Indian rupees, with no per-message fees. <Link to={PATHS.pricing} className="font-semibold text-emerald-700 underline">Compare every limit</Link>.
          </span>
        ) : (
          <span>
            {channel.name} is not available yet, so there is nothing to buy. WhatsApp and email are available today on the <Link to={PATHS.pricing} className="font-semibold text-emerald-700 underline">plans here</Link>.
          </span>
        )}
      </p>
    </div>
  );
}
