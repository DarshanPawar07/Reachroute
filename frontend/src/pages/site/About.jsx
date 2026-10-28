import CtaBand from '../../components/site/CtaBand.jsx';
import { Breadcrumbs, Container, H1, H2, Lead, Section } from '../../components/site/parts.jsx';
import { ABOUT } from '../../site/content.js';
import { pageFor } from '../../site/seo.js';
import { PATHS, SITE } from '../../site/siteConfig.js';

export default function About() {
  return (
    <>
      <section className="pb-12 pt-10 sm:pb-16 sm:pt-14">
        <Container>
          <Breadcrumbs items={pageFor(PATHS.about).crumbs} />
          <H1 className="max-w-3xl">Bulk messaging for people who asked to hear from you</H1>
          <Lead className="mt-6">{ABOUT.lead}</Lead>
        </Container>
      </section>

      <Section tone="soft" label="What we believe">
        <H2>What we stand for</H2>
        <div className="mt-10 grid gap-x-14 sm:grid-cols-2">
          {ABOUT.principles.map((p) => (
            <div key={p.title} className="border-t-2 border-stone-900 py-6">
              <h3 className="text-xl font-semibold">{p.title}</h3>
              <p className="mt-2 leading-relaxed text-stone-600">{p.text}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section label="Where we are going">
        <H2>Where Reachroute is going</H2>
        <dl className="mt-8 divide-y divide-stone-200 border-y border-stone-200">
          {ABOUT.roadmap.map((r) => (
            <div key={r.when} className="grid gap-1 py-5 sm:grid-cols-[8rem_1fr] sm:gap-6">
              <dt className="font-display text-lg font-semibold">{r.when}</dt>
              <dd className="leading-relaxed text-stone-600">{r.what}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 text-sm text-stone-500">This describes what we intend to build, not a promise of dates.</p>
      </Section>

      {(SITE.operator || SITE.contactEmail) && (
        <Section tone="soft" label="Who runs it">
          <H2>Who runs Reachroute</H2>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-stone-600">
            Reachroute is run by {SITE.operator || 'its founder'}.{SITE.contactEmail ? ` You can write to ${SITE.contactEmail} at any time.` : ''}
          </p>
        </Section>
      )}

      <CtaBand title="Questions before you start?" text="Ask us anything about plans, limits or how sending works." secondary={{ label: 'Contact us', to: PATHS.contact }} />
    </>
  );
}
