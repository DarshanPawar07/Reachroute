import { Link } from 'react-router-dom';
import CtaBand from '../../components/site/CtaBand.jsx';
import Faq from '../../components/site/Faq.jsx';
import { PlanCards } from '../../components/site/PlansTable.jsx';
import RouteMap from '../../components/site/RouteMap.jsx';
import { BigLink, ChannelBadge, Container, H1, H2, Lead, Section, StatusChip } from '../../components/site/parts.jsx';
import Icon from '../../components/Icon.jsx';
import { CHANNEL_LIST, FEATURE_LEDGER, HOME_FAQ, HOW_IT_WORKS, RESPONSIBLE, USE_CASES } from '../../site/content.js';
import { PATHS } from '../../site/siteConfig.js';

export default function Home() {
  return (
    <>
      <section aria-label="Introduction" className="pb-16 pt-12 sm:pb-24 sm:pt-20">
        <Container className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <div>
            <H1>Bulk WhatsApp and email, sent at a pace that keeps you safe</H1>
            <Lead className="mt-6">
              Upload your contacts, write the message once, and Reachroute sends it one person at a time from your own WhatsApp number and your own email account. Then it shows you exactly who received it.
            </Lead>
            <div className="mt-8 flex flex-wrap gap-3">
              <BigLink to={PATHS.register}>Start free</BigLink>
              <BigLink to={PATHS.pricing} variant="outline">See pricing</BigLink>
            </div>
            <p className="mt-5 text-[0.95rem] text-stone-600">Free plan: 50 WhatsApp messages and 100 emails to try it. No card needed.</p>
          </div>
          <div className="rounded-3xl border border-stone-200 bg-white p-6 sm:p-8">
            <RouteMap />
          </div>
        </Container>
      </section>

      <Section tone="soft" id="channels" label="Channels">
        <H2>One list, every channel you use</H2>
        <Lead className="mt-4">Start with WhatsApp and email today. Instagram and Facebook Messenger are on the way.</Lead>
        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          {CHANNEL_LIST.map((c) => (
            <Link key={c.key} to={c.path} className="group flex gap-4 rounded-2xl border border-stone-200 bg-stone-50 p-6 transition hover:border-stone-400">
              <ChannelBadge channel={c} className="h-12 w-12" />
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-xl font-semibold">{c.short}</h3>
                  <StatusChip status={c.status} />
                </div>
                <p className="mt-2 text-[0.97rem] leading-relaxed text-stone-600">{c.summary}</p>
                <span className="mt-3 inline-block text-sm font-semibold text-emerald-700 group-hover:underline">{c.status === 'live' ? `How ${c.name} sending works` : 'What we are planning'}</span>
              </div>
            </Link>
          ))}
        </div>
      </Section>

      <Section id="how-it-works" label="How it works">
        <H2>From a spreadsheet to a sent campaign in four steps</H2>
        <ol className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2">
          {HOW_IT_WORKS.map((s, i) => (
            <li key={s.title} className="flex gap-5">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-stone-900 font-display text-lg font-semibold text-white">{i + 1}</span>
              <div>
                <h3 className="text-xl font-semibold">{s.title}</h3>
                <p className="mt-2 leading-relaxed text-stone-600">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section tone="soft" id="features" label="Features">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <H2 className="max-w-xl">What you get on every plan</H2>
          <Link to={PATHS.features} className="text-sm font-semibold text-emerald-700 hover:underline">All features</Link>
        </div>
        <dl className="mt-10 grid gap-x-12 sm:grid-cols-2">
          {FEATURE_LEDGER.map((f) => (
            <div key={f.title} className="border-t border-stone-200 py-6">
              <dt className="font-display text-lg font-semibold text-stone-900">{f.title}</dt>
              <dd className="mt-1.5 leading-relaxed text-stone-600">{f.text}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section tone="ink" id="responsible" label="Responsible sending">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
          <div>
            <H2 light>Built for people who asked to hear from you</H2>
            <Lead light className="mt-4">Bulk messaging only works when people want the messages. Reachroute is designed around that, and it will not help you spam.</Lead>
          </div>
          <ul className="space-y-5">
            {RESPONSIBLE.map((r) => (
              <li key={r} className="flex gap-3.5 text-[1.02rem] leading-relaxed text-stone-200">
                <Icon name="shield" className="mt-1 h-5 w-5 shrink-0 text-emerald-400" />
                {r}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section id="use-cases" label="Who uses it">
        <H2>Made for people who message their own customers</H2>
        <div className="mt-10 grid gap-x-12 sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map((u) => (
            <div key={u.who} className="border-t border-stone-200 py-6">
              <h3 className="text-lg font-semibold">{u.who}</h3>
              <p className="mt-1.5 leading-relaxed text-stone-600">{u.what}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section tone="soft" id="pricing" label="Pricing">
        <div className="mb-10 max-w-2xl">
          <H2>Start free. Pay only when you outgrow it.</H2>
          <Lead className="mt-4">The free plan includes 50 WhatsApp messages and 100 emails to try it with. Pro and Premium add monthly volume and higher daily limits. There are no per-message fees on any plan.</Lead>
        </div>
        <PlanCards />
        <p className="mt-6 text-[0.95rem] text-stone-600">
          Compare every limit on the <Link to={PATHS.pricing} className="font-semibold text-emerald-700 underline">pricing page</Link>.
        </p>
      </Section>

      <Section id="faq" label="Questions">
        <div className="max-w-3xl">
          <Faq items={HOME_FAQ} title="Questions people ask before they start" />
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
