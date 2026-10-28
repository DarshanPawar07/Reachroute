import { useEffect, useState } from 'react';
import { api } from '../api.js';
import CampaignTable from '../components/CampaignTable.jsx';
import AllowanceBanner from '../components/AllowanceBanner.jsx';
import { Alert, Badge, Card, LinkButton, PageHeader } from '../components/ui.jsx';

export default function EmailHome() {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/email/settings')
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, []);

  const configured = Boolean(info?.settings) || Boolean(info?.platformFallback);
  const needsVerify = Boolean(info?.sender?.needsVerification);

  return (
    <>
      <PageHeader
        title="Email"
        subtitle="Send one email to a list of contacts, each with an unsubscribe link."
        actions={
          <>
          <LinkButton to="/email/new" variant="accent" disabled={!configured || needsVerify}>
            New campaign
          </LinkButton>
          </>
        }
      />

      <div className="space-y-4">
        <AllowanceBanner channel="email" />
        {error && <Alert>{error}</Alert>}

        <Card>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Sender</h2>
            {info && <Badge status={configured && !needsVerify ? 'connected' : needsVerify ? 'needs_verify' : 'disconnected'} />}
          </div>
          {info?.settings ? (
            <p className="mt-3 text-sm text-stone-700">
              Sending as <strong>{info.settings.fromName ? `${info.settings.fromName} <${info.settings.fromEmail}>` : info.settings.fromEmail}</strong>{' '}
              via {info.settings.host}.
            </p>
          ) : info?.platformFallback ? (
            <p className="mt-3 text-sm text-stone-700">Using the platform's default sender. You can add your own SMTP details instead.</p>
          ) : (
            info && <p className="mt-3 text-sm text-stone-700">Add your SMTP details so emails are sent from your own address.</p>
          )}
          {needsVerify && (
            <div className="mt-3">
              <Alert kind="warn">Verify {info.sender.email} before you send. We email you a code to prove the address is yours.</Alert>
            </div>
          )}
          <div className="mt-4">
            <LinkButton to="/email/settings" variant="secondary">
              {info?.settings ? 'Edit email settings' : 'Set up email'}
            </LinkButton>
          </div>
        </Card>

        <CampaignTable kind="email" />
      </div>
    </>
  );
}
