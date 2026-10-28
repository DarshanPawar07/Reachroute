import { useEffect, useRef, useState } from 'react';
import { buttonClass } from './ui.jsx';

// A confirmation window drawn by the app, used instead of the browser's own "localhost says" box.
//   if (!(await askConfirm('Delete this list?'))) return;
//   askConfirm(message, { title, confirmLabel, cancelLabel, danger })  -> Promise<boolean>
// <ConfirmHost /> must be rendered once (App.jsx does it).

let show = null;

/** The first word of the question makes a good button label: "Delete this list?" -> "Delete". */
const labelFor = (message) => {
  const w = /^(Delete|Remove|Disconnect|Log out|Sign out|Forget|Replace|Cancel)\b/.exec(message);
  return w ? w[1] : 'Continue';
};

export function askConfirm(message, opts = {}) {
  if (!show) return Promise.resolve(window.confirm(message)); // the host is not on the page (should not happen)
  return new Promise((resolve) => show({ message, ...opts, resolve }));
}

export default function ConfirmHost() {
  const [ask, setAsk] = useState(null);
  const backRef = useRef(null);

  useEffect(() => {
    show = (a) => setAsk(a);
    return () => {
      show = null;
    };
  }, []);

  const close = (answer) => {
    ask?.resolve(answer);
    setAsk(null);
  };

  useEffect(() => {
    if (!ask) return undefined;
    backRef.current?.focus(); // the safe choice has focus, so Enter by accident does not delete anything
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!ask) return null;
  const confirmLabel = ask.confirmLabel || labelFor(ask.message);
  const danger = ask.danger ?? /^(Delete|Remove|Disconnect|Log out|Sign out|Forget|Cancel)\b/.test(ask.message);
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-stone-900/50 p-4 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text" className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 shadow-xl">
        <h2 id="confirm-title" className="text-lg font-semibold text-stone-900">{ask.title || 'Are you sure?'}</h2>
        <p id="confirm-text" className="mt-2 text-[0.95rem] leading-relaxed text-stone-600">{ask.message}</p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button ref={backRef} type="button" className={buttonClass('secondary')} onClick={() => close(false)}>
            {ask.cancelLabel || 'Go back'}
          </button>
          <button type="button" className={buttonClass(danger ? 'danger' : 'accent')} onClick={() => close(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
