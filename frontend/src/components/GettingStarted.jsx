import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';
import { buttonClass } from './ui.jsx';

const KEY = 'gettingStartedDismissed';
const read = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * A short checklist for a new account, on the dashboard. It works out what is done from the dashboard data, so it
 * needs no storage of its own, and goes away once every step is done (or when the person closes it).
 */
export default function GettingStarted({ data }) {
  const [hidden, setHidden] = useState(read);
  const channelReady = data.whatsapp.status === 'connected' || data.email.configured;
  const hasCampaign = (data.recent || []).length > 0;
  const steps = [
    {
      done: channelReady,
      title: 'Connect WhatsApp or add your email settings',
      text: 'Scan a QR code to link your WhatsApp, or enter your email (SMTP) details. It takes about two minutes.',
      links: [['/whatsapp', 'Connect WhatsApp'], ['/email/settings', 'Add email settings']],
    },
    {
      done: data.hasList || hasCampaign,
      title: 'Add your contacts',
      text: 'Upload a CSV or Excel file with names and phone numbers or emails. Save it as a list to use again.',
      links: [['/lists', 'Open contact lists']],
    },
    {
      done: hasCampaign,
      title: 'Send your first campaign',
      text: 'Start with only your own number or email, to see exactly what people will get. Then send to everyone.',
      links: [['/whatsapp/new', 'New WhatsApp campaign'], ['/email/new', 'New email campaign']],
    },
  ];
  const left = steps.filter((s) => !s.done).length;
  if (hidden || left === 0) return null;
  const next = steps.findIndex((s) => !s.done);

  const close = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* private window: it just comes back next time */
    }
    setHidden(true);
  };

  return (
    <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5" aria-labelledby="gs-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="gs-title" className="text-lg font-semibold text-stone-900">Get started: {steps.length - left} of {steps.length} done</h2>
          <p className="mt-0.5 text-sm text-stone-600">Three steps to your first campaign.</p>
        </div>
        <button type="button" onClick={close} className="rounded-lg p-1.5 text-stone-500 hover:bg-white hover:text-stone-800" aria-label="Close the checklist">
          <Icon name="close" className="h-4 w-4" />
        </button>
      </div>
      <ol className="mt-4 space-y-3">
        {steps.map((s, i) => (
          <li key={s.title} className={`flex gap-3 rounded-xl bg-white p-3.5 ${i === next ? 'ring-2 ring-emerald-500/30' : ''}`}>
            <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${s.done ? 'bg-emerald-600 text-white' : 'border border-stone-300 text-xs font-semibold text-stone-500'}`}>
              {s.done ? <Icon name="check" className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <div className="min-w-0">
              <p className={`font-medium ${s.done ? 'text-stone-500 line-through' : 'text-stone-900'}`}>{s.title}</p>
              {!s.done && (
                <>
                  <p className="mt-0.5 text-sm text-stone-600">{s.text}</p>
                  {i === next && (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {s.links.map(([to, label], j) => (
                        <Link key={to} to={to} className={buttonClass(j === 0 ? 'accent' : 'secondary', '!py-1.5')}>
                          {label}
                        </Link>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
