import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { KINDS, fmtDate } from '../lib/kinds.js';
import { Alert, Badge, Button, Card, ProgressBar } from './ui.jsx';

export default function CampaignTable({ kind }) {
  const k = KINDS[kind];
  const [campaigns, setCampaigns] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const data = await api(k.api);
      setCampaigns(data.campaigns);
    } catch (e) {
      setError(e.message);
    }
  }, [k.api]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Campaigns</h2>
        <Button variant="secondary" onClick={load}>
          Refresh
        </Button>
      </div>

      {error && <Alert>{error}</Alert>}
      {!campaigns && !error && <p className="text-sm text-stone-500">Loading...</p>}
      {campaigns && campaigns.length === 0 && (
        <p className="text-sm text-stone-500">No {k.label.toLowerCase()} campaigns yet. Create your first one.</p>
      )}

      {campaigns && campaigns.length > 0 && (
        <div className="divide-y divide-stone-100">
          {campaigns.map((c) => (
            <Link
              key={c._id}
              to={`${k.base}/campaigns/${c._id}`}
              className="block py-3 hover:bg-stone-50 sm:-mx-2 sm:rounded-lg sm:px-2"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-medium">{c.name}</span>
                <Badge status={c.status} />
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className="flex-1">
                  <ProgressBar sent={c.sentCount} failed={c.failedCount} skipped={c.skippedCount} total={c.total} />
                </div>
                <span className="text-xs tabular-nums text-stone-500">
                  {c.sentCount}/{c.total} sent
                </span>
              </div>
              <div className="mt-1 text-xs text-stone-500">{fmtDate(c.createdAt)}</div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
