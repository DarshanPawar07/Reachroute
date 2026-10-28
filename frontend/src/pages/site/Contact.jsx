import { Breadcrumbs, Container, H1, Lead } from '../../components/site/parts.jsx';
import ContactForm from '../../components/site/ContactForm.jsx';
import { pageFor } from '../../site/seo.js';
import { PATHS, SITE } from '../../site/siteConfig.js';

export default function Contact() {
  return (
    <section className="pb-20 pt-10 sm:pb-28 sm:pt-14">
      <Container>
        <Breadcrumbs items={pageFor(PATHS.contact).crumbs} />
        <H1 className="max-w-3xl">Talk to us</H1>
        <Lead className="mt-5">Ask about a plan, get help with a campaign, or tell us you want Instagram or Facebook Messenger. A person reads every message.</Lead>
        <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-20">
          <div className="rounded-2xl border border-stone-200 bg-white p-6 sm:p-8">
            <ContactForm />
          </div>
          <div className="space-y-8">
            <div>
              <h2 className="text-xl font-semibold">How we reply</h2>
              <p className="mt-2 leading-relaxed text-stone-600">{SITE.replyTime}</p>
            </div>
            {SITE.contactEmail && (
              <div>
                <h2 className="text-xl font-semibold">Email</h2>
                <p className="mt-2">
                  <a href={`mailto:${SITE.contactEmail}`} className="font-semibold text-emerald-700 underline">{SITE.contactEmail}</a>
                </p>
              </div>
            )}
            <div>
              <h2 className="text-xl font-semibold">Getting a paid plan</h2>
              <p className="mt-2 leading-relaxed text-stone-600">Choose “A paid plan or pricing”, say which plan you want, and we reply with the amount and how to pay.</p>
            </div>
            <div>
              <h2 className="text-xl font-semibold">Already a customer?</h2>
              <p className="mt-2 leading-relaxed text-stone-600">Log in and include the email address of your account in your message, so we can find it.</p>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
