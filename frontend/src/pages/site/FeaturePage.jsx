import { Link } from 'react-router-dom';
import ChannelPlans from '../../components/site/ChannelPlans.jsx';
import CtaBand from '../../components/site/CtaBand.jsx';
import Faq from '../../components/site/Faq.jsx';
import { BigLink, Breadcrumbs, CH, ChannelBadge, Container, H1, H2, Lead, Section, StatusChip } from '../../components/site/parts.jsx';
import { CHANNELS } from '../../site/content.js';
import { CHANNEL_EXTRA } from '../../site/channelContent.js';
import { pageFor } from '../../site/seo.js';
import { PATHS } from '../../site/siteConfig.js';

/** One page per channel. WhatsApp and email describe what works today; Instagram and Facebook say plainly they are planned. */
export default function FeaturePage({ channel: key }) {
  const c = CHANNELS[key];
  const x = CHANNEL_EXTRA[key];
  const style = CH[key];
  const live = c.status === 'live';
  const others = Object.values(CHANNELS).filter((o) => o.key !== key);

  return (
    <>
      <section className="pb-14 pt-10 sm:pb-20 sm:pt-14">
        <Container>
          <Breadcrumbs items={pageFor(c.path).crumbs} />
          <div className="mb-5 flex items-center gap-3">
            <ChannelBadge channel={c} className="h-11 w-11" />
            <StatusChip status={c.status} />
          </div>
          <H1 className="max-w-3xl">{c.h1}</H1>
          <Lead className="mt-6">{c.lead}</Lead>
          <div className="mt-8 flex flex-wrap gap-3">
            {live ? (
              <>
                <BigLink to={PATHS.register}>Start free</BigLink>
                <BigLink to={PATHS.pricing} variant="outline">See pricing</BigLink>
              </>
            ) : (
              <>
                <BigLink to={`${PATHS.contact}?topic=${key}`}>Tell us you want this</BigLink>
                <BigLink to={PATHS.whatsapp} variant="outline">Use WhatsApp and email today</BigLink>
              </>
            )}
          </div>
        </Container>
      </section>

      <Section tone="soft" label="Why it matters">
        <H2 className="max-w-3xl">{x.whyTitle}</H2>
        <Lead className="mt-5">{x.whyIntro}</Lead>
        <div className="mt-10 grid gap-x-14 sm:grid-cols-2">
          {x.why.map((w) => (
            <div key={w.title} className={`border-t-2 py-6 ${style.border}`}>
              <h3 className="text-xl font-semibold">{w.title}</h3>
              <p className="mt-2 leading-relaxed text-stone-600">{w.text}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section label="The process">
        <H2 className="max-w-3xl">{x.processTitle}</H2>
        <Lead className="mt-5">{x.processIntro}</Lead>
        <ol className="mt-10 divide-y divide-stone-200 border-y border-stone-200">
          {x.process.map((st, i) => (
            <li key={st.title} className="grid gap-x-10 gap-y-3 py-7 lg:grid-cols-[16rem_1fr_1fr]">
              <h3 className="flex items-start gap-3 text-xl font-semibold">
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${style.soft} ${style.text}`}>{i + 1}</span>
                {st.title}
              </h3>
              <p className="leading-relaxed text-stone-600">
                <span className="mb-1 block text-sm font-semibold text-stone-900">What it needs</span>
                {st.need}
              </p>
              <p className="leading-relaxed text-stone-600">
                <span className="mb-1 block text-sm font-semibold text-stone-900">{live ? 'What Reachroute does' : 'What we plan'}</span>
                {st.we}
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <Section tone="soft" label={live ? 'What it does' : 'What we are planning'}>
        <H2>{live ? `What bulk ${c.name} sending does` : 'The plan'}</H2>
        <div className="mt-10 grid gap-x-14 sm:grid-cols-2">
          {c.sections.map((s) => (
            <div key={s.title} className={`border-t-2 py-6 ${style.border}`}>
              <h3 className="text-xl font-semibold">{s.title}</h3>
              <p className="mt-2 leading-relaxed text-stone-600">{s.text}</p>
            </div>
          ))}
        </div>
      </Section>

      {live && (
        <Section label="Limits and facts">
          <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
            <div>
              <H2>The numbers</H2>
              <dl className="mt-6 divide-y divide-stone-200 border-y border-stone-200">
                {c.specs.map(([k, v]) => (
                  <div key={k} className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-3.5">
                    <dt className="text-stone-600">{k}</dt>
                    <dd className="font-semibold text-stone-900">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 text-sm text-stone-500">
                Paid plans raise these limits. <Link to={PATHS.pricing} className="font-semibold text-emerald-700 underline">Compare plans</Link>.
              </p>
            </div>
            <aside className="rounded-2xl border border-amber-200 bg-amber-50 p-6 self-start">
              <h3 className="text-lg font-semibold text-amber-950">{c.goodToKnow.title}</h3>
              <p className="mt-2 leading-relaxed text-amber-950/85">{c.goodToKnow.text}</p>
            </aside>
          </div>
        </Section>
      )}

      <Section tone={live ? 'soft' : 'plain'} label="Plans">
        <H2>{x.plansTitle}</H2>
        <Lead className="mt-4">{live ? 'Start free and move up when you need more volume. Every plan includes every feature; only the limits change.' : 'These are the plans we expect to offer. Nothing here can be bought yet.'}</Lead>
        <div className="mt-10">
          <ChannelPlans channel={c} extra={x} />
        </div>
      </Section>

      <Section tone={live ? 'plain' : 'soft'} label="Questions">
        <div className="max-w-3xl">
          <Faq items={c.faq} title={`${c.short} questions`} />
        </div>
      </Section>

      <Section label="Other channels">
        <H2 className="!text-2xl sm:!text-3xl">More ways to reach people</H2>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {others.map((o) => (
            <Link key={o.key} to={o.path} className="flex gap-3 rounded-2xl border border-stone-200 bg-white p-5 transition hover:border-stone-400">
              <ChannelBadge channel={o} />
              <div>
                <div className="font-display text-lg font-semibold">{o.short}</div>
                <div className="mt-0.5 text-sm text-stone-600">{o.status === 'live' ? 'Available now' : 'Planned'}</div>
              </div>
            </Link>
          ))}
        </div>
      </Section>

      <CtaBand
        title={live ? `Send your first ${c.name} campaign` : 'Start with WhatsApp and email today'}
        text={live ? 'The free plan needs no card and has no time limit.' : 'Create a free account now. When Instagram and Facebook are ready, they will be in the same place.'}
        secondary={live ? { label: 'See pricing', to: PATHS.pricing } : { label: 'Tell us what you need', to: `${PATHS.contact}?topic=${key}` }}
      />
    </>
  );
}
