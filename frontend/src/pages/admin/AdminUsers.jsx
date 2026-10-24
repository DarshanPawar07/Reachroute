import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { fmtDate } from '../../lib/kinds.js';
import { Alert, Button, Card, Input, Select } from '../../components/ui.jsx';
import AdminTabs from './AdminTabs.jsx';

export default function AdminUsers() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    const qs = new URLSearchParams({ page: String(page), sort });
    if (search.trim()) qs.set('search', search.trim());
    if (status) qs.set('status', status);
    try {
      setData(await api(`/api/admin/users?${qs}`));
    } catch (e) {
      setError(e.message);
    }
  }, [page, sort, status, search]);

  useEffect(() => {
    const timer = setTimeout(load, 250); // wait while typing
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <>
      <AdminTabs title="Accounts" subtitle="Find an account to see its use, change its plan or limits, or suspend it." />
      <Card className="mb-4 grid gap-3 sm:grid-cols-3">
        <Input placeholder="Search by email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All accounts</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="admin">Admins</option>
          <option value="unverified">Email not verified</option>
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </Select>
      </Card>
      {error && <Alert>{error}</Alert>}
      {data && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[0.8rem] font-semibold text-stone-500">
                <tr>
                  <th className="py-2 pr-3">Email</th>
                  <th className="py-2 pr-3">Plan</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Joined</th>
                  <th className="py-2">Last login</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {data.users.map((u) => (
                  <tr key={u.id}>
                    <td className="py-2 pr-3">
                      <Link to={`/admin/users/${u.id}`} className="underline">
                        {u.email}
                      </Link>
                      {u.role === 'admin' && <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-xs">admin</span>}
                    </td>
                    <td className="py-2 pr-3">{u.plan}</td>
                    <td className="py-2 pr-3 text-xs">{u.suspendedAt ? <span className="text-red-700">suspended</span> : u.emailVerified ? 'active' : 'not verified'}</td>
                    <td className="py-2 pr-3 text-xs text-stone-500">{fmtDate(u.createdAt)}</td>
                    <td className="py-2 text-xs text-stone-500">{fmtDate(u.lastLoginAt) || 'never'}</td>
                  </tr>
                ))}
                {data.users.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-stone-500">
                      No accounts match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-stone-600">
            <span>
              {data.total} account{data.total === 1 ? '' : 's'} · page {data.page} of {data.pages}
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
