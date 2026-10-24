import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { KINDS, fmtDate } from '../lib/kinds.js';
import { Alert, Button, Card, Field, Input, PageHeader, Select } from '../components/ui.jsx';

export default function Lists() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [kind, setKind] = useState('whatsapp');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    api('/api/lists')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const fd = new FormData();
      fd.append('name', name);
      fd.append('kind', kind);
      fd.append('file', file);
      const res = await api('/api/lists', { method: 'POST', form: fd });
      const { summary } = res;
      if (summary.invalidCount > 0) {
        // Let the person see the skipped-rows note on the list page, but go there straight away.
        sessionStorage.setItem('listNotice', `${summary.added} contacts added. ${summary.invalidCount} row(s) skipped because the ${KINDS[kind].contactLabel.toLowerCase()} looked invalid.`);
      }
      navigate(`/lists/${res.list.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const lists = data?.lists || [];

  return (
    <>
      <PageHeader title="Contact lists" subtitle="Save your contacts once and use them in as many campaigns as you like." />
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}

        <Card>
          <h2 className="mb-3 text-lg font-semibold">Your lists</h2>
          {data && lists.length === 0 && <p className="text-sm text-stone-500">No lists yet. Create your first one below.</p>}
          <div className="divide-y divide-stone-100">
            {lists.map((l) => (
              <Link key={l.id} to={`/lists/${l.id}`} className="flex items-center justify-between gap-3 py-3 hover:bg-stone-50">
                <div className="min-w-0">
                  <div className="truncate font-medium">{l.name}</div>
                  <div className="text-xs text-stone-500">
                    {KINDS[l.kind].label} · created {fmtDate(l.createdAt)}
                  </div>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <div className="font-medium tabular-nums">{l.total} contacts</div>
                  <div className="text-xs text-stone-500 tabular-nums">{l.fresh} not messaged yet</div>
                </div>
              </Link>
            ))}
          </div>
        </Card>

        <form onSubmit={create}>
          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Create a list</h2>
            <Field label="List name" hint="Only you see this, for example “Diwali customers”.">
              <Input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Type">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="whatsapp">WhatsApp (phone numbers)</option>
                <option value="email">Email (email addresses)</option>
              </Select>
            </Field>
            <Field
              label="Contacts file"
              hint={`.csv, .xlsx or .json with columns: ${KINDS[kind].columnsHint}. Up to ${data?.limits?.maxContacts ?? 5000} contacts per list.`}
            >
              <input
                required
                type="file"
                accept=".csv,.xlsx,.json"
                onChange={(e) => setFile(e.target.files[0] || null)}
                className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-stone-200 file:px-3 file:py-2 file:text-sm file:font-medium"
              />
            </Field>
            <Button type="submit" variant="accent" disabled={busy || !file || !name.trim()}>
              {busy ? 'Saving...' : 'Create list'}
            </Button>
          </Card>
        </form>
      </div>
    </>
  );
}
