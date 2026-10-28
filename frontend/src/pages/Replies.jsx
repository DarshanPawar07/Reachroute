import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { KINDS, fmtDate } from '../lib/kinds.js';
import { Alert, Button, Card, Field, PageHeader, Select } from '../components/ui.jsx';
import { askConfirm } from '../components/ConfirmDialog.jsx';

/** Replies to campaigns. The same page serves WhatsApp and email; only the address field and the A/B tag differ. */
export default function Replies({ kind }) {
  const k = KINDS[kind];
  const apiBase = `/api${k.base}/replies`;
  const [params, setParams] = useSearchParams();
  const campaignId = params.get('campaignId') || '';
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [replies, setReplies] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [unread, setUnread] = useState(0);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const query = useCallback(
    (before) => {
      const q = new URLSearchParams({ limit: '30' });
      if (campaignId) q.set('campaignId', campaignId);
      if (onlyUnread) q.set('unread', 'true');
      if (before) q.set('before', before);
      return `${apiBase}?${q}`;
    },
    [apiBase, campaignId, onlyUnread]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api(query());
      setReplies(res.replies);
      setNextBefore(res.nextBefore);
      setUnread(res.unread);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api(`${apiBase}/campaigns`)
      .then((r) => setCampaigns(r.campaigns))
      .catch(() => {});
  }, [apiBase]);

  const more = async () => {
    try {
      const res = await api(query(nextBefore));
      setReplies((prev) => [...prev, ...res.replies]);
      setNextBefore(res.nextBefore);
      setUnread(res.unread);
    } catch (e) {
      setError(e.message);
    }
  };

  const markRead = async (body) => {
    try {
      const res = await api(`${apiBase}/read`, { method: 'POST', body });
      setUnread(res.unread);
      const now = new Date().toISOString();
      setReplies((prev) => prev.map((r) => (body.all || body.campaignId || body.id === r._id ? { ...r, readAt: r.readAt || now } : r)));
    } catch (e) {
      setError(e.message);
    }
  };

  const remove = async (id) => {
    if (!await askConfirm('Delete this reply? It cannot be brought back.')) return;
    try {
      const res = await api(`${apiBase}/${id}`, { method: 'DELETE' });
      setUnread(res.unread);
      setReplies((prev) => prev.filter((r) => r._id !== id));
    } catch (e) {
      setError(e.message);
    }
  };

  const pick = (e) => {
    const next = new URLSearchParams(params);
    if (e.target.value) next.set('campaignId', e.target.value);
    else next.delete('campaignId');
    setParams(next);
  };

  return (
    <>
      <PageHeader
        title={`${k.label} replies`}
        subtitle={unread ? `${unread} not read yet.` : 'Everything is read.'}
        actions={
          <Link to={k.base} className="text-sm underline">
            Back to {k.label.toLowerCase()}
          </Link>
        }
      />

      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        <Card className="flex flex-wrap items-end gap-4">
          <div className="min-w-48 flex-1">
            <Field label="Campaign">
              <Select value={campaignId} onChange={pick}>
                <option value="">All campaigns</option>
                {campaigns.map((c) => (
                  <option key={c.campaignId} value={c.campaignId}>
                    {(c.campaignName || 'Removed campaign') + ` (${c.replies})`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
            Only not read
          </label>
          <Button variant="secondary" disabled={!unread} onClick={() => markRead(campaignId ? { campaignId } : { all: true })}>
            Mark {campaignId ? 'this campaign' : 'all'} as read
          </Button>
        </Card>

        {loading ? (
          <p className="text-sm text-stone-500">Loading...</p>
        ) : replies.length === 0 ? (
          <Card>
            <p className="text-sm text-stone-600">
              {onlyUnread ? 'No unread replies.' : 'No replies yet.'}
              {kind === 'email' && ' Replies appear here once your mailbox is connected in email settings and someone answers a campaign.'}
            </p>
          </Card>
        ) : (
          <ul className="space-y-3">
            {replies.map((r) => (
              <li key={r._id}>
                <Card className={r.readAt ? '' : 'border-emerald-300'}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">
                        {r.name || r[k.contactKey]}
                        {r.name && <span className="ml-2 text-sm font-normal text-stone-500">{r[k.contactKey]}</span>}
                      </div>
                      <div className="text-xs text-stone-500">
                        {fmtDate(r.receivedAt)}
                        {r.campaignName && (
                          <>
                            {' · '}
                            <Link className="underline" to={`${k.base}/campaigns/${r.campaignId}`}>
                              {r.campaignName}
                            </Link>
                          </>
                        )}
                        {r.variant && ` · subject ${r.variant}`}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {r.optOut && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">Asked to stop, will not be contacted</span>}
                      {!r.readAt && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900">New</span>}
                    </div>
                  </div>
                  {r.subject && <div className="mt-2 text-sm text-stone-600">{r.subject}</div>}
                  <p className="mt-2 whitespace-pre-wrap text-sm">{r.text || <span className="text-stone-400">(no text)</span>}</p>
                  <div className="mt-3 flex gap-2">
                    {!r.readAt && (
                      <Button variant="secondary" onClick={() => markRead({ id: r._id })}>
                        Mark as read
                      </Button>
                    )}
                    <Button variant="danger" onClick={() => remove(r._id)}>
                      Delete
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}

        {nextBefore && (
          <div>
            <Button variant="secondary" onClick={more}>
              Show older replies
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
