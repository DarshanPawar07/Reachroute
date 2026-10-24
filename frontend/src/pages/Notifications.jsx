import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { fmtDate } from '../lib/kinds.js';
import { Alert, Button, Card, PageHeader } from '../components/ui.jsx';

// Text label as well as colour, so the level never depends on colour alone.
const LEVELS = {
  error: { label: 'Problem', className: 'bg-red-100 text-red-800' },
  warning: { label: 'Needs a look', className: 'bg-amber-100 text-amber-800' },
  success: { label: 'Done', className: 'bg-emerald-100 text-emerald-800' },
  info: { label: 'Info', className: 'bg-stone-200 text-stone-700' },
};

const tellLayout = () => window.dispatchEvent(new Event('alerts-changed'));

export default function Notifications() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api('/api/notifications?limit=50'));
      tellLayout();
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const open = async (n) => {
    if (!n.read) await api('/api/notifications/read', { method: 'POST', body: { id: n._id } }).catch(() => {});
    tellLayout();
    if (n.link) navigate(n.link);
    else load();
  };

  const markAll = async () => {
    try {
      await api('/api/notifications/read', { method: 'POST', body: { all: true } });
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const clear = async () => {
    if (!window.confirm('Delete all alerts?')) return;
    try {
      await api('/api/notifications', { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const items = data?.notifications || [];

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Disconnected WhatsApp, paused campaigns and finished campaigns show up here."
        actions={
          <>
            <Button variant="secondary" disabled={!data?.unread} onClick={markAll}>
              Mark all read
            </Button>
            <Button variant="secondary" disabled={items.length === 0} onClick={clear}>
              Clear all
            </Button>
          </>
        }
      />
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Card>
          {data && items.length === 0 && <p className="text-sm text-stone-500">No alerts. You are all caught up.</p>}
          <ul className="divide-y divide-stone-100">
            {items.map((n) => {
              const level = LEVELS[n.level] || LEVELS.info;
              return (
                <li key={n._id}>
                  <button onClick={() => open(n)} className="flex w-full items-start gap-3 py-3 text-left hover:bg-stone-50">
                    <span className={`mt-0.5 shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${level.className}`}>{level.label}</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block ${n.read ? 'text-stone-700' : 'font-semibold text-stone-900'}`}>{n.title}</span>
                      {n.message && <span className="mt-0.5 block text-sm text-stone-600">{n.message}</span>}
                      <span className="mt-0.5 block text-xs text-stone-500">{fmtDate(n.createdAt)}</span>
                    </span>
                    {!n.read && <span className="mt-1 shrink-0 text-xs font-medium text-stone-900">New</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
