import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Alert, Button, Card, Input, Select, Stat } from '../../components/ui.jsx';
import { askConfirm } from '../../components/ConfirmDialog.jsx';
import AdminTabs from './AdminTabs.jsx';

const rupees = (v) => `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const PLANS = ['pro', 'premium'];

function Pager({ data, page, setPage }) {
  if (!data || data.pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-stone-600">
      <span>Page {data.page} of {data.pages} ({data.total} in all)</span>
      <span className="flex gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
        <Button variant="secondary" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Next</Button>
      </span>
    </div>
  );
}

/** Fetches a list with filters, waiting a moment while someone types. */
function useList(path, params, page) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const key = JSON.stringify(params);
  const load = useCallback(async () => {
    setError('');
    const qs = new URLSearchParams({ page: String(page) });
    for (const [k, v] of Object.entries(JSON.parse(key))) if (v) qs.set(k, v);
    try {
      setData(await api(`${path}?${qs}`));
    } catch (e) {
      setError(e.message);
    }
  }, [path, key, page]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  return { data, error, reload: load };
}

function Subscriptions() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('live');
  const [plan, setPlan] = useState('');
  const [page, setPage] = useState(1);
  const { data, error } = useList('/api/admin/billing/subscriptions', { search: search.trim(), status, plan }, page);
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Subscriptions</h2>
      <Card className="grid gap-3 sm:grid-cols-3">
        <Input placeholder="Search by email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search subscriptions by email" />
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status">
          <option value="live">Paying or about to pay</option>
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="halted">Payment failed (halted)</option>
          <option value="cancelled">Cancelled</option>
          <option value="completed">Completed</option>
          <option value="created">Not paid yet</option>
        </Select>
        <Select value={plan} onChange={(e) => { setPlan(e.target.value); setPage(1); }} aria-label="Plan">
          <option value="">Every plan</option>
          {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
      </Card>
      {error && <Alert>{error}</Alert>}
      {data && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[0.8rem] font-semibold text-stone-500">
                <tr><th className="py-2 pr-3">Account</th><th className="py-2 pr-3">Plan</th><th className="py-2 pr-3">Amount</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Payments</th><th className="py-2">Paid until</th></tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {data.subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 pr-3"><Link to={`/admin/users/${s.userId}`} className="underline">{s.email}</Link></td>
                    <td className="py-2 pr-3">{s.planKey}, {s.interval === 'year' ? 'yearly' : 'monthly'}</td>
                    <td className="py-2 pr-3 tabular-nums">{rupees(s.amount)}</td>
                    <td className="py-2 pr-3 text-xs">{s.status}{s.cancelAtCycleEnd && s.status === 'active' ? ', ends at period end' : ''}</td>
                    <td className="py-2 pr-3 tabular-nums">{s.paidCount}</td>
                    <td className="py-2 text-xs text-stone-600">{day(s.currentEnd) || '-'}</td>
                  </tr>
                ))}
                {data.subscriptions.length === 0 && <tr><td colSpan={6} className="py-4 text-stone-500">No subscriptions match.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pager data={data} page={page} setPage={setPage} />
        </Card>
      )}
    </section>
  );
}

function RefundForm({ invoice, onDone }) {
  const [amount, setAmount] = useState(String(invoice.refundable));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!await askConfirm(`This records a refund note for ${rupees(amount || 0)} on ${invoice.number}. It cannot be undone. Send the money back from the Razorpay dashboard as well.`, { title: 'Issue refund note?', confirmLabel: 'Issue refund note', cancelLabel: 'Go back' })) return;
    setBusy(true);
    try {
      const r = await api(`/api/admin/billing/invoices/${invoice.id}/refund-note`, { method: 'POST', body: { amount: Number(amount), reason } });
      onDone(`Refund note ${r.note.number} issued.`);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-2 grid gap-2 rounded-xl bg-stone-50 p-3 sm:grid-cols-[8rem_1fr_auto]">
      <Input type="number" min="0.01" step="0.01" max={invoice.refundable} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount to refund in rupees" required />
      <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Reason, for example: asked within 7 days" aria-label="Reason" required />
      <Button type="submit" variant="danger" disabled={busy}>{busy ? 'Saving...' : 'Issue refund note'}</Button>
      {err && <div className="sm:col-span-3"><Alert>{err}</Alert></div>}
      <p className="text-xs text-stone-500 sm:col-span-3">This only writes the note on the invoice and in the activity log. It does not move money: refund the payment {invoice.paymentId ? <span className="font-mono">{invoice.paymentId}</span> : ''} in the Razorpay dashboard.</p>
    </form>
  );
}

function Invoices({ onChanged }) {
  const [search, setSearch] = useState('');
  const [plan, setPlan] = useState('');
  const [refunded, setRefunded] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState('');
  const [note, setNote] = useState('');
  const { data, error, reload } = useList('/api/admin/billing/invoices', { search: search.trim(), plan, refunded }, page);
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Invoices and refund notes</h2>
      <Card className="grid gap-3 sm:grid-cols-3">
        <Input placeholder="Email, invoice number or payment id" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search invoices" />
        <Select value={plan} onChange={(e) => { setPlan(e.target.value); setPage(1); }} aria-label="Plan">
          <option value="">Every plan</option>
          {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select value={refunded} onChange={(e) => { setRefunded(e.target.value); setPage(1); }} aria-label="Refunds">
          <option value="">With or without refunds</option>
          <option value="yes">Has a refund note</option>
          <option value="no">No refund note</option>
        </Select>
      </Card>
      {note && <Alert kind="success">{note}</Alert>}
      {error && <Alert>{error}</Alert>}
      {data && (
        <Card>
          <ul className="divide-y divide-stone-100">
            {data.invoices.map((i) => (
              <li key={i.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <div>
                    <span className="font-medium">{i.number}</span>
                    <span className="ml-2 text-xs text-stone-500">{day(i.issuedAt)}</span>
                    <div className="text-stone-700"><Link to={`/admin/users/${i.userId}`} className="underline">{i.email || 'unknown'}</Link>, {i.planName} {i.interval === 'year' ? 'yearly' : 'monthly'}</div>
                  </div>
                  <div className="text-right">
                    <div className="tabular-nums font-medium">{rupees(i.total)}</div>
                    {i.refunded > 0 && <div className="text-xs text-amber-700">{rupees(i.refunded)} refunded</div>}
                  </div>
                </div>
                {i.creditNotes.map((c) => (
                  <p key={c.id} className="mt-1 text-xs text-stone-600">{c.number}: {rupees(c.amount)} on {day(c.issuedAt)}, {c.reason} ({c.byEmail})</p>
                ))}
                {i.refundable > 0 && (
                  <div className="mt-1">
                    <button type="button" className="text-xs font-semibold text-emerald-700 underline" onClick={() => setOpenId(openId === i.id ? '' : i.id)}>{openId === i.id ? 'Close' : 'Write a refund note'}</button>
                    {openId === i.id && <RefundForm invoice={i} onDone={(m) => { setNote(m); setOpenId(''); reload(); onChanged(); }} />}
                  </div>
                )}
              </li>
            ))}
            {data.invoices.length === 0 && <li className="py-4 text-sm text-stone-500">No invoices match.</li>}
          </ul>
          <Pager data={data} page={page} setPage={setPage} />
        </Card>
      )}
    </section>
  );
}

export default function AdminBilling() {
  const [sum, setSum] = useState(null);
  const loadSummary = useCallback(() => api('/api/admin/billing/summary').then(setSum).catch(() => {}), []);
  useEffect(() => { loadSummary(); }, [loadSummary]);
  return (
    <>
      <AdminTabs title="Billing" subtitle="Who is paying, what was invoiced, and refund notes." />
      <div className="space-y-6">
        {sum && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Paying accounts" value={sum.payingAccounts} sub={`${sum.renewingAccounts} will renew`} />
            <Stat label="Coming in each month" value={rupees(sum.monthlyRecurring)} sub="if nobody cancels" />
            <Stat label="Collected so far" value={rupees(sum.collected)} sub={`${sum.invoices} invoices`} />
            <Stat label="Refund notes" value={rupees(sum.refunded)} sub="recorded here" />
          </div>
        )}
        <Subscriptions />
        <Invoices onChanged={loadSummary} />
      </div>
    </>
  );
}
