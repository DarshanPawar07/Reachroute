import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Alert, Button, Card, Input } from '../../components/ui.jsx';
import { fmtDate } from '../../lib/kinds.js';
import AdminTabs from './AdminTabs.jsx';

export default function AdminAudit() {
  const [email, setEmail] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    const qs = new URLSearchParams({ page: String(page) });
    if (email.trim()) qs.set('email', email.trim());
    if (action.trim()) qs.set('action', action.trim());
    try {
      setData(await api(`/api/admin/audit?${qs}`));
    } catch (e) {
      setError(e.message);
    }
  }, [page, email, action]);
  useEffect(() => {
    const timer = setTimeout(load, 300);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <>
      <AdminTabs title="Activity log" subtitle="Who did what: sign-ups, plan changes, suspensions, restrictions, uploads and more." />
      <Card className="mb-4 grid gap-3 sm:grid-cols-2">
        <Input placeholder="Email of the person (actor or target)" value={email} onChange={(e) => { setEmail(e.target.value); setPage(1); }} />
        <Input placeholder="Action, e.g. user.suspended" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} />
      </Card>
      {error && <Alert>{error}</Alert>}
      {data && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[0.8rem] font-semibold text-stone-500">
                <tr>
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Action</th>
                  <th className="py-2 pr-3">By</th>
                  <th className="py-2 pr-3">On</th>
                  <th className="py-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 align-top">
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap py-2 pr-3 text-xs text-stone-500">{fmtDate(e.at)}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{e.action}</td>
                    <td className="py-2 pr-3 text-xs">{e.actor?.email || (e.actor ? 'account' : 'command line')}</td>
                    <td className="py-2 pr-3 text-xs">{e.target?.email || ''}</td>
                    <td className="py-2 text-xs text-stone-600">{e.detail}</td>
                  </tr>
                ))}
                {data.entries.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-stone-500">
                      Nothing matches.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-stone-600">
            <span>
              {data.total} entr{data.total === 1 ? 'y' : 'ies'} · page {data.page} of {data.pages}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button variant="secondary" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
