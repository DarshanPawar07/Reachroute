import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Alert, Button, Card } from '../../components/ui.jsx';
import { fmtDate } from '../../lib/kinds.js';
import AdminTabs from './AdminTabs.jsx';

const TOPIC = { plans: 'Plans', support: 'Help', instagram: 'Instagram', facebook: 'Facebook', other: 'Other' };

/** Messages people sent from the public Contact page. */
export default function AdminMessages() {
  const [show, setShow] = useState('open');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await api(`/api/admin/messages${show === 'open' ? '?handled=false' : show === 'done' ? '?handled=true' : ''}`));
    } catch (e) {
      setError(e.message);
    }
  }, [show]);
  useEffect(() => {
    load();
  }, [load]);

  const mark = async (id, handled) => {
    try {
      await api(`/api/admin/messages/${id}/handled`, { method: 'POST', body: { handled } });
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <>
      <AdminTabs title="Messages" subtitle="Sent from the Contact page. Reply by email, then mark the message as done." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {[['open', 'Waiting for a reply'], ['done', 'Done'], ['all', 'All']].map(([k, label]) => (
          <Button key={k} variant={show === k ? 'primary' : 'secondary'} onClick={() => setShow(k)}>{label}</Button>
        ))}
        {data && <span className="text-sm text-stone-500">{data.open} waiting</span>}
      </div>
      {error && <Alert>{error}</Alert>}
      {data && data.messages.length === 0 && <Card><p className="text-sm text-stone-600">No messages here.</p></Card>}
      <div className="space-y-3">
        {data?.messages.map((m) => (
          <Card key={m._id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-stone-900">{m.name}</p>
                <a href={`mailto:${m.email}?subject=${encodeURIComponent('Re: your message to Reachroute')}`} className="text-sm text-emerald-700 underline">{m.email}</a>
                <p className="mt-1 text-xs text-stone-500">
                  {fmtDate(m.createdAt)} · {TOPIC[m.topic] || m.topic}{m.plan ? `, ${m.plan} plan` : ''}
                </p>
              </div>
              <Button variant="secondary" onClick={() => mark(m._id, !m.handled)}>{m.handled ? 'Mark as waiting' : 'Mark as done'}</Button>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-[0.95rem] leading-relaxed text-stone-800">{m.message}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
