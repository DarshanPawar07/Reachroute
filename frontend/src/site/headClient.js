// Keeps the browser tab title and the search tags right when someone clicks from page to page.
// The first page is already complete (the build wrote it), this only changes what the next page needs.
import { headFor, NOINDEX, pageFor } from './seo.js';

function setTag(selector, create, value, attr = 'content') {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}
const meta = (key, val) => () => {
  const el = document.createElement('meta');
  el.setAttribute(key, val);
  return el;
};

export function applyHead(pathname) {
  if (typeof document === 'undefined') return;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const known = pageFor(path) || NOINDEX[path];
  const h = headFor(known ? path : '/404', window.location.origin);
  // pages in the app itself keep a plain title and stay out of search
  const inApp = !known;
  document.title = inApp ? 'Reachroute' : h.title;
  setTag('meta[name="description"]', meta('name', 'description'), inApp ? 'Reachroute' : h.description);
  setTag('meta[name="robots"]', meta('name', 'robots'), inApp ? 'noindex, nofollow' : h.robots);
  setTag('link[rel="canonical"]', () => Object.assign(document.createElement('link'), { rel: 'canonical' }), h.canonical, 'href');
  const og = { 'og:title': h.og.title, 'og:description': h.og.description, 'og:url': h.og.url, 'og:image': h.og.image };
  for (const [k, v] of Object.entries(og)) setTag(`meta[property="${k}"]`, meta('property', k), v);
  setTag('meta[name="twitter:title"]', meta('name', 'twitter:title'), h.og.title);
  setTag('meta[name="twitter:description"]', meta('name', 'twitter:description'), h.og.description);
  document.head.querySelectorAll('script[data-seo="jsonld"]').forEach((n) => n.remove());
  if (!inApp) {
    for (const j of h.jsonLd) {
      const s = document.createElement('script');
      s.type = 'application/ld+json';
      s.dataset.seo = 'jsonld';
      s.textContent = JSON.stringify(j);
      document.head.appendChild(s);
    }
  }
}
