import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { buttonClass } from './ui.jsx';

/** A "Replies" button with the number of replies not read yet. */
export default function RepliesLink({ base }) {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    api(`/api${base}/replies/unread-count`)
      .then((r) => setUnread(r.unread))
      .catch(() => {});
  }, [base]);
  return (
    <Link to={`${base}/replies`} className={buttonClass('secondary')}>
      Replies
      {unread > 0 && <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">{unread > 99 ? '99+' : unread}</span>}
    </Link>
  );
}
