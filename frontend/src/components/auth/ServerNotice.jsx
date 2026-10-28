import { Alert } from '../ui.jsx';

/** Shown above the form when the server is waking up or cannot be reached. Nothing when it is fine. */
export default function ServerNotice({ info }) {
  if (info.state === 'slow') return <div className="mb-4"><Alert kind="info">The server is waking up. It sleeps when nobody is using it, and this can take up to a minute. You can start typing.</Alert></div>;
  if (info.state === 'down') return <div className="mb-4"><Alert kind="warn">{info.message}</Alert></div>;
  return null;
}
