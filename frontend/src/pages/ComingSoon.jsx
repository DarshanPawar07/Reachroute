import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import { PageHeader } from '../components/ui.jsx';

const CHANNELS = {
  instagram: { name: 'Instagram', icon: 'instagram', tint: 'bg-ig-soft text-ig', topic: 'instagram', page: '/features/bulk-instagram-messaging' },
  facebook: { name: 'Facebook', icon: 'messenger', tint: 'bg-fb-soft text-fb', topic: 'facebook', page: '/features/bulk-facebook-messaging' },
};

/** Placeholder for a channel that is not built yet: says so plainly and points to what works today. */
export default function ComingSoon({ channel }) {
  const c = CHANNELS[channel];
  return (
    <>
      <PageHeader title={c.name} subtitle="Coming soon" />
      <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center sm:p-12">
        <span className={`mx-auto grid h-14 w-14 place-items-center rounded-2xl ${c.tint}`}>
          <Icon name={c.icon} className="h-7 w-7" />
        </span>
        <h2 className="mt-5 text-2xl font-semibold">{c.name} messaging is coming soon</h2>
        <p className="mx-auto mt-3 max-w-md leading-relaxed text-stone-600">
          We are working on it and will launch it in some time. It will use the same lists, templates, scheduling and reports as your WhatsApp and email campaigns.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Link to="/whatsapp" className="inline-flex rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700">
            Go to WhatsApp
          </Link>
          <Link to="/email" className="inline-flex rounded-xl border border-stone-300 px-5 py-2.5 text-sm font-semibold text-stone-900 transition hover:border-stone-500">
            Go to Email
          </Link>
        </div>
        <p className="mt-6 text-sm text-stone-500">
          Want it sooner? <Link to={`/contact?topic=${c.topic}`} className="font-medium text-stone-800 underline">Tell us how you would use it</Link>, or{' '}
          <Link to={c.page} className="font-medium text-stone-800 underline">read what we are planning</Link>.
        </p>
      </div>
    </>
  );
}
