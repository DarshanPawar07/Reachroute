// Runs after `vite build`. Writes each public page as finished HTML (so search engines and social apps see the
// words straight away), plus app.html (the empty shell for the logged-in app), sitemap.xml and robots.txt.
// The pages still turn into the normal interactive app in the browser.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, loadEnv } from 'vite';
import { appShell, inject, outputPath, siteOrigin } from './prerender-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const env = { ...loadEnv('production', root, 'VITE_'), ...process.env };
const { origin, guessed } = siteOrigin(env);

if (guessed) {
  console.warn('\n[prerender] WARNING: VITE_SITE_URL is not set, so links in the pages and sitemap use https://example.com.');
  console.warn('[prerender] Set VITE_SITE_URL to your real address (for example https://www.yourdomain.com) in Vercel, then redeploy.\n');
}

const template = await readFile(path.join(dist, 'index.html'), 'utf8');
const vite = await createServer({ root, mode: 'production', appType: 'custom', server: { middlewareMode: true }, logLevel: 'error' });

try {
  const seo = await vite.ssrLoadModule('/src/site/seo.js');
  const { render } = await vite.ssrLoadModule('/src/entry-server.jsx');

  for (const problem of seo.checkPages()) console.warn(`[prerender] SEO: ${problem}`);

  // the app shell first: the home page is about to take the place of dist/index.html
  await writeFile(path.join(dist, 'app.html'), appShell(template));

  for (const page of seo.PAGES) {
    const { html, head } = render(page.path, origin);
    if (!/<h1[\s>]/.test(html)) throw new Error(`${page.path} has no <h1>`);
    if ((html.match(/<h1[\s>]/g) || []).length !== 1) throw new Error(`${page.path} must have exactly one <h1>`);
    const file = path.join(dist, outputPath(page.path));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, inject(template, { head, html }));
    console.log(`[prerender] ${page.path}`);
  }

  await writeFile(path.join(dist, 'sitemap.xml'), seo.sitemapXml(origin, new Date().toISOString().slice(0, 10)));
  await writeFile(path.join(dist, 'robots.txt'), seo.robotsTxt(origin));
  console.log(`[prerender] ${seo.PAGES.length} pages, sitemap.xml and robots.txt written for ${origin}`);
} finally {
  await vite.close();
}
