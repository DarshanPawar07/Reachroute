import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { API_BASE } from '../../api.js';
import { Alert, Button, Field } from '../ui.jsx';

const TOPICS = [
  { value: 'plans', label: 'A paid plan or pricing' },
  { value: 'support', label: 'Help with a campaign' },
  { value: 'instagram', label: 'I want Instagram messaging' },
  { value: 'facebook', label: 'I want Facebook Messenger' },
  { value: 'other', label: 'Something else' },
];

const field = 'w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-[0.95rem] text-stone-900 placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20';

export default function ContactForm() {
  const [params] = useSearchParams();
  const [form, setForm] = useState({ name: '', email: '', topic: 'plans', plan: '', message: '', website: '' });
  const [state, setState] = useState({ status: 'idle', error: '' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // The link from a pricing card says which topic and plan: read after the page loads, so the pre-built page stays the same for everyone.
  useEffect(() => {
    const topic = params.get('topic');
    const plan = params.get('plan') || '';
    setForm((f) => ({
      ...f,
      topic: TOPICS.some((t) => t.value === topic) ? topic : f.topic,
      plan,
      message: f.message || (plan ? `I would like to know more about the ${plan[0].toUpperCase()}${plan.slice(1)} plan.\n\n` : ''),
    }));
  }, [params]);

  const submit = async (e) => {
    e.preventDefault();
    setState({ status: 'sending', error: '' });
    try {
      const res = await fetch(`${API_BASE}/api/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Your message could not be sent. Please try again.');
      setState({ status: 'sent', error: '' });
    } catch (err) {
      setState({ status: 'idle', error: err instanceof TypeError ? 'Could not reach the server. Check your connection and try again.' : err.message });
    }
  };

  if (state.status === 'sent') {
    return (
      <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
        <h2 className="text-xl font-semibold text-emerald-900">Message sent</h2>
        <p className="mt-2 text-emerald-900/80">Thank you, {form.name.split(' ')[0] || 'we have it'}. We will reply to {form.email}.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate={false}>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Your name">
          <input className={field} required maxLength={100} autoComplete="name" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Your email" hint="We reply here.">
          <input className={field} type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
        </Field>
      </div>
      <Field label="What is it about?">
        <select className={field} value={form.topic} onChange={set('topic')}>
          {TOPICS.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </Field>
      <Field label="Your message">
        <textarea className={field} rows={6} required minLength={10} maxLength={4000} value={form.message} onChange={set('message')} />
      </Field>
      {/* Real people never see or fill this one; bots do. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>Leave this empty<input tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} /></label>
      </div>
      {state.error && <Alert>{state.error}</Alert>}
      <Button type="submit" variant="accent" disabled={state.status === 'sending'} className="!px-6 !py-3.5 !text-[0.95rem]">
        {state.status === 'sending' ? 'Sending...' : 'Send message'}
      </Button>
    </form>
  );
}
