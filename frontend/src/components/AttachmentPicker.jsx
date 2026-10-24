import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtSize } from '../lib/kinds.js';
import { Alert, Button } from './ui.jsx';

const ICON = { image: 'Picture', video: 'Video', audio: 'Sound', document: 'Document' };

/**
 * Choose the files to send with a campaign, and upload new ones.
 *   kind      'whatsapp' (one file) or 'email' (up to 5 files)
 *   value     list of chosen attachment ids
 *   onChange  called with the new list of ids
 */
export default function AttachmentPicker({ kind, value, onChange }) {
  const maxFiles = kind === 'whatsapp' ? 1 : 5;
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);

  const load = useCallback(async () => {
    try {
      setData(await api('/api/attachments'));
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const items = data?.items || [];
  const limitMb = data ? (kind === 'whatsapp' ? data.limits.whatsappFileMb : data.limits.emailFileMb) : null;

  const toggle = (id) => {
    if (value.includes(id)) return onChange(value.filter((v) => v !== id));
    if (value.length >= maxFiles) {
      // WhatsApp takes one file: choosing another replaces it
      return maxFiles === 1 ? onChange([id]) : setError(`You can attach up to ${maxFiles} files to one email.`);
    }
    setError('');
    onChange([...value, id]);
  };

  const upload = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api('/api/attachments', { method: 'POST', form: fd });
      await load();
      if (!value.includes(res.attachment.id)) toggle(res.attachment.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a) => {
    if (!window.confirm(`Delete "${a.name}" from your files?`)) return;
    setError('');
    try {
      await api(`/api/attachments/${a.id}`, { method: 'DELETE' });
      onChange(value.filter((v) => v !== a.id));
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const used = data?.usage;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-stone-800">
          Attachments <span className="font-normal text-stone-500">(optional)</span>
        </span>
        <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Uploading...' : 'Upload a file'}
        </Button>
        <input ref={input} type="file" className="hidden" onChange={upload} accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.rtf,.txt,.csv,.jpg,.jpeg,.png,.gif,.webp,.mp4,.mov,.3gp,.mp3,.m4a,.aac,.ogg,.opus,.wav,.amr" />
      </div>
      <p className="text-xs text-stone-500">
        {kind === 'whatsapp' ? 'One file goes with each message (sound is sent first, then your text).' : `Up to ${maxFiles} files, 15 MB in total.`}
        {limitMb ? ` Largest file: ${limitMb} MB.` : ''}
        {used ? ` Storage used: ${fmtSize(used.bytes)} of ${fmtSize(used.limitBytes)}.` : ''}
      </p>
      {error && <Alert>{error}</Alert>}
      {items.length > 0 && (
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <input type={maxFiles === 1 ? 'radio' : 'checkbox'} name="attachment" checked={value.includes(a.id)} onChange={() => toggle(a.id)} aria-label={`Attach ${a.name}`} />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <span className="shrink-0 text-xs text-stone-500">
                {ICON[a.kind]} · {fmtSize(a.size)}
              </span>
              <button type="button" onClick={() => remove(a)} className="shrink-0 text-xs text-red-700 underline">
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {maxFiles === 1 && value.length > 0 && (
        <button type="button" onClick={() => onChange([])} className="text-xs underline">
          Send without a file
        </button>
      )}
    </div>
  );
}
