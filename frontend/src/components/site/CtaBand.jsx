import { PATHS } from '../../site/siteConfig.js';
import { BigLink, Container } from './parts.jsx';

export default function CtaBand({ title = 'Send your first campaign today', text = 'The free plan includes 50 WhatsApp messages and 100 emails. No card needed.', secondary = { label: 'See pricing', to: PATHS.pricing } }) {
  return (
    <section aria-label="Get started" className="bg-stone-900 py-16 sm:py-20">
      <Container className="flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
        <div className="max-w-xl">
          <h2 className="text-[1.85rem] font-semibold leading-[1.12] !text-white sm:text-4xl">{title}</h2>
          <p className="mt-3 text-lg text-stone-300">{text}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <BigLink to={PATHS.register} variant="accent">Start free</BigLink>
          {secondary && <BigLink to={secondary.to} variant="outlineLight">{secondary.label}</BigLink>}
        </div>
      </Container>
    </section>
  );
}
