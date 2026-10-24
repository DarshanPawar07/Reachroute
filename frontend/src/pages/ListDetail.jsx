import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { KINDS, fmtDate } from '../lib/kinds.js';
import { Alert, Button, Card, LinkButton, PageHeader, Stat } from '../components/ui.jsx';

export default function ListDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(() => {
    try {
      const saved = sessionStorage.getItem('listNotice') || '';
      sessionStorage.removeItem('listNotice');
      return saved;
    } catch {
      return '';
    }
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/lists/${id}?page=${page}&limit=50`));
    } catch (e) {
      setError(e.message);
    }
  }, [id, page]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addContacts = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    run(async () => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api(`/api/lists/${id}/contacts`, { method: 'POST', form: fd });
      setNotice(
        `${res.added} contact(s) added.` +
          (res.alreadyInList ? ` ${res.alreadyInList} were already in the list.` : '') +
          (res.invalidCount ? ` ${res.invalidCount} row(s) skipped because they looked invalid.` : '')
      );
      await load();
    });
  };

  const removeContact = (contactId) =>
    run(async () => {
      await api(`/api/lists/${id}/contacts/${contactId}`, { method: 'DELETE' });
      await load();
    });

  const rename = () => {
    const name = window.prompt('New name for this list', data.list.name);
    if (!name || name.trim() === data.list.name) return;
    run(async () => {
      await api(`/api/lists/${id}`, { method: 'PATCH', body: { name } });
      await load();
    });
  };

  const reset = () => {
    if (!window.confirm('Forget who was messaged? Everyone in this list will count as "not messaged yet" again.')) return;
    run(async () => {
      await api(`/api/lists/${id}/reset`, { method: 'POST' });
      await load();
    });
  };

  const remove = () => {
    if (!window.confirm('Delete this list and all its contacts? Campaigns you already ran are not affected.')) return;
    run(async () => {
      await api(`/api/lists/${id}`, { method: 'DELETE' });
      navigate('/lists');
    });
  };

  if (!data) {
    return error ? (
      <>
        <Alert>{error}</Alert>
        <Link to="/lists" className="mt-4 inline-block text-sm underline">
          Back to lists
        </Link>
      </>
    ) : (
      <p className="text-sm text-stone-500">Loading...</p>
    );
  }

  const { list, contacts, limit } = data;
  const k = KINDS[list.kind];
  const pages = Math.max(1, Math.ceil(list.total / limit));

  return (
    <>
      <PageHeader
        title={list.name}
        subtitle={`${k.label} list`}
        actions={
          <Link to="/lists" className="text-sm underline">
            Back
          </Link>
        }
      />

      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}

        <Card>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Contacts" value={list.total} />
            <Stat label="Not messaged yet" value={list.fresh} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <LinkButton to={`${k.base}/new?list=${list.id}`} variant="accent" disabled={list.total === 0}>
              Start a campaign with this list
            </LinkButton>
            <label className="inline-flex cursor-pointer items-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-800 hover:bg-stone-100">
              Add contacts from a file
              <input type="file" accept=".csv,.xlsx,.json" className="hidden" disabled={busy} onChange={addContacts} />
            </label>
            <Button variant="secondary" disabled={busy} onClick={rename}>
              Rename
            </Button>
            <Button variant="secondary" disabled={busy || list.total === list.fresh} onClick={reset}>
              Reset "messaged" marks
            </Button>
            <Button variant="danger" disabled={busy} onClick={remove}>
              Delete list
            </Button>
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 text-lg font-semibold">Contacts</h2>
          {contacts.length === 0 && <p className="text-sm text-stone-500">This list is empty. Add contacts from a file.</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[0.8rem] font-semibold text-stone-500">
                <tr>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">{k.contactLabel}</th>
                  <th className="py-2 pr-3">Last campaign</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {contacts.map((c) => (
                  <tr key={c._id}>
                    <td className="py-2 pr-3">{c.name || '-'}</td>
                    <td className="py-2 pr-3">{c.value}</td>
                    <td className="py-2 pr-3 text-xs text-stone-500">{c.lastCampaignAt ? fmtDate(c.lastCampaignAt) : 'Not yet'}</td>
                    <td className="py-2 text-right">
                      <button disabled={busy} onClick={() => removeContact(c._id)} className="text-xs text-red-700 underline disabled:opacity-50">
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span className="text-stone-600">
                Page {page} of {pages}
              </span>
              <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
