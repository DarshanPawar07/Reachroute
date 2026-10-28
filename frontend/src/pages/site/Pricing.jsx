import { Link } from 'react-router-dom';
import { API_BASE } from '../../api.js';
import CtaBand from '../../components/site/CtaBand.jsx';
import Faq from '../../components/site/Faq.jsx';
import { CompareTable, IncludedList, PlanCards } from '../../components/site/PlansTable.jsx';
import { Breadcrumbs, Container, H1, H2, Lead, Section } from '../../components/site/parts.jsx';
import { PRICING_FAQ } from '../../site/content.js';
import { pageFor } from '../../site/seo.js';
import { PATHS } from '../../site/siteConfig.js';

export default function Pricing() {
  return (
    <>
      <section className="pb-12 pt-10 sm:pb-16 sm:pt-14">
        <Container>
          <Breadcrumbs items={pageFor(PATHS.pricing).crumbs} />
          <H1 className="max-w-3xl">Free to start. Pay when your volume grows.</H1>
          <Lead className="mt-6">
            The free plan gives you 50 WhatsApp messages and 100 emails to try it with, and every feature is included. Pro and Premium add monthly volume, daily limits and bigger lists. There are no per-message fees.
          </Lead>
        </Container>
      </section>

      <Section tone="soft" label="Plans" className="!pt-12 sm:!pt-16">
        <PlanCards />
        <p className="mt-6 max-w-3xl text-[0.95rem] leading-relaxed text-stone-600">
          Pro and Premium are paid every month or every year through Razorpay (UPI, cards and net banking). Cancel any time and keep the plan until the period you paid for ends. Need more? <Link to={`${PATHS.contact}?topic=plans&plan=business`} className="font-semibold text-emerald-700 underline">Talk to us about Business</Link>. Prices are in Indian rupees. Read the <a href={`${API_BASE}/legal/refunds`} className="font-semibold text-emerald-700 underline">refund and cancellation policy</a>.
        </p>
      </Section>

      <Section label="Compare plans">
        <H2 className="mb-8">Every limit, side by side</H2>
        <CompareTable />
        <p className="mt-4 text-sm text-stone-500">Daily limits count the last 24 hours. The monthly amount counts WhatsApp and email together over the last 30 days. The free allowance never refills. Your email provider and WhatsApp apply their own limits as well.</p>
      </Section>

      <Section tone="soft" label="Included in every plan">
        <H2 className="mb-8">Included in every plan, free too</H2>
        <IncludedList />
      </Section>

      <Section label="Questions">
        <div className="max-w-3xl">
          <Faq items={PRICING_FAQ} title="Pricing questions" />
        </div>
      </Section>

      <CtaBand title="Try it on the free plan" text="Create an account, upload a list and send your first campaign today." secondary={{ label: 'See Pro and Premium', to: '/billing?plan=pro' }} />
    </>
  );
}
