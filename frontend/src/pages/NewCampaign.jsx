import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import AttachmentPicker from '../components/AttachmentPicker.jsx';
import SchedulePicker from '../components/SchedulePicker.jsx';
import { emptySchedule, scheduleFields, scheduleProblem } from '../lib/schedule.js';
import { KINDS } from '../lib/kinds.js';
import { Alert, Button, Card, Field, Input, PageHeader, Select, Textarea } from '../components/ui.jsx';

const SAMPLES = {
  whatsapp: 'name,phone\nAsha,+919876543210\nRahul,9123456780\n',
  email: 'name,email\nAsha,asha@example.com\nRahul,rahul@example.com\n',
};

function downloadSample(kind) {
  const url = URL.createObjectURL(new Blob([SAMPLES[kind]], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `sample-${kind}-contacts.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function NewCampaign({ kind }) {
  const k = KINDS[kind];
  const isWhatsApp = kind === 'whatsapp';
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [name, setName] = useState('');
  const [source, setSource] = useState(params.get('list') ? 'list' : 'file'); // 'file' or 'list'
  const [file, setFile] = useState(null);
  const [lists, setLists] = useState([]);
  const [listId, setListId] = useState(params.get('list') || '');
  const [onlyNew, setOnlyNew] = useState(true);
  const [limit, setLimit] = useState('');
  const [message, setMessage] = useState(''); // WhatsApp text
  const [appendOptOut, setAppendOptOut] = useState(true);
  const [subject, setSubject] = useState(''); // Email
  const [body, setBody] = useState('');
  const [bodyFormat, setBodyFormat] = useState('text');
  const [abOn, setAbOn] = useState(false);
  const [subjectB, setSubjectB] = useState('');
  const [splitB, setSplitB] = useState(50);
  const [attachmentIds, setAttachmentIds] = useState([]);
  const [schedule, setSchedule] = useState(emptySchedule);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    api(`/api/lists?kind=${kind}`)
      .then((r) => setLists(r.lists))
      .catch(() => {});
  }, [kind]);

  const chosen = lists.find((l) => l.id === listId);

  const submit = async (e) => {
    e.preventDefault();
    const problem = scheduleProblem(schedule);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError('');
    setErrorCode('');
    try {
      const fd = new FormData();
      if (source === 'list') {
        fd.append('listId', listId);
        fd.append('onlyNew', String(onlyNew));
        if (limit) fd.append('limit', limit);
      } else {
        fd.append('file', file);
      }
      fd.append('name', name);
      fd.append('consentConfirmed', String(consent));
      if (attachmentIds.length) fd.append('attachmentIds', JSON.stringify(attachmentIds));
      for (const [key, value] of Object.entries(scheduleFields(schedule))) if (value !== null) fd.append(key, String(value));
      if (isWhatsApp) {
        fd.append('message', message);
        fd.append('appendOptOut', String(appendOptOut));
      } else {
        fd.append('subject', subject);
        fd.append('body', body);
        fd.append('bodyFormat', bodyFormat);
        if (abOn && subjectB.trim()) {
          fd.append('subjectB', subjectB);
          fd.append('splitB', String(splitB));
        }
      }
      setResult(await api(k.api, { method: 'POST', form: fd }));
    } catch (err) {
      setError(err.message);
      setErrorCode(err.code || '');
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const { summary, campaign } = result;
    return (
      <>
        <PageHeader title={campaign.startAt && new Date(campaign.startAt) > new Date() ? 'Campaign scheduled' : 'Campaign started'} />
        <Card className="space-y-3">
          <p className="text-sm">
            <strong>{summary.queued}</strong> {isWhatsApp ? 'messages' : 'emails'} queued. They go out one at a time with
            short pauses, so a campaign takes a while to finish.
          </p>
          {summary.list && (
            <Alert kind="info">
              Taken from “{summary.list.name}”. {summary.list.notMessagedYet} contact(s) in that list have not been messaged yet.
              {summary.list.cappedToDailyLimit && ' You asked for more than today\'s limit allows, so only the number that fits was queued.'}
            </Alert>
          )}
          {summary.duplicatesRemoved > 0 && <Alert kind="info">{summary.duplicatesRemoved} duplicate contact(s) removed.</Alert>}
          {summary.optedOutSkipped > 0 && (
            <Alert kind="info">
              {summary.optedOutSkipped} contact(s) skipped because they {isWhatsApp ? 'replied STOP' : 'unsubscribed'} before.
            </Alert>
          )}
          {summary.invalid.length > 0 && (
            <Alert kind="warn">
              {summary.invalid.length} row(s) skipped because the {k.contactLabel.toLowerCase()} looked invalid:
              <ul className="mt-1 list-disc pl-5">
                {summary.invalid.slice(0, 10).map((r) => (
                  <li key={r.row}>
                    Row {r.row}: {r.value}
                  </li>
                ))}
                {summary.invalid.length > 10 && <li>...and {summary.invalid.length - 10} more</li>}
              </ul>
            </Alert>
          )}
          <Button variant="accent" onClick={() => navigate(`${k.base}/campaigns/${campaign._id}`)}>
            View campaign
          </Button>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`New ${k.label} campaign`}
        actions={
          <Link to={k.base} className="text-sm underline">
            Cancel
          </Link>
        }
      />

      <form onSubmit={submit} className="space-y-5">
        <Card className="space-y-5">
          <h2 className="text-lg font-semibold">Campaign and contacts</h2>
          <Field label="Campaign name" hint="Only you see this.">
            <Input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="source" checked={source === 'file'} onChange={() => setSource('file')} />
              Upload a file
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="source" checked={source === 'list'} onChange={() => setSource('list')} />
              Use a saved list
            </label>
          </div>

          {source === 'file' ? (
            <Field label="Contacts file" hint={`.csv, .xlsx or .json with columns: ${k.columnsHint}. ${k.maxHint}.`}>
              <input
                required
                type="file"
                accept=".csv,.xlsx,.json"
                onChange={(e) => setFile(e.target.files[0] || null)}
                className="block w-full"
              />
              <button type="button" onClick={() => downloadSample(kind)} className="mt-1 text-xs underline">
                Download a sample file
              </button>
            </Field>
          ) : (
            <div className="space-y-3">
              <Field
                label="Saved list"
                hint={lists.length === 0 ? undefined : chosen ? `${chosen.total} contacts, ${chosen.fresh} not messaged yet.` : undefined}
              >
                <Select required value={listId} onChange={(e) => setListId(e.target.value)}>
                  <option value="">Choose a list...</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.total})
                    </option>
                  ))}
                </Select>
                {lists.length === 0 && (
                  <span className="mt-1 block text-xs text-stone-500">
                    You have no {k.label} lists yet.{' '}
                    <Link to="/lists" className="underline">
                      Create one
                    </Link>
                    .
                  </span>
                )}
              </Field>
              <Field label="How many people?" hint="Leave empty to take as many as today's limit allows.">
                <Input type="number" min={1} step={1} placeholder="All that fit" value={limit} onChange={(e) => setLimit(e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
                Only people who were not messaged yet from this list (recommended)
              </label>
            </div>
          )}

        </Card>

        <Card className="space-y-5">
          <h2 className="text-lg font-semibold">Your message</h2>
          {isWhatsApp ? (
            <>
              <Field label="Message" hint="Use {{name}} for the contact's name, and {Hi|Hello|Hey} to vary the wording.">
                <Textarea required rows={6} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
                <span className="mt-1 block text-right text-xs text-stone-500">{message.length}/1000</span>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={appendOptOut} onChange={(e) => setAppendOptOut(e.target.checked)} />
                Add "Reply STOP to opt out." at the end (recommended)
              </label>
            </>
          ) : (
            <>
              <Field label="Subject" hint="{{name}} works here too.">
                <Input required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
              </Field>

              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={abOn} onChange={(e) => setAbOn(e.target.checked)} />
                  Test a second subject line (A/B test)
                </label>
                {abOn && (
                  <div className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
                    <Field label="Second subject (version B)" hint="Some people get this one instead of the subject above. You can compare the results on the campaign page.">
                      <Input maxLength={200} value={subjectB} onChange={(e) => setSubjectB(e.target.value)} />
                    </Field>
                    <Field label={`Share who get version B: ${splitB}%`} hint={`${100 - splitB}% get the first subject. People are picked at random.`}>
                      <input type="range" min={1} max={99} value={splitB} onChange={(e) => setSplitB(Number(e.target.value))} className="w-full" />
                    </Field>
                  </div>
                )}
              </div>

              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="fmt" checked={bodyFormat === 'text'} onChange={() => setBodyFormat('text')} />
                  Plain text
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="fmt" checked={bodyFormat === 'html'} onChange={() => setBodyFormat('html')} />
                  HTML (basic formatting)
                </label>
              </div>

              <Field
                label="Body"
                hint={
                  bodyFormat === 'html'
                    ? 'Allowed: p, br, b, i, u, a, lists, headings. Scripts, images and forms are removed. Use {{name}} for the contact\'s name.'
                    : "Use {{name}} for the contact's name. Line breaks are kept."
                }
              >
                <Textarea required rows={10} maxLength={20000} value={body} onChange={(e) => setBody(e.target.value)} />
              </Field>
              <Alert kind="info">An unsubscribe link is added to the bottom of every email automatically.</Alert>
            </>
          )}

        </Card>

        <Card className="space-y-6">
          <AttachmentPicker kind={kind} value={attachmentIds} onChange={setAttachmentIds} />
          <div className="border-t border-stone-100 pt-6">
            <SchedulePicker value={schedule} onChange={setSchedule} />
          </div>
        </Card>

        <Card className="space-y-5">
          <label className="flex items-start gap-2.5 rounded-xl border border-stone-200 bg-stone-50 p-4 text-sm leading-relaxed">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              I confirm everyone in this list has agreed to receive {isWhatsApp ? 'WhatsApp messages' : 'emails'} from me,
              and I'll stop contacting anyone who asks.
            </span>
          </label>

          {error && (
            <Alert>
              {error}
              {errorCode === 'sender_not_verified' && (
                <>
                  {' '}
                  <Link to="/email/settings" className="underline">
                    Verify your email address
                  </Link>
                </>
              )}
            </Alert>
          )}

          <Button type="submit" variant="accent" disabled={busy || !consent || (source === 'file' ? !file : !listId)}>
            {busy ? 'Starting...' : 'Start campaign'}
          </Button>
        </Card>
      </form>
    </>
  );
}
