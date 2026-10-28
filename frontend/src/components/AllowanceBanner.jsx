import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { buttonClass } from './ui.jsx';

const n = (v) => Number(v).toLocaleString('en-IN');

/**
 * What is left of the plan's totals: the free allowance (a one-time number of WhatsApp messages and emails)
 * or, on Pro and Premium, the monthly amount once it is nearly used. Shows nothing when there is nothing to say.
 */
export default function AllowanceBanner({ channel }) {
  const [quota, setQuota] = useState(null);
  useEffect(() => {
    api('/api/account/plan')
      .then((r) => setQuota(r.quota))
      .catch(() => {});
  }, []);
  if (!quota) return null;

  const { whatsapp, email } = quota.lifetime;
  const month = quota.month;
  const items = [];
  if (whatsapp.cap > 0) items.push({ key: 'whatsapp', label: 'WhatsApp messages', ...whatsapp });
  if (email.cap > 0) items.push({ key: 'email', label: 'emails', ...email });
  const shown = channel ? items.filter((i) => i.key === channel) : items;

  let tone = 'info';
  let text = null;
  if (shown.length) {
    const out = shown.some((i) => i.left === 0);
    const low = shown.some((i) => i.left <= i.cap * 0.2);
    tone = out ? 'out' : low ? 'low' : 'info';
    text = out
      ? `Your free ${shown.filter((i) => i.left === 0).map((i) => i.label).join(' and ')} ${shown.filter((i) => i.left === 0).length > 1 ? 'are' : 'is'} used up. Choose a plan to keep sending.`
      : `Free allowance left: ${shown.map((i) => `${n(i.left)} of ${n(i.cap)} ${i.label}`).join(', ')}. It does not refill.`;
  } else if (month.cap > 0 && month.used >= month.cap * 0.8) {
    tone = month.left === 0 ? 'out' : 'low';
    text = month.left === 0 ? `You have used all ${n(month.cap)} messages for the last 30 days. Moving to a bigger plan lifts the limit.` : `${n(month.used)} of ${n(month.cap)} messages used in the last 30 days.`;
  }
  if (!text) return null;

  const colors = { info: 'border-stone-200 bg-stone-100 text-stone-700', low: 'border-amber-200 bg-amber-50 text-amber-900', out: 'border-red-200 bg-red-50 text-red-900' };
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${colors[tone]}`} role="status">
      <span>{text}</span>
      <Link to="/billing" className={buttonClass(tone === 'info' ? 'secondary' : 'accent', '!py-1.5')}>
        {tone === 'info' ? 'See plans' : 'Upgrade'}
      </Link>
    </div>
  );
}
