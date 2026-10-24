import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import LimitsEditor from '../../components/LimitsEditor.jsx';
import { Alert, Button, Card, Field, Input } from '../../components/ui.jsx';
import { cleanLimits, useLimitDefs } from '../../lib/limits.js';
import AdminTabs from './AdminTabs.jsx';

const blank = { key: '', name: '', limits: {} };

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
      if (isNew) await api('/api/admin/plans', { method: 'POST', body: { key: form.key, name: form.name, limits } });
      else await api(`/api/admin/plans/${initial.key}`, { method: 'PUT', body: { name: form.name, limits } });
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
        <p className="text-sm text-stone-600">Leave a box empty to use the standard value (shown in grey).</p>
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
    if (!window.confirm(`Delete the plan "${p.name}"?`)) return;
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
        subtitle="A plan is a named set of limits. Put accounts on a plan from their account page."
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
            initial={current ? { key: current.key, name: current.name, limits: current.limits } : blank}
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
                      {p.effective[d.key]}
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
