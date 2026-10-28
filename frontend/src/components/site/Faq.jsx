// Questions and answers. Uses the browser's own open/close control, so it works without JavaScript and every
// answer is in the page text for search engines.
export default function Faq({ items, title = 'Questions people ask' }) {
  return (
    <div>
      <h2 className="mb-8 text-[1.85rem] font-semibold leading-[1.12] sm:text-4xl">{title}</h2>
      <div className="divide-y divide-stone-200 border-y border-stone-200">
        {items.map((f) => (
          <details key={f.q} className="group py-1">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-6 py-4 text-left text-[1.05rem] font-semibold text-stone-900 [&::-webkit-details-marker]:hidden">
              <span>{f.q}</span>
              <span aria-hidden="true" className="mt-1 grid h-5 w-5 shrink-0 place-items-center text-stone-500 transition group-open:rotate-45">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              </span>
            </summary>
            <p className="max-w-3xl pb-5 pr-10 leading-relaxed text-stone-600">{f.a}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
