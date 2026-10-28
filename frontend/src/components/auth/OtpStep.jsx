import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Alert } from '../ui.jsx';
import { AuthField, SubmitButton } from './fields.jsx';

const RESEND_SECONDS = 60;

/**
 * "Check your email": the 6-digit code from the sign-up email. The person is not signed in to the app yet,
 * so the requests carry the token explicitly. `onVerified` runs when the code is right.
 * `sendNow` asks for a fresh code on arrival (when someone logs in to an account that never confirmed its email).
 */
export default function OtpStep({ email, token, sendNow = false, onVerified, onBack }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState(sendNow ? '' : `We sent a 6-digit code to ${email}.`);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(sendNow ? 0 : RESEND_SECONDS);
  const started = useRef(false);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const send = async () => {
    setError('');
    try {
      const res = await api('/api/auth/resend-verification', { method: 'POST', token });
      if (res.alreadyVerified) return onVerified();
      setNote(res.emailSent === false ? 'Email sending is not set up on this server yet, so no code could be sent. Please contact support.' : `We sent a new 6-digit code to ${email}. The old one no longer works.`);
      setWait(RESEND_SECONDS);
    } catch (err) {
      if (err.code === 'cooldown') {
        setNote(`A code was sent to ${email} a moment ago. Check your inbox and spam folder.`);
        setWait(RESEND_SECONDS);
      } else setError(err.message);
    }
  };

  useEffect(() => {
    if (sendNow && !started.current) {
      started.current = true;
      send();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (value = code) => {
    if (!/^\d{6}$/.test(value)) return setError('Enter the 6 digits from the email.');
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/verify-otp', { method: 'POST', token, body: { code: value } });
      onVerified();
    } catch (err) {
      setError(err.message);
      if (err.code === 'code_wrong' || err.code === 'code_format') setCode('');
    } finally {
      setBusy(false);
    }
  };

  const onChange = (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    setError('');
    if (digits.length === 6) submit(digits); // no button press needed once the last digit is in
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-4" noValidate>
      {note && <Alert kind="info">{note}</Alert>}
      <AuthField id="otp" label="Verification code" error={error} hint="It works for 10 minutes. Look in your spam folder if it is not in your inbox.">
        <input
          id="otp"
          value={code}
          onChange={onChange}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          placeholder="123456"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? 'otp-error' : undefined}
          className={`w-full rounded-xl border bg-white px-3.5 py-3.5 text-center font-display text-3xl font-semibold tracking-[0.5em] text-stone-900 outline-none transition placeholder:text-stone-300 focus:ring-4 ${error ? 'border-red-400 focus:border-red-500 focus:ring-red-100' : 'border-stone-300 focus:border-emerald-500 focus:ring-emerald-100'}`}
        />
      </AuthField>
      <SubmitButton busy={busy} busyText="Checking..." disabled={code.length !== 6}>Verify and continue</SubmitButton>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <button type="button" onClick={send} disabled={wait > 0} className="font-semibold text-emerald-700 hover:underline disabled:cursor-not-allowed disabled:text-stone-400 disabled:no-underline">
          {wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code'}
        </button>
        {onBack && (
          <button type="button" onClick={onBack} className="text-stone-600 hover:text-stone-900 hover:underline">
            Use a different email
          </button>
        )}
      </div>
    </form>
  );
}
