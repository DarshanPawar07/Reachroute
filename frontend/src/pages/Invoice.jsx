import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Alert, Button } from '../components/ui.jsx';

const money = (v) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

function Party({ title, p }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{title}</p>
      <p className="mt-1 font-semibold">{p?.name || p?.email || '-'}</p>
      {p?.address && <p className="whitespace-pre-line text-sm text-stone-700">{p.address}</p>}
      {p?.state && <p className="text-sm text-stone-700">State: {p.state}</p>}
      {p?.gstin && <p className="text-sm text-stone-700">GSTIN: {p.gstin}</p>}
      {p?.email && p?.name && <p className="text-sm text-stone-700">{p.email}</p>}
    </div>
  );
}

/** One invoice, laid out to print or save as a PDF from the browser's print window. */
export default function Invoice() {
  const { id } = useParams();
  const [inv, setInv] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/api/billing/invoices/${id}`)
      .then((r) => setInv(r.invoice))
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <div className="mx-auto max-w-2xl p-6"><Alert>{error}</Alert></div>;
  if (!inv) return <p className="p-6 text-sm text-stone-500">Loading...</p>;
  const tax = inv.cgst + inv.sgst + inv.igst > 0;

  return (
    <div className="min-h-screen bg-stone-100 p-4 print:bg-white print:p-0">
      <div className="mx-auto mb-4 flex max-w-3xl items-center justify-between gap-3 print:hidden">
        <Link to="/billing" className="text-sm underline">Back to billing</Link>
        <Button variant="accent" onClick={() => window.print()}>Print or save as PDF</Button>
      </div>
      <article className="mx-auto max-w-3xl rounded-2xl border border-stone-200 bg-white p-8 text-stone-900 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-stone-200 pb-5">
          <div>
            <h1 className="text-2xl font-semibold">{inv.title}</h1>
            <p className="mt-1 text-sm text-stone-600">No. {inv.number}</p>
            <p className="text-sm text-stone-600">Date: {date(inv.issuedAt)}</p>
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">{inv.seller?.name}</p>
            {inv.seller?.address && <p className="whitespace-pre-line text-stone-700">{inv.seller.address}</p>}
            {inv.seller?.state && <p className="text-stone-700">{inv.seller.state}</p>}
            {inv.seller?.gstin && <p className="text-stone-700">GSTIN: {inv.seller.gstin}</p>}
          </div>
        </header>

        <section className="grid gap-6 py-5 sm:grid-cols-2">
          <Party title="Billed to" p={inv.buyer} />
          <div className="text-sm text-stone-700 sm:text-right">
            {inv.paymentId && <p>Payment reference: {inv.paymentId}</p>}
            <p>Paid through Razorpay</p>
          </div>
        </section>

        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-y border-stone-200 bg-stone-50">
              <th className="px-3 py-2 font-semibold">Description</th>
              {inv.seller?.sac && <th className="px-3 py-2 font-semibold">SAC</th>}
              <th className="px-3 py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-stone-100">
              <td className="px-3 py-3">
                Reachroute {inv.planName} plan, {inv.interval === 'year' ? 'yearly' : 'monthly'}
                {inv.periodEnd && <span className="block text-stone-600">{inv.periodStart ? `${date(inv.periodStart)} to ` : 'Until '}{date(inv.periodEnd)}</span>}
              </td>
              {inv.seller?.sac && <td className="px-3 py-3">{inv.seller.sac}</td>}
              <td className="px-3 py-3 text-right tabular-nums">{money(inv.taxable)}</td>
            </tr>
          </tbody>
          <tfoot className="tabular-nums">
            {tax && inv.cgst > 0 && (
              <>
                <tr><td className="px-3 pt-3 text-right" colSpan={inv.seller?.sac ? 2 : 1}>CGST ({inv.gstRate / 2}%)</td><td className="px-3 pt-3 text-right">{money(inv.cgst)}</td></tr>
                <tr><td className="px-3 text-right" colSpan={inv.seller?.sac ? 2 : 1}>SGST ({inv.gstRate / 2}%)</td><td className="px-3 text-right">{money(inv.sgst)}</td></tr>
              </>
            )}
            {tax && inv.igst > 0 && <tr><td className="px-3 pt-3 text-right" colSpan={inv.seller?.sac ? 2 : 1}>IGST ({inv.gstRate}%)</td><td className="px-3 pt-3 text-right">{money(inv.igst)}</td></tr>}
            <tr className="font-semibold"><td className="px-3 pb-3 pt-3 text-right" colSpan={inv.seller?.sac ? 2 : 1}>Total paid (INR)</td><td className="px-3 pb-3 pt-3 text-right">{money(inv.total)}</td></tr>
          </tfoot>
        </table>

        {inv.creditNotes?.length > 0 && (
          <section className="mt-6">
            <h2 className="text-sm font-semibold">Refund notes</h2>
            <table className="mt-2 w-full text-left text-sm">
              <tbody className="divide-y divide-stone-100">
                {inv.creditNotes.map((c) => (
                  <tr key={c.number}>
                    <td className="py-2 pr-3 font-medium">{c.number}</td>
                    <td className="py-2 pr-3 text-stone-600">{date(c.issuedAt)}</td>
                    <td className="py-2 pr-3 text-stone-600">{c.reason}</td>
                    <td className="py-2 text-right tabular-nums">-{money(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-stone-500">Refunds go back to the original payment method. Your bank can take a few working days to show it.</p>
          </section>
        )}

        {!inv.seller?.gstin && <p className="mt-4 text-xs text-stone-500">The seller is not registered for GST, so no tax is charged.</p>}
        <p className="mt-6 text-xs text-stone-500">This invoice was made by computer and needs no signature.</p>
      </article>
    </div>
  );
}
