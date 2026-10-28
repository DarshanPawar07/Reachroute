import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { KINDS, fmtDate } from '../lib/kinds.js';
import { Alert, Button, Card, Input, LinkButton, PageHeader, Stat } from '../components/ui.jsx';
import { askConfirm } from '../components/ConfirmDialog.jsx';

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
  const [typed, setTyped] = useState(''); // what is in the search box
  const [q, setQ] = useState(''); // the search that is applied (after a short pause in typing)
  const [group, setGroup] = useState('');
  const [fileGroup, setFileGroup] = useState(''); // group label for the next uploaded file
  const [adding, setAdding] = useState(null); // { name, value, groups } while the "add a contact" form is open
  const [editId, setEditId] = useState(null);
  const [draft, setDraft] = useState({ name: '', value: '', groups: '' });

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (q) params.set('q', q);
      if (group) params.set('group', group);
      setData(await api(`/api/lists/${id}?${params}`));
    } catch (e) {
      setError(e.message);
    }
  }, [id, page, q, group]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(typed.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [typed]);

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
      if (fileGroup.trim()) fd.append('group', fileGroup);
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

  const addOne = (e) => {
    e.preventDefault();
    run(async () => {
      await api(`/api/lists/${id}/contacts/one`, { method: 'POST', body: adding });
      setNotice('Contact added.');
      setAdding(null);
      await load();
    });
  };

  const startEdit = (c) => {
    setEditId(c._id);
    setDraft({ name: c.name || '', value: c.value, groups: (c.groups || []).join(', ') });
  };

  const saveEdit = () =>
    run(async () => {
      await api(`/api/lists/${id}/contacts/${editId}`, { method: 'PATCH', body: draft });
      setEditId(null);
      await load();
    });

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

  const reset = async () => {
    if (!await askConfirm('Forget who was messaged? Everyone in this list will count as "not messaged yet" again.')) return;
    run(async () => {
      await api(`/api/lists/${id}/reset`, { method: 'POST' });
      await load();
    });
  };

  const remove = async () => {
    if (!await askConfirm('Delete this list and all its contacts? Campaigns you already ran are not affected.')) return;
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

  const { list, contacts, limit, groups = [], matching = list.total } = data;
  const k = KINDS[list.kind];
  const pages = Math.max(1, Math.ceil(matching / limit));
  const filtered = Boolean(q || group);
  const valueHint = list.kind === 'whatsapp' ? '+91 98765 43210' : 'name@example.com';

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
            <Button variant="secondary" disabled={busy} onClick={() => setAdding(adding ? null : { name: '', value: '', groups: '' })}>
              Add one contact
            </Button>
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
          <label className="block text-sm">
            <span className="font-medium">Label the people in the next file (optional)</span>
            <div className="mt-1">
              <Input maxLength={60} placeholder="e.g. pune, customers" value={fileGroup} onChange={(e) => setFileGroup(e.target.value)} />
            </div>
            <span className="mt-1 block text-xs text-stone-500">Groups let you send a campaign to just part of a list. People already in the list also get the label. Separate several with commas.</span>
          </label>
        </Card>

        {adding && (
          <Card>
            <form onSubmit={addOne} className="space-y-3">
              <h2 className="text-lg font-semibold">Add one contact</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input placeholder="Name (optional)" maxLength={100} value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
                <Input required placeholder={`${k.contactLabel}, like ${valueHint}`} value={adding.value} onChange={(e) => setAdding({ ...adding, value: e.target.value })} />
                <Input placeholder="Groups, comma separated" value={adding.groups} onChange={(e) => setAdding({ ...adding, groups: e.target.value })} />
              </div>
              <div className="flex gap-2">
                <Button type="submit" variant="accent" disabled={busy || !adding.value.trim()}>
                  Add contact
                </Button>
                <Button variant="secondary" onClick={() => setAdding(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        )}

        <Card>
          <h2 className="mb-3 text-lg font-semibold">Contacts</h2>
          <Input type="search" placeholder={`Search by name or ${k.contactLabel.toLowerCase()}...`} value={typed} onChange={(e) => setTyped(e.target.value)} />
          {(groups.length > 0 || group) && (
            <div className="mt-3 flex flex-wrap gap-2 text-sm">
              {[{ name: '', count: null }, ...groups].map((g) => (
                <button
                  key={g.name || 'all'}
                  type="button"
                  onClick={() => {
                    setGroup(g.name);
                    setPage(1);
                  }}
                  className={`rounded-full border px-3 py-1 ${group === g.name ? 'border-emerald-700 bg-emerald-50 font-medium text-emerald-900' : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-100'}`}
                >
                  {g.name || 'All'}
                  {g.count !== null && <span className="ml-1 text-xs text-stone-500">{g.count}</span>}
                </button>
              ))}
            </div>
          )}
          {filtered && (
            <p className="mt-3 text-sm text-stone-600">
              {matching} of {list.total} {matching === 1 ? 'contact matches' : 'contacts match'}.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setTyped('');
                  setQ('');
                  setGroup('');
                  setPage(1);
                }}
              >
                Clear
              </button>
            </p>
          )}
          {contacts.length === 0 && <p className="mt-3 text-sm text-stone-500">{filtered ? 'Nobody matches.' : 'This list is empty. Add contacts from a file.'}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[0.8rem] font-semibold text-stone-500">
                <tr>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">{k.contactLabel}</th>
                  <th className="py-2 pr-3">Groups</th>
                  <th className="py-2 pr-3">Last campaign</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {contacts.map((c) =>
                  editId === c._id ? (
                    <tr key={c._id} className="bg-stone-50">
                      <td className="py-2 pr-2">
                        <Input maxLength={100} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                      </td>
                      <td className="py-2 pr-2">
                        <Input value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
                      </td>
                      <td className="py-2 pr-2">
                        <Input placeholder="comma separated" value={draft.groups} onChange={(e) => setDraft({ ...draft, groups: e.target.value })} />
                      </td>
                      <td className="py-2 pr-3 text-xs text-stone-500">{draft.value.trim() && draft.value.trim() !== c.value ? 'Counts as a new person' : ''}</td>
                      <td className="whitespace-nowrap py-2 text-right text-xs">
                        <button disabled={busy} onClick={saveEdit} className="mr-3 font-medium text-emerald-800 underline disabled:opacity-50">
                          Save
                        </button>
                        <button disabled={busy} onClick={() => setEditId(null)} className="underline">
                          Cancel
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={c._id}>
                      <td className="py-2 pr-3">{c.name || '-'}</td>
                      <td className="py-2 pr-3">{c.value}</td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap gap-1">
                          {(c.groups || []).map((g) => (
                            <span key={g} className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
                              {g}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-xs text-stone-500">{c.lastCampaignAt ? fmtDate(c.lastCampaignAt) : 'Not yet'}</td>
                      <td className="whitespace-nowrap py-2 text-right text-xs">
                        <button disabled={busy} onClick={() => startEdit(c)} className="mr-3 underline disabled:opacity-50">
                          Edit
                        </button>
                        <button disabled={busy} onClick={() => removeContact(c._id)} className="text-red-700 underline disabled:opacity-50">
                          Remove
                        </button>
                      </td>
                    </tr>
                  )
                )}
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
