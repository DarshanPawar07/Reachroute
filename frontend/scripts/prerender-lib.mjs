// The small, testable parts of the build step that writes each public page ahead of time.

/** The address of the live site, like https://reachroute.in. Needed for canonical links, social previews and the sitemap. */
export function siteOrigin(env) {
  const raw = env.VITE_SITE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`) || env.URL || '';
  if (!raw) return { origin: 'https://example.com', guessed: true };
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return { origin: withScheme.replace(/\/+$/, ''), guessed: false };
}

const START = '<!--seo-head-start-->';
const END = '<!--seo-head-end-->';

/** Puts a page's head tags and body content into the built index.html. */
export function inject(template, { head, html }) {
  const a = template.indexOf(START);
  const b = template.indexOf(END);
  if (a === -1 || b === -1) throw new Error('index.html has lost its <!--seo-head-start--> / <!--seo-head-end--> markers');
  let out = template.slice(0, a) + head + template.slice(b + END.length);
  const root = '<div id="root"></div>';
  if (!out.includes(root)) throw new Error('index.html has no <div id="root"></div>');
  out = out.replace(root, `<div id="root" data-prerendered="true">${html}</div>`);
  return out;
}

/** The plain page for the app itself (dashboard, campaigns...): nothing for search engines to index. */
export function appShell(template, title = 'Reachroute') {
  const a = template.indexOf(START);
  const b = template.indexOf(END);
  if (a === -1 || b === -1) throw new Error('index.html has lost its <!--seo-head-start--> / <!--seo-head-end--> markers');
  const head = `<title>${title}</title>\n    <meta name="robots" content="noindex, nofollow" />`;
  return template.slice(0, a) + head + template.slice(b + END.length);
}

/** Where a page's file goes inside dist/. "/" is index.html; "/features" is features/index.html. */
export function outputPath(path) {
  return path === '/' ? 'index.html' : `${path.replace(/^\/+|\/+$/g, '')}/index.html`;
}
