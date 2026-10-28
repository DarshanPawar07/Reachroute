import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { fmtDate } from '../lib/kinds.js';
import { Alert, Button, Card } from './ui.jsx';
import { askConfirm } from './ConfirmDialog.jsx';

const hoursLeft = (ms) => {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${Math.max(1, minutes)} min`;
};

/**
 * Shown on the WhatsApp page when WhatsApp refused the linked number (usually a 24 hour block after too many messages).
 * The person can link a different number and carry on where the campaign stopped.
 *   connStatus   the connection status of the page (so this panel refreshes when a number gets linked)
 *   onConnection called with the new connection (after "link another number" returns a QR code)
 */
export default function RestrictionPanel({ connStatus, onConnection }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      setInfo(await api('/api/whatsapp/restriction'));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, connStatus]);
  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!info || (!info.restricted && !info.campaigns.length)) return null;

  const run = async (path, done) => {
    setBusy(true);
    setError('');
    setNote(null);
    try {
      done(await api(path, { method: 'POST' }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      load();
    }
  };

  const switchNumber = async () => {
    if (!await askConfirm('Log out the current WhatsApp number and link a different one? Your campaigns stay saved and can carry on from where they stopped.')) return;
    run('/api/whatsapp/switch-number', onConnection);
  };
  const resume = () =>
    run('/api/whatsapp/restriction/resume', (r) => {
      const text = r.resumed.length ? `Resumed ${r.resumed.length} campaign${r.resumed.length === 1 ? '' : 's'}. They carry on from the first contact not messaged yet.` : 'There was nothing to resume.';
      setNote({ kind: r.failed.length ? 'warn' : 'success', text: r.failed.length ? `${text} ${r.failed.length} could not be resumed: ${r.failed.map((f) => `${f.name} (${f.error})`).join('; ')}` : text });
    });

  const waiting = info.campaigns;
  return (
    <Card className="space-y-3 border-amber-300 bg-amber-50">
      {info.restricted ? (
        <>
          <h2 className="text-lg font-semibold text-amber-900">WhatsApp stopped this number</h2>
          <p className="text-sm text-amber-900">
            WhatsApp refused to send from {info.phone ? `+${info.phone}` : 'your number'} (found {fmtDate(info.since)}). This usually means a block of about 24 hours after too many messages.
            {info.state === 'active' ? ` It should be usable again in about ${hoursLeft(info.msLeft)}.` : ' The waiting time is over, so you can try the same number again.'}
          </p>
        </>
      ) : (
        <h2 className="text-lg font-semibold text-amber-900">Campaigns are waiting to carry on</h2>
      )}
      {waiting.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-amber-900">
          {waiting.map((c) => (
            <li key={c.id}>
              <Link to={`/whatsapp/campaigns/${c.id}`} className="underline">
                {c.name}
              </Link>{' '}
              ({c.remaining} contact{c.remaining === 1 ? '' : 's'} still to message)
            </li>
          ))}
        </ul>
      )}
      {info.next === 'link_number' && <p className="text-sm text-amber-900">Link a different WhatsApp number to carry on now, or come back when the waiting time is over.</p>}
      {info.next === 'wait' && <p className="text-sm text-amber-900">The same number is linked, and its waiting time is not over yet. Link a different number to carry on now.</p>}
      {info.next === 'resume' && <p className="text-sm text-amber-900">A number that can send is linked. Resume to carry on where the campaigns stopped.</p>}
      {error && <Alert>{error}</Alert>}
      {note && <Alert kind={note.kind}>{note.text}</Alert>}
      <div className="flex flex-wrap gap-2">
        {info.next === 'resume' && (
          <Button variant="accent" disabled={busy} onClick={resume}>
            Resume campaigns
          </Button>
        )}
        {info.restricted && (
          <Button variant="secondary" disabled={busy || connStatus === 'qr' || connStatus === 'connecting'} onClick={switchNumber}>
            Link another number
          </Button>
        )}
      </div>
    </Card>
  );
}
