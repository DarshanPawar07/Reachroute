import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Alert, Button, Card, Field, Input } from './ui.jsx';

/**
 * Proves the "from" address belongs to this person: a 6 digit code is emailed to it, and typing it in unlocks sending.
 *   sender     the status from the server (mode, email, verified, code)
 *   onChange   called with the newer status after each step
 */
export default function SenderVerify({ sender, onChange }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [wait, setWait] = useState(0);

  const serverWait = sender?.code?.resendAfterSeconds ?? 0;
  useEffect(() => setWait(serverWait), [serverWait, sender?.code?.sentTo]);
  useEffect(() => {
    if (wait <= 0) return undefined;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  if (!sender || sender.mode !== 'own') return null;

  if (sender.verified) {
    return (
      <Alert kind="success">
        <strong>{sender.email}</strong> is verified. You can send campaigns from it.
      </Alert>
    );
  }

  const ask = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api('/api/email/sender/code', { method: 'POST' });
      onChange(res.sender);
      setMessage(
        res.emailSent === false
          ? { kind: 'warn', text: 'This server has no mail service set up (SMTP_HOST), so no email was sent. If you run the server yourself, the code is printed in the backend terminal.' }
          : { kind: 'success', text: `We sent a 6 digit code to ${res.email}. It expires in a few minutes. Check the spam folder too.` }
      );
    } catch (e) {
      setMessage({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await api('/api/email/sender/verify', { method: 'POST', body: { code: code.replace(/\s/g, '') } });
      setCode('');
      onChange(res.sender);
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const waiting = Boolean(sender.code);
  return (
    <Card className="space-y-3 border-amber-300 bg-amber-50">
      <h2 className="text-lg font-semibold text-amber-900">Verify your sending address</h2>
      <p className="text-sm text-amber-900">
        Before you can send campaigns from <strong>{sender.email}</strong>, we need to check that the address is yours. We email a code to it, and you type the code here.
      </p>
      {waiting && (
        <form onSubmit={verify} className="space-y-3">
          <Field label={`Code sent to ${sender.code.sentTo}`} hint={`${sender.code.triesLeft} tr${sender.code.triesLeft === 1 ? 'y' : 'ies'} left`}>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Button type="submit" variant="accent" disabled={busy || code.replace(/\s/g, '').length !== 6}>
            {busy ? 'Checking...' : 'Verify'}
          </Button>
        </form>
      )}
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      <Button variant={waiting ? 'secondary' : 'accent'} disabled={busy || wait > 0} onClick={ask}>
        {wait > 0 ? `Send a new code in ${wait}s` : waiting ? 'Send a new code' : 'Send me a code'}
      </Button>
    </Card>
  );
}
