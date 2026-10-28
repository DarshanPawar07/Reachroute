import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import LimitsEditor from '../../components/LimitsEditor.jsx';
import { Alert, Badge, Button, Card, Field, Input, Select, Stat } from '../../components/ui.jsx';
import { fmtDate } from '../../lib/kinds.js';
import { cleanLimits, useLimitDefs } from '../../lib/limits.js';
import AdminTabs from './AdminTabs.jsx';
import { askConfirm } from '../../components/ConfirmDialog.jsx';

function ChannelUsage({ title, u }) {
  return (
    <Card className="space-y-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-stone-600">
        {u.campaigns.total} campaigns ({u.campaigns.running} running, {u.campaigns.paused} paused) · sent {u.sentLast24h} in 24 h, {u.sentLast7d} in 7 days · {u.stopped} opted out
      </p>
      {u.recentCampaigns.length > 0 && (
        <ul className="divide-y divide-stone-100 text-sm">
          {u.recentCampaigns.map((c) => (
            <li key={c._id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="truncate">{c.name}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-stone-500">
                {c.sentCount}/{c.total} <Badge status={c.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function AdminUserDetail() {
  const { id } = useParams();
  const defs = useLimitDefs();
  const [data, setData] = useState(null);
  const [plans, setPlans] = useState([]);
  const [planKey, setPlanKey] = useState('default');
  const [overrides, setOverrides] = useState({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([api(`/api/admin/users/${id}`), api('/api/admin/plans')]);
      setData(d);
      setPlans(p.plans);
      setPlanKey(d.user.plan);
      setOverrides(d.overrides || {});
    } catch (e) {
      setNote({ kind: 'error', text: e.message });
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (path, { method = 'POST', body, ok, confirm } = {}) => {
    if (confirm && !await askConfirm(confirm)) return;
    setBusy(true);
    setNote(null);
    try {
      await api(`/api/admin/users/${id}${path}`, { method, body });
      setNote({ kind: 'success', text: ok });
      await load();
    } catch (e) {
      setNote({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <>{note ? <Alert>{note.text}</Alert> : <p className="text-sm text-stone-500">Loading...</p>}</>;
  const { user, usage } = data;
  const planInfo = plans.find((p) => p.key === user.plan);

  return (
    <>
      <AdminTabs
        title={user.email}
        subtitle={`${user.role === 'admin' ? 'Admin · ' : ''}joined ${fmtDate(user.createdAt)} · last login ${fmtDate(user.lastLoginAt) || 'never'}`}
        actions={
          <Link to="/admin/users" className="text-sm underline">
            All accounts
          </Link>
        }
      />
      <div className="space-y-4">
        {note && <Alert kind={note.kind}>{note.text}</Alert>}
        {user.suspendedAt && (
          <Alert kind="error">
            Suspended {fmtDate(user.suspendedAt)}
            {user.suspendedReason ? `: ${user.suspendedReason}` : ''}
          </Alert>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Plan" value={data.plan.name} />
          <Stat label="Email verified" value={user.emailVerified ? 'Yes' : 'No'} />
          <Stat label="Contact lists" value={usage.lists} />
          <Stat label="Templates" value={usage.templates} />
        </div>

        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">Actions</h2>
          <div className="flex flex-wrap gap-2">
            {!user.emailVerified && (
              <Button variant="secondary" disabled={busy} onClick={() => run('/verify-email', { ok: 'Email marked as verified.' })}>
                Mark email verified
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => run('/force-logout', { ok: 'Signed out everywhere.', confirm: 'Sign this account out of every device?' })}
            >
              Sign out everywhere
            </Button>
            {user.suspendedAt && (
              <Button variant="accent" disabled={busy} onClick={() => run('/unsuspend', { ok: 'Account restored. Paused campaigns stay paused until the owner resumes them.' })}>
                Unsuspend
              </Button>
            )}
          </div>
          {!user.suspendedAt && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[14rem] flex-1">
                <Field label="Suspend this account" hint="It is signed out, cannot log in, and its running campaigns are paused. Nothing is deleted.">
                  <Input placeholder="Reason (optional)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              </div>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => run('/suspend', { body: { reason }, ok: 'Account suspended.', confirm: `Suspend ${user.email}?` })}
              >
                Suspend
              </Button>
            </div>
          )}
        </Card>

        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">Plan</h2>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <Select value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
                {plans.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name} ({p.key})
                  </option>
                ))}
              </Select>
            </div>
            <Button disabled={busy || planKey === user.plan} onClick={() => run('/plan', { method: 'PUT', body: { plan: planKey }, ok: 'Plan changed.' })}>
              Change plan
            </Button>
          </div>
        </Card>

        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">Limits for this account only</h2>
          <p className="text-sm text-stone-600">A number here beats the plan. Leave a box empty to use the plan's value (shown in grey).</p>
          <LimitsEditor defs={defs} value={overrides} placeholders={planInfo?.effective || {}} onChange={setOverrides} />
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={() => run('/limits', { method: 'PUT', body: { limits: cleanLimits(overrides) }, ok: 'Limits saved.' })}
            >
              Save limits
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => run('/limits', { method: 'PUT', body: { limits: {} }, ok: 'Account limits cleared.' })}>
              Clear all
            </Button>
          </div>
        </Card>

        <ChannelUsage title={`WhatsApp (${usage.whatsapp.session})`} u={usage.whatsapp} />
        <ChannelUsage title={usage.email.ownSmtp ? `Email (own SMTP: ${usage.email.ownSmtp.fromEmail})` : 'Email'} u={usage.email} />

        {data.consents.length > 0 && (
          <Card>
            <h2 className="mb-2 text-lg font-semibold">Accepted terms</h2>
            <ul className="text-sm text-stone-600">
              {data.consents.map((c, i) => (
                <li key={i}>
                  {c.doc} {c.version} · {fmtDate(c.acceptedAt)} ({c.via})
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
