import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import CampaignTable from '../components/CampaignTable.jsx';
import RestrictionPanel from '../components/RestrictionPanel.jsx';
import RepliesLink from '../components/RepliesLink.jsx';
import AllowanceBanner from '../components/AllowanceBanner.jsx';
import { Alert, Badge, Button, Card, LinkButton, PageHeader } from '../components/ui.jsx';
import { askConfirm } from '../components/ConfirmDialog.jsx';

export default function WhatsAppHome() {
  const [conn, setConn] = useState({ status: 'disconnected', qr: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const poll = useCallback(async () => {
    try {
      setConn(await api('/api/whatsapp/status'));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    poll();
  }, [poll]);

  // While waiting for a scan, check every 2s so the QR refreshes and we notice when it connects.
  useEffect(() => {
    if (conn.status !== 'connecting' && conn.status !== 'qr') return undefined;
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [conn.status, poll]);

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      setConn(await api('/api/whatsapp/connect', { method: 'POST' }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!await askConfirm('Disconnect this WhatsApp account? Running campaigns will pause.')) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/whatsapp/disconnect', { method: 'POST' });
      setConn({ status: 'disconnected', qr: null });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const connected = conn.status === 'connected';
  const canConnect = ['disconnected', 'closed', 'logged_out'].includes(conn.status);

  return (
    <>
      <PageHeader
        title="WhatsApp"
        subtitle="Link your WhatsApp account, then send a message to a list of contacts."
        actions={
          <>
            <RepliesLink base="/whatsapp" />
          <LinkButton to="/whatsapp/new" variant="accent" disabled={!connected}>
            New campaign
          </LinkButton>
          </>
        }
      />

      <div className="mb-4"><AllowanceBanner channel="whatsapp" /></div>

      <div className="space-y-4">
        <RestrictionPanel connStatus={conn.status} onConnection={setConn} />

        <Card>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Connection</h2>
            <Badge status={conn.status} />
          </div>

          {error && (
            <div className="mt-3">
              <Alert>{error}</Alert>
            </div>
          )}

          {conn.status === 'qr' && conn.qr && (
            <div className="mt-4 flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <img src={conn.qr} alt="WhatsApp link QR code" className="h-56 w-56 rounded-lg border border-stone-200" />
              <ol className="list-decimal space-y-1 pl-5 text-sm text-stone-700">
                <li>Open WhatsApp on your phone</li>
                <li>Go to Settings, then Linked devices</li>
                <li>Tap Link a device and scan this code</li>
              </ol>
            </div>
          )}

          {conn.status === 'connecting' && <p className="mt-3 text-sm text-stone-600">Connecting...</p>}
          {connected && <p className="mt-3 text-sm text-stone-600">Your account is linked and ready to send.</p>}
          {conn.status === 'closed' && (
            <p className="mt-3 text-sm text-stone-600">The connection was lost. Reconnect to continue.</p>
          )}
          {conn.status === 'logged_out' && (
            <p className="mt-3 text-sm text-stone-600">This device was removed from your phone. Link it again to continue.</p>
          )}

          <div className="mt-4 flex gap-2">
            {canConnect && (
              <Button variant="accent" onClick={connect} disabled={busy}>
                {conn.status === 'disconnected' ? 'Connect WhatsApp' : 'Reconnect'}
              </Button>
            )}
            {(connected || conn.status === 'qr' || conn.status === 'connecting') && (
              <Button variant="danger" onClick={disconnect} disabled={busy}>
                Disconnect
              </Button>
            )}
          </div>
        </Card>

        <Alert kind="warn">
          This links your account the same way WhatsApp Web does. It is not an official WhatsApp integration, and
          WhatsApp can ban numbers that message people who didn't ask to hear from them. Only message contacts who
          have agreed to it, and keep volumes small.
        </Alert>

        <CampaignTable kind="whatsapp" />
      </div>
    </>
  );
}
