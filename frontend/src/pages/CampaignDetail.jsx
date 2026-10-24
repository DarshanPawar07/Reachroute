import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, downloadFile } from '../api.js';
import { KINDS, fmtDate, fmtSize } from '../lib/kinds.js';
import SchedulePicker from '../components/SchedulePicker.jsx';
import { DAY_NAMES, scheduleFields, scheduleFromCampaign, scheduleProblem } from '../lib/schedule.js';
import { Alert, Badge, Button, Card, PageHeader, ProgressBar, Stat } from '../components/ui.jsx';

export default function CampaignDetail({ kind }) {
  const { id } = useParams();
  const k = KINDS[kind];
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // the schedule being edited, or null

  const load = useCallback(async () => {
    try {
      setData(await api(`${k.api}/${id}`));
    } catch (e) {
      setError(e.message);
    }
  }, [k.api, id]);

  useEffect(() => {
    load();
  }, [load]);

  const status = data?.campaign.status;

  // Keep the numbers live while the campaign is running.
  useEffect(() => {
    if (status !== 'running' && status !== 'preparing') return undefined;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [status, load]);

  const act = async (action, body) => {
    if (action === 'cancel' && !window.confirm('Cancel this campaign? Messages not yet sent will not be sent.')) return;
    if (body?.includeAmbiguous && !window.confirm('These may already have been delivered. Sending them again could mean the person gets the message twice. Continue?')) return;
    setBusy(true);
    setError('');
    try {
      await api(`${k.api}/${id}/${action}`, { method: 'POST', body });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveSchedule = async () => {
    const c = data.campaign;
    const notStarted = c.startAt && new Date(c.startAt).getTime() > Date.now();
    const problem = scheduleProblem(editing, { allowStart: notStarted });
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      const fields = scheduleFields(editing, { sendStart: Boolean(notStarted), hadWindow: Boolean(c.sendWindow) });
      if (!Object.keys(fields).length) {
        setEditing(null);
        return;
      }
      await api(`${k.api}/${id}/schedule`, { method: 'PATCH', body: fields });
      setEditing(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const downloadReport = async () => {
    setError('');
    try {
      await downloadFile(`${k.api}/${id}/report.csv`, 'campaign-report.csv');
    } catch (e) {
      setError(e.message);
    }
  };

  if (!data) {
    return error ? (
      <>
        <Alert>{error}</Alert>
        <Link to={k.base} className="mt-4 inline-block text-sm underline">
          Back
        </Link>
      </>
    ) : (
      <p className="text-sm text-stone-500">Loading...</p>
    );
  }

  const { campaign: c, recipients } = data;
  const pending = Math.max(0, c.total - c.sentCount - c.failedCount - c.skippedCount);
  const canPause = c.status === 'running';
  const canResume = c.status === 'paused';
  const canCancel = c.status === 'running' || c.status === 'paused';
  const canRetry = c.failedCount > 0 && ['running', 'paused', 'completed'].includes(c.status);
  const hasMaybeDelivered = recipients.some((r) => r.status === 'failed' && r.ambiguous);

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={`${k.label} campaign · started ${fmtDate(c.createdAt)}`}
        actions={
          <>
            <Button variant="secondary" onClick={downloadReport}>
              Download report (CSV)
            </Button>
            <Link to={k.base} className="self-center text-sm underline">
              Back
            </Link>
          </>
        }
      />

      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {c.status === 'paused' && c.pauseReason && <Alert kind="warn">Paused: {c.pauseReason}</Alert>}

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <Badge status={c.status} />
            <div className="flex gap-2">
              {canPause && (
                <Button variant="secondary" disabled={busy} onClick={() => act('pause')}>
                  Pause
                </Button>
              )}
              {canResume && (
                <Button variant="accent" disabled={busy} onClick={() => act('resume')}>
                  Resume
                </Button>
              )}
              {canRetry && (
                <Button variant="secondary" disabled={busy} onClick={() => act('retry', {})}>
                  Retry failed
                </Button>
              )}
              {canRetry && hasMaybeDelivered && (
                <Button variant="secondary" disabled={busy} onClick={() => act('retry', { includeAmbiguous: true })}>
                  Retry incl. maybe delivered
                </Button>
              )}
              {canCancel && (
                <Button variant="danger" disabled={busy} onClick={() => act('cancel')}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
          <ProgressBar sent={c.sentCount} failed={c.failedCount} skipped={c.skippedCount} total={c.total} />
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Total" value={c.total} />
            <Stat label="Sent" value={c.sentCount} />
            <Stat label="Failed" value={c.failedCount} />
            <Stat label="Skipped" value={c.skippedCount} />
            <Stat label="Waiting" value={pending} />
          </div>
          {c.replies?.total > 0 && (
            <p className="mt-3 text-sm text-stone-700">
              {c.replies.people} {c.replies.people === 1 ? 'person' : 'people'} replied ({c.replies.total} {c.replies.total === 1 ? 'message' : 'messages'}
              {c.replies.optOuts ? `, ${c.replies.optOuts} asked to stop` : ''}).{' '}
              <Link className="underline" to={`${k.base}/replies?campaignId=${c._id}`}>
                Read them
              </Link>
            </p>
          )}
        </Card>

        {(c.startAt || c.sendWindow || ['running', 'paused'].includes(c.status)) && (
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Schedule</h2>
              {['running', 'paused'].includes(c.status) && !editing && (
                <Button variant="secondary" onClick={() => setEditing(scheduleFromCampaign(c))}>
                  Change schedule
                </Button>
              )}
            </div>
            {!editing && (
              <p className="text-sm text-stone-600">
                {c.startAt && new Date(c.startAt) > new Date() ? `Starts ${fmtDate(c.startAt)}. ` : 'Started. '}
                {c.sendWindow
                  ? `Sends ${c.sendWindow.start} to ${c.sendWindow.end} (${c.sendWindow.timezone})${c.sendWindow.days?.length ? ` on ${c.sendWindow.days.map((d) => DAY_NAMES[d]).join(', ')}` : ', every day'}.`
                  : 'No daily sending hours set.'}
                {c.nextSendAt ? ` Next message: ${fmtDate(c.nextSendAt)}.` : ''}
              </p>
            )}
            {editing && (
              <>
                <SchedulePicker value={editing} onChange={setEditing} allowStart={Boolean(c.startAt && new Date(c.startAt) > new Date())} />
                <div className="flex gap-2">
                  <Button disabled={busy} onClick={saveSchedule}>
                    Save schedule
                  </Button>
                  <Button variant="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </Card>
        )}

        <Card>
          <h2 className="mb-2 text-lg font-semibold">Message</h2>
          {kind === 'email' && <p className="mb-1 text-sm text-stone-600">{c.subjectB ? 'Subject A: ' : 'Subject: '}{c.subject}</p>}
          {kind === 'email' && c.subjectB && <p className="mb-2 text-sm text-stone-600">Subject B: {c.subjectB}</p>}
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-sm">
            {kind === 'whatsapp' ? c.template : c.body}
          </pre>
          {c.attachments?.length > 0 && (
            <p className="mt-3 text-sm text-stone-600">
              Attached: {c.attachments.map((a) => `${a.name} (${fmtSize(a.size)})`).join(', ')}
            </p>
          )}
        </Card>

        {c.variants && (
          <Card>
            <h2 className="mb-1 text-lg font-semibold">A/B test</h2>
            <p className="mb-3 text-sm text-stone-600">How each subject line did. Replies are the best sign of interest here, because opens are not tracked.</p>
            <table className="w-full text-left text-sm">
              <thead className="text-[0.8rem] font-semibold text-stone-500">
                <tr>
                  <th className="py-2 pr-3">Version</th>
                  <th className="py-2 pr-3">People</th>
                  <th className="py-2 pr-3">Sent</th>
                  <th className="py-2 pr-3">Failed</th>
                  <th className="py-2 pr-3">Bounced</th>
                  <th className="py-2 pr-3">Spam reports</th>
                  <th className="py-2 pr-3">Unsubscribed</th>
                  <th className="py-2">Replies</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 tabular-nums">
                {['A', 'B'].map((v) => (
                  <tr key={v}>
                    <td className="py-2 pr-3 font-medium">{v}</td>
                    <td className="py-2 pr-3">{c.variants[v].people}</td>
                    <td className="py-2 pr-3">{c.variants[v].sent}</td>
                    <td className="py-2 pr-3">{c.variants[v].failed}</td>
                    <td className="py-2 pr-3">{c.variants[v].bounced}</td>
                    <td className="py-2 pr-3">{c.variants[v].complaints}</td>
                    <td className="py-2 pr-3">{c.variants[v].unsubscribed}</td>
                    <td className="py-2 font-medium">{c.variants[v].replies || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        <Card>
          <h2 className="mb-3 text-lg font-semibold">Recipients</h2>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-white text-[0.8rem] font-semibold text-stone-500">
                <tr>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">{k.contactLabel}</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {recipients.map((r) => (
                  <tr key={r._id}>
                    <td className="py-2 pr-3">{r.name || '-'}</td>
                    <td className="py-2 pr-3">{r[k.contactKey]}</td>
                    <td className="py-2 pr-3">
                      <Badge status={r.status} />
                    </td>
                    <td className="py-2 text-xs text-stone-500">{r.error || (r.sentAt ? fmtDate(r.sentAt) : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
