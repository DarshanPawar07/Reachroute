import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import LimitsEditor from '../../components/LimitsEditor.jsx';
import { Alert, Button, Card, Field, Input } from '../../components/ui.jsx';
import { cleanLimits, useLimitDefs } from '../../lib/limits.js';
import AdminTabs from './AdminTabs.jsx';
import { askConfirm } from '../../components/ConfirmDialog.jsx';

const blank = { key: '', name: '', limits: {}, priceMonthly: 0, priceYearly: 0, tagline: '', listed: true, sortOrder: 100 };

/** The form for a new plan or the changes to an existing one. */
function PlanForm({ defs, base, initial, isNew, onSaved, onCancel }) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const limits = cleanLimits(form.limits);
      const body = { name: form.name, limits, priceMonthly: Number(form.priceMonthly || 0), priceYearly: Number(form.priceYearly || 0), tagline: form.tagline, listed: form.listed, sortOrder: Number(form.sortOrder || 0) };
      if (isNew) await api('/api/admin/plans', { method: 'POST', body: { key: form.key, ...body } });
      else await api(`/api/admin/plans/${initial.key}`, { method: 'PUT', body });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={save} className="space-y-4">
        <h2 className="text-lg font-semibold">{isNew ? 'New plan' : `Edit ${initial.name}`}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="What you see in lists.">
            <Input required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          {isNew && (
            <Field label="Key" hint="Lowercase letters, numbers and hyphens, e.g. pro. It cannot be changed later.">
              <Input required pattern="[a-z0-9][a-z0-9-]{1,29}" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase() })} />
            </Field>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Price per month (₹)" hint="0 = not sold online. Changing it affects new subscriptions; people already paying keep their old price until they resubscribe.">
            <Input type="number" min={0} step={1} value={form.priceMonthly} onChange={(e) => setForm({ ...form, priceMonthly: e.target.value })} />
          </Field>
          <Field label="Price per year (₹)" hint="For example 10 times the monthly price for 2 months free.">
            <Input type="number" min={0} step={1} value={form.priceYearly} onChange={(e) => setForm({ ...form, priceYearly: e.target.value })} />
          </Field>
          <Field label="One-line description" hint="Shown on the Billing page.">
            <Input maxLength={140} value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} />
          </Field>
          <Field label="Order" hint="Lower numbers come first.">
            <Input type="number" min={0} max={10000} step={1} value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-stone-800">
          <input type="checkbox" checked={form.listed} onChange={(e) => setForm({ ...form, listed: e.target.checked })} />
          Show on the Billing page (hidden plans can still be given to accounts by hand)
        </label>
        <p className="text-sm text-stone-600">Leave a box empty to use the standard value (shown in grey). For the “in total” and monthly limits, empty means no limit.</p>
        <LimitsEditor defs={defs} value={form.limits} placeholders={base} onChange={(limits) => setForm({ ...form, limits })} />
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving...' : 'Save plan'}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function AdminPlans() {
  const defs = useLimitDefs();
  const [plans, setPlans] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | plan key
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      setPlans((await api('/api/admin/plans')).plans);
    } catch (e) {
      setNote({ kind: 'error', text: e.message });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const remove = async (p) => {
    if (!await askConfirm(`Delete the plan "${p.name}"?`)) return;
    setNote(null);
    try {
      await api(`/api/admin/plans/${p.key}`, { method: 'DELETE' });
      setNote({ kind: 'success', text: `Plan "${p.name}" deleted.` });
      load();
    } catch (e) {
      setNote({ kind: 'error', text: e.message });
    }
  };

  const standard = plans?.find((p) => p.builtIn)?.effective || {};
  const current = typeof editing === 'string' && editing !== 'new' ? plans?.find((p) => p.key === editing) : null;

  return (
    <>
      <AdminTabs
        title="Plans"
        subtitle="Change prices and limits here and they apply to everyone on the plan within seconds. Put accounts on a plan from their account page."
        actions={
          !editing && (
            <Button variant="accent" onClick={() => { setEditing('new'); setNote(null); }}>
              New plan
            </Button>
          )
        }
      />
      <div className="space-y-4">
        {note && <Alert kind={note.kind}>{note.text}</Alert>}

        {editing && (
          <PlanForm
            key={editing}
            defs={defs}
            base={standard}
            isNew={editing === 'new'}
            initial={current ? { key: current.key, name: current.name, limits: current.limits, priceMonthly: current.priceMonthly, priceYearly: current.priceYearly, tagline: current.tagline, listed: current.listed, sortOrder: current.sortOrder } : blank}
            onSaved={() => {
              setEditing(null);
              setNote({ kind: 'success', text: 'Plan saved. Everyone on it gets the change within a few seconds.' });
              load();
            }}
            onCancel={() => setEditing(null)}
          />
        )}

        {plans?.map((p) => (
          <Card key={p.key} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">
                  {p.name} <span className="text-sm font-normal text-stone-500">({p.key})</span>
                </h2>
                <p className="text-sm text-stone-600">
                  {!p.builtIn && (p.priceMonthly > 0 || p.priceYearly > 0 ? `₹${p.priceMonthly}/month, ₹${p.priceYearly}/year · ` : 'Not sold online · ')}
                  {!p.builtIn && !p.listed ? 'hidden · ' : ''}
                  {p.users} account{p.users === 1 ? '' : 's'}
                  {p.builtIn ? ' · the standard values from the server settings' : ''}
                </p>
              </div>
              {!p.builtIn && (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => { setEditing(p.key); setNote(null); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                    Edit
                  </Button>
                  <Button variant="danger" onClick={() => remove(p)}>
                    Delete
                  </Button>
                </div>
              )}
            </div>
            <table className="w-full text-left text-sm">
              <tbody className="divide-y divide-stone-100">
                {defs.map((d) => (
                  <tr key={d.key}>
                    <td className="py-1 pr-3 text-stone-600">{d.label}</td>
                    <td className="py-1 text-right font-medium tabular-nums">
                      {p.effective[d.key] === 0 ? 'no limit' : p.effective[d.key]}
                      {!p.builtIn && p.limits[d.key] === undefined && <span className="ml-1 text-xs font-normal text-stone-400">standard</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}
      </div>
    </>
  );
}
