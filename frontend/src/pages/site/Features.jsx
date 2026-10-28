import { Link } from 'react-router-dom';
import CtaBand from '../../components/site/CtaBand.jsx';
import { Breadcrumbs, ChannelBadge, Container, H1, H2, Lead, Section, StatusChip } from '../../components/site/parts.jsx';
import { CHANNEL_LIST, FEATURE_LEDGER, HOW_IT_WORKS } from '../../site/content.js';
import { pageFor } from '../../site/seo.js';
import { PATHS } from '../../site/siteConfig.js';

export default function Features() {
  return (
    <>
      <section className="pb-12 pt-10 sm:pb-16 sm:pt-14">
        <Container>
          <Breadcrumbs items={pageFor(PATHS.features).crumbs} />
          <H1 className="max-w-3xl">Everything you need to send bulk WhatsApp messages and emails</H1>
          <Lead className="mt-6">Personalised messages, a safe sending pace, scheduling, templates, contact lists, reports and automatic opt-out handling, for WhatsApp and email, in one place.</Lead>
        </Container>
      </section>

      <Section tone="soft" label="Channels">
        <H2>Channels</H2>
        <div className="mt-8 divide-y divide-stone-200 border-y border-stone-200">
          {CHANNEL_LIST.map((c) => (
            <Link key={c.key} to={c.path} className="flex flex-col gap-3 py-6 transition hover:bg-stone-50 sm:flex-row sm:items-center sm:gap-6">
              <ChannelBadge channel={c} className="h-12 w-12" />
              <div className="flex-1">
                <h3 className="text-xl font-semibold">{c.short}</h3>
                <p className="mt-1 text-stone-600">{c.summary}</p>
              </div>
              <StatusChip status={c.status} />
            </Link>
          ))}
        </div>
      </Section>

      <Section label="All features">
        <H2>The details</H2>
        <dl className="mt-8 grid gap-x-12 sm:grid-cols-2">
          {FEATURE_LEDGER.map((f) => (
            <div key={f.title} className="border-t border-stone-200 py-6">
              <dt className="font-display text-lg font-semibold">{f.title}</dt>
              <dd className="mt-1.5 leading-relaxed text-stone-600">{f.text}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section tone="soft" label="How it works">
        <H2>How a campaign works</H2>
        <ol className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
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

      <CtaBand />
    </>
  );
}
