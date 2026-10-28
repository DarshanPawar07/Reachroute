import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { API_BASE, api } from '../api.js';
import { Alert, Button, Card, Field, Input, PageHeader, Textarea } from '../components/ui.jsx';
import { askConfirm } from '../components/ConfirmDialog.jsx';

const n = (v) => Number(v).toLocaleString('en-IN');
const rupees = (v) => `₹${n(v)}`;
const date = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

/** Razorpay's payment window script, loaded once when first needed. */
function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('The payment window could not be loaded. Check your internet connection and try again.'));
    document.head.appendChild(s);
  });
}

function Meter({ label, used, cap }) {
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-stone-700">{label}</span>
        <span className="font-medium tabular-nums">{n(used)} of {n(cap)}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={cap} aria-label={label}>
        <div className={`h-full rounded-full ${pct >= 90 ? 'bg-amber-500' : 'bg-emerald-600'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** The few numbers that tell plans apart, from what the server says right now. */
function facts(l) {
  const out = [];
  if (l.waLifetimeCap || l.emailLifetimeCap) out.push(`${n(l.waLifetimeCap)} WhatsApp + ${n(l.emailLifetimeCap)} emails in total, not refilled`);
  if (l.monthlyCap) out.push(`${n(l.monthlyCap)} messages a month`);
  out.push(`${n(l.waDailyCap)} WhatsApp a day (${n(l.waHourlyCap)} an hour)`);
  out.push(`${n(l.emailDailyCap)} emails a day`);
  out.push(`${n(l.maxActiveCampaigns)} campaign${l.maxActiveCampaigns === 1 ? '' : 's'} at once`);
  out.push(`${n(l.waMaxUpload)} WhatsApp / ${n(l.emailMaxUpload)} email contacts per upload`);
  return out;
}

const ROWS = [
  ['Included messages', (l) => (l.monthlyCap ? `${n(l.monthlyCap)} a month` : l.waLifetimeCap || l.emailLifetimeCap ? `${n(l.waLifetimeCap)} WhatsApp + ${n(l.emailLifetimeCap)} emails, once` : 'No total limit')],
  ['WhatsApp a day', (l) => n(l.waDailyCap)],
  ['WhatsApp an hour', (l) => n(l.waHourlyCap)],
  ['Emails a day', (l) => n(l.emailDailyCap)],
  ['Campaigns at once', (l) => n(l.maxActiveCampaigns)],
  ['Contacts per WhatsApp upload', (l) => n(l.waMaxUpload)],
  ['Contacts per email upload', (l) => n(l.emailMaxUpload)],
  ['Saved contact lists', (l) => n(l.maxLists)],
  ['Saved templates', (l) => n(l.maxTemplates)],
  ['Attachment size (WhatsApp / email)', (l) => `${n(l.waAttachmentMb)} / ${n(l.emailAttachmentMb)} MB`],
];

/** The plans side by side, so "what do I get on Pro?" is one glance. Prices follow the Monthly / Yearly switch. */
function Compare({ plans, current, interval }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Compare plans</h2>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-sm font-semibold text-emerald-700 underline">{open ? 'Hide comparison' : 'Show comparison'}</button>
      </div>
      {!open && <p className="text-sm text-stone-600">See every limit for every plan in one table.</p>}
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead>
              <tr className="border-b border-stone-200">
                <th className="py-2 pr-3 font-medium text-stone-500"><span className="sr-only">Limit</span></th>
                {plans.map((p) => {
                  const price = interval === 'year' ? p.priceYearly : p.priceMonthly;
                  return (
                    <th key={p.key} className={`px-3 py-2 align-bottom ${current === p.key ? 'bg-emerald-50' : ''}`}>
                      <span className="block font-semibold">{p.name}{current === p.key && <span className="ml-1.5 text-xs font-medium text-emerald-700">yours</span>}</span>
                      <span className="block text-xs font-normal text-stone-600">{price > 0 ? `${rupees(price)} ${interval === 'year' ? 'a year' : 'a month'}` : '₹0'}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {ROWS.map(([label, get]) => (
                <tr key={label}>
                  <th scope="row" className="py-2 pr-3 font-normal text-stone-700">{label}</th>
                  {plans.map((p) => <td key={p.key} className={`px-3 py-2 tabular-nums ${current === p.key ? 'bg-emerald-50' : ''}`}>{get(p.limits)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Chandigarh', 'Puducherry', 'Andaman and Nicobar Islands', 'Dadra and Nagar Haveli and Daman and Diu', 'Lakshadweep'];

/** Name, address and GSTIN printed on invoices. They apply to invoices made from now on. */
function BillingDetails({ initial }) {
  const [form, setForm] = useState(initial);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/billing/profile', { method: 'PUT', body: form });
      setMsg({ kind: 'success', text: 'Saved. New invoices will use these details.' });
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Card>
      <form onSubmit={save} className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Billing details</h2>
          <p className="text-sm text-stone-600">Printed on your invoices. Add them before you pay if you need them on the invoice, because old invoices do not change.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name or business name"><Input maxLength={120} value={form.name} onChange={set('name')} /></Field>
          <Field label="GSTIN (if you have one)"><Input maxLength={15} value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} placeholder="27ABCDE1234F1Z5" /></Field>
          <Field label="State"><Input list="in-states" maxLength={60} value={form.state} onChange={set('state')} /></Field>
        </div>
        <datalist id="in-states">{STATES.map((s) => <option key={s} value={s} />)}</datalist>
        <Field label="Address"><Textarea rows={3} maxLength={300} value={form.address} onChange={set('address')} /></Field>
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <Button type="submit" variant="secondary" disabled={busy}>{busy ? 'Saving...' : 'Save details'}</Button>
      </form>
    </Card>
  );
}

export default function Billing() {
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [interval, setInterval_] = useState('month');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);
  const wanted = params.get('plan');

  const load = useCallback(async () => {
    try {
      const [d, inv] = await Promise.all([api('/api/billing'), api('/api/billing/invoices').catch(() => ({ invoices: [] }))]);
      setData(d);
      setInvoices(inv.invoices);
    } catch (e) {
      setNote({ kind: 'error', text: e.message });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const subscribe = async (plan) => {
    setBusy(plan.key);
    setNote(null);
    try {
      const [s] = await Promise.all([api('/api/billing/subscribe', { method: 'POST', body: { planKey: plan.key, interval } }), loadCheckout()]);
      await new Promise((resolve) => {
        const rz = new window.Razorpay({
          key: s.keyId,
          subscription_id: s.subscriptionId,
          name: s.name,
          description: s.description,
          prefill: { email: s.email },
          theme: { color: '#059669' },
          handler: async (resp) => {
            try {
              setData(await api('/api/billing/verify', { method: 'POST', body: resp }));
              api('/api/billing/invoices').then((r) => setInvoices(r.invoices)).catch(() => {});
              setNote({ kind: 'success', text: `You are now on the ${plan.name} plan.` });
            } catch (e) {
              setNote({ kind: 'error', text: e.message });
            }
            resolve();
          },
          modal: { ondismiss: resolve },
        });
        rz.on('payment.failed', (r) => setNote({ kind: 'error', text: r?.error?.description || 'The payment failed. You have not been charged for the plan.' }));
        rz.open();
      });
    } catch (e) {
      setNote({ kind: 'error', text: e.message });
    } finally {
      setBusy('');
    }
  };

  const cancel = async () => {
    if (!await askConfirm('You keep your plan until the end of the period you paid for, and it will not renew after that.', { title: 'Cancel your subscription?', confirmLabel: 'Cancel subscription', cancelLabel: 'Keep my plan', danger: true })) return;
    setBusy('cancel');
    setNote(null);
    try {
      setData(await api('/api/billing/cancel', { method: 'POST' }));
      setNote({ kind: 'success', text: 'Cancelled. Your plan stays until the end of the period you paid for.' });
    } catch (e) {
      setNote({ kind: 'error', text: e.message });
    } finally {
      setBusy('');
    }
  };

  if (!data) return <>{note ? <Alert>{note.text}</Alert> : <p className="text-sm text-stone-500">Loading...</p>}</>;
  const { subscription: sub, usage } = data;
  const paid = data.plans.filter((p) => p.priceMonthly > 0 || p.priceYearly > 0);
  const free = data.plans.filter((p) => !(p.priceMonthly > 0 || p.priceYearly > 0));
  const hasYearly = paid.some((p) => p.priceYearly > 0);
  const waLife = usage.lifetime.whatsapp;
  const mailLife = usage.lifetime.email;

  return (
    <>
      <PageHeader title="Plan and billing" subtitle={`You are on the ${data.current.name} plan.`} />
      <div className="space-y-5">
        {note && <Alert kind={note.kind}>{note.text}</Alert>}
        {!data.enabled && <Alert kind="info">Online payments are not switched on yet. <Link to="/contact?topic=plans" className="font-semibold underline">Write to us</Link> to get a paid plan.</Alert>}

        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">What you have used</h2>
          {waLife.cap > 0 && <Meter label="WhatsApp messages (total, not refilled)" used={waLife.used} cap={waLife.cap} />}
          {mailLife.cap > 0 && <Meter label="Emails (total, not refilled)" used={mailLife.used} cap={mailLife.cap} />}
          {usage.month.cap > 0 && <Meter label="Messages in the last 30 days (WhatsApp and email together)" used={usage.month.used} cap={usage.month.cap} />}
          {!waLife.cap && !mailLife.cap && !usage.month.cap && <p className="text-sm text-stone-600">Your plan has no total limit, only the daily and hourly ones listed below.</p>}
          {(waLife.cap > 0 && waLife.left === 0) || (mailLife.cap > 0 && mailLife.left === 0) ? <Alert kind="info">Your free allowance is used up. Choose a plan below to keep sending.</Alert> : null}
        </Card>

        {sub && (
          <Card className="space-y-3">
            <h2 className="text-lg font-semibold">Your subscription</h2>
            <p className="text-sm text-stone-700">
              {data.plans.find((p) => p.key === sub.planKey)?.name || sub.planKey}, {rupees(sub.amount)} {sub.interval === 'year' ? 'a year' : 'a month'}.{' '}
              {sub.status === 'halted' || sub.status === 'pending'
                ? 'The last payment did not go through. Check your card or UPI, or subscribe again below.'
                : sub.cancelAtCycleEnd
                  ? `Cancelled. You keep the plan until ${date(sub.currentEnd)}.`
                  : sub.currentEnd
                    ? `Renews on ${date(sub.currentEnd)}.`
                    : ''}
            </p>
            {!sub.cancelAtCycleEnd && (
              <Button variant="danger" onClick={cancel} disabled={busy === 'cancel'}>
                {busy === 'cancel' ? 'Cancelling...' : 'Cancel subscription'}
              </Button>
            )}
          </Card>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Plans</h2>
          {hasYearly && (
            <div className="inline-flex rounded-xl border border-stone-300 bg-white p-1 text-sm font-semibold" role="group" aria-label="Billing period">
              {[['month', 'Monthly'], ['year', 'Yearly']].map(([v, label]) => (
                <button key={v} type="button" aria-pressed={interval === v} onClick={() => setInterval_(v)} className={`rounded-lg px-3.5 py-1.5 transition ${interval === v ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {[...free, ...paid].map((p) => {
            const price = interval === 'year' ? p.priceYearly : p.priceMonthly;
            const isFree = !(p.priceMonthly > 0 || p.priceYearly > 0);
            const current = data.current.key === p.key;
            const same = sub && sub.planKey === p.key && sub.interval === interval && !sub.cancelAtCycleEnd;
            return (
              <Card key={p.key} className={`flex flex-col ${wanted === p.key ? 'ring-4 ring-emerald-600/20' : ''} ${current ? 'border-emerald-600' : ''}`}>
                <h3 className="text-lg font-semibold">{p.name}{current && <span className="ml-2 text-xs font-medium text-emerald-700">your plan</span>}</h3>
                <p className="mt-2 text-3xl font-semibold tracking-tight">
                  {isFree ? '₹0' : price > 0 ? rupees(price) : '-'}
                  {!isFree && price > 0 && <span className="ml-1.5 text-sm font-normal text-stone-500">{interval === 'year' ? 'a year' : 'a month'}</span>}
                </p>
                {!isFree && interval === 'year' && p.priceMonthly > 0 && p.priceYearly > 0 && p.priceMonthly * 12 > p.priceYearly && (
                  <p className="text-sm font-medium text-emerald-700">You save {rupees(p.priceMonthly * 12 - p.priceYearly)} a year</p>
                )}
                {p.tagline && <p className="mt-2 text-sm text-stone-600">{p.tagline}</p>}
                <ul className="mb-5 mt-3 space-y-1.5 text-sm text-stone-800">
                  {facts(p.limits).map((f) => <li key={f}>{f}</li>)}
                </ul>
                <div className="mt-auto">
                  {isFree ? (
                    <p className="text-sm text-stone-500">Every new account starts here.</p>
                  ) : (
                    <Button variant={wanted === p.key ? 'accent' : 'secondary'} className="w-full" disabled={!data.enabled || busy === p.key || same || price <= 0} onClick={() => subscribe(p)}>
                      {busy === p.key ? 'Opening payment...' : same ? 'Current plan' : `Choose ${p.name}`}
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
        <Compare plans={[...free, ...paid]} current={data.current.key} interval={interval} />

        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">Invoices</h2>
          {invoices.length === 0 ? (
            <p className="text-sm text-stone-600">Your invoices appear here after your first payment.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <tbody className="divide-y divide-stone-100">
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="py-2 pr-3 font-medium">{i.number}</td>
                    <td className="py-2 pr-3 text-stone-600">{date(i.issuedAt)}</td>
                    <td className="py-2 pr-3 text-stone-600">{i.planName}, {i.interval === 'year' ? 'yearly' : 'monthly'}</td>
                    <td className="py-2 pr-3 tabular-nums">{rupees(i.total)}{i.refunded > 0 && <span className="ml-2 text-xs font-medium text-amber-700">{rupees(i.refunded)} refunded</span>}</td>
                    <td className="py-2 text-right"><Link to={`/invoice/${i.id}`} className="font-semibold text-emerald-700 underline">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <BillingDetails initial={data.profile} />

        <p className="text-sm text-stone-500">
          Payments go through Razorpay (UPI, cards, net banking) and renew automatically until you cancel. If you move to a different plan, the old subscription stops straight away. Read the <a href={`${API_BASE}/legal/refunds`} target="_blank" rel="noreferrer" className="font-semibold text-emerald-700 underline">refund and cancellation policy</a>. Need more than Premium? <Link to="/contact?topic=plans&plan=business" className="font-semibold text-emerald-700 underline">Ask about Business</Link>.
        </p>
      </div>
    </>
  );
}
