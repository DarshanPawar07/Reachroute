import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Alert, Card, Stat } from '../../components/ui.jsx';
import AdminTabs from './AdminTabs.jsx';

export default function AdminOverview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/api/admin/overview')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <>
      <AdminTabs title="Admin" subtitle="How the whole service is doing." />
      {error && <Alert>{error}</Alert>}
      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Accounts" value={data.users.total} sub={`${data.users.newLast24h} new today`} />
            <Stat label="Active, 7 days" value={data.users.activeLast7d} sub={`${data.users.newLast7d} new this week`} />
            <Stat label="Not verified" value={data.users.unverified} />
            <Stat label="Suspended" value={data.users.suspended} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="WhatsApp sent, 24 h" value={data.sentLast24h.whatsapp} />
            <Stat label="Email sent, 24 h" value={data.sentLast24h.email} />
            <Stat label="WhatsApp linked now" value={data.whatsappLinked} />
            <Stat label="Admins" value={data.users.admins} />
          </div>
          {data.queue && (
            <Card>
              <h2 className="mb-2 text-lg font-semibold">Sending queue</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {Object.entries(data.queue).map(([channel, q]) =>
                  q && typeof q === 'object' ? (
                    <div key={channel} className="rounded-lg border border-stone-200 p-3 text-sm">
                      <div className="mb-1 font-medium capitalize">{channel}</div>
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-stone-600">
                        {Object.entries(q)
                          .filter(([, v]) => typeof v === 'number')
                          .map(([k, v]) => (
                            <div key={k} className="contents">
                              <dt>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt>
                              <dd className="text-right tabular-nums text-stone-900">{v}</dd>
                            </div>
                          ))}
                      </dl>
                    </div>
                  ) : null
                )}
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
