// Everything search engines read about the public pages: titles, descriptions, canonical links, social previews,
// structured data (JSON-LD), the sitemap and robots.txt. One table, used by the build step (to write the HTML
// for each page ahead of time) and by the browser (to keep the title right when someone clicks between pages).
import { ABOUT, CHANNELS, HOME_FAQ, PRICING_FAQ } from './content.js';
import { PLANS } from './plans.js';
import { PATHS, SITE } from './siteConfig.js';

const crumb = (name, path) => ({ name, path });
const HOME = crumb('Home', PATHS.home);

/** Every page that can be found by search. `priority` and `changefreq` feed the sitemap. */
export const PAGES = [
  {
    path: PATHS.home,
    title: 'Reachroute: Bulk WhatsApp and Email Sender for Business',
    description: 'Send bulk WhatsApp messages and bulk emails from one dashboard, at a safe pace, from your own number and email. Try it free with 50 WhatsApp messages and 100 emails.',
    faq: HOME_FAQ,
    priority: 1.0,
    changefreq: 'weekly',
  },
  {
    path: PATHS.features,
    title: 'Features: Bulk WhatsApp, Email and More | Reachroute',
    description: 'Personalised messages, scheduling, templates, contact lists, A/B subject lines, reports and automatic opt-out handling for bulk WhatsApp and email campaigns.',
    crumbs: [HOME, crumb('Features', PATHS.features)],
    priority: 0.9,
    changefreq: 'monthly',
  },
  {
    path: PATHS.whatsapp,
    title: 'Bulk WhatsApp Message Sender | Reachroute',
    description: 'Send bulk WhatsApp messages from your own number with safe pauses, daily limits and STOP handling. No API approval, no per-message fee. Try it free with 50 messages.',
    crumbs: [HOME, crumb('Features', PATHS.features), crumb('Bulk WhatsApp', PATHS.whatsapp)],
    faq: CHANNELS.whatsapp.faq,
    priority: 0.9,
    changefreq: 'monthly',
  },
  {
    path: PATHS.email,
    title: 'Bulk Email Sender with Unsubscribe Link | Reachroute',
    description: 'Send bulk email from your own Gmail, Outlook or SMTP account. Personalise every message, A/B test subjects and add an unsubscribe link to each email.',
    crumbs: [HOME, crumb('Features', PATHS.features), crumb('Bulk email', PATHS.email)],
    faq: CHANNELS.email.faq,
    priority: 0.9,
    changefreq: 'monthly',
  },
  {
    path: PATHS.instagram,
    title: 'Bulk Instagram Messaging, Coming Soon | Reachroute',
    description: 'Instagram direct messages are planned for Reachroute, next to WhatsApp and email. See what we are building and tell us what you would use it for.',
    crumbs: [HOME, crumb('Features', PATHS.features), crumb('Bulk Instagram', PATHS.instagram)],
    faq: CHANNELS.instagram.faq,
    priority: 0.5,
    changefreq: 'monthly',
  },
  {
    path: PATHS.facebook,
    title: 'Bulk Facebook Messenger, Coming Soon | Reachroute',
    description: 'Facebook Messenger for your business Page is planned for Reachroute, next to WhatsApp and email. See what we are building and tell us what you need.',
    crumbs: [HOME, crumb('Features', PATHS.features), crumb('Bulk Facebook', PATHS.facebook)],
    faq: CHANNELS.facebook.faq,
    priority: 0.5,
    changefreq: 'monthly',
  },
  {
    path: PATHS.pricing,
    title: 'Pricing: Free Plan and Paid Plans | Reachroute',
    description: 'Start free with 50 WhatsApp messages and 100 emails. Compare Free, Pro (₹699 a month), Premium (₹1,499 a month) and Business plans and see exactly what each one allows.',
    crumbs: [HOME, crumb('Pricing', PATHS.pricing)],
    faq: PRICING_FAQ,
    priority: 0.9,
    changefreq: 'monthly',
  },
  {
    path: PATHS.about,
    title: 'About Reachroute: Consent-First Bulk Messaging',
    description: 'Why we built Reachroute: bulk WhatsApp and email for people who asked to hear from you, with honest limits, your own accounts and plain pricing.',
    crumbs: [HOME, crumb('About', PATHS.about)],
    priority: 0.6,
    changefreq: 'monthly',
  },
  {
    path: PATHS.contact,
    title: 'Contact Reachroute: Sales and Support',
    description: 'Ask about plans, get help with a campaign, or tell us you want Instagram or Facebook Messenger. Send a message and we will reply.',
    crumbs: [HOME, crumb('Contact', PATHS.contact)],
    priority: 0.6,
    changefreq: 'yearly',
  },
];

/** Public pages that should NOT be in search results (the sign-in screens, and the not-found page). */
export const NOINDEX = {
  [PATHS.login]: { title: 'Log in | Reachroute', description: 'Log in to Reachroute to send your next WhatsApp or email campaign.' },
  [PATHS.register]: { title: 'Create your free account | Reachroute', description: 'Create a free Reachroute account. No card needed.' },
  '/404': { title: 'Page not found | Reachroute', description: 'This page does not exist.' },
};

export const pageFor = (path) => PAGES.find((p) => p.path === path);

const abs = (origin, path) => `${origin}${path === '/' ? '/' : path}`;

function organization(origin) {
  return {
    '@type': 'Organization',
    '@id': `${origin}/#organization`,
    name: SITE.name,
    url: `${origin}/`,
    logo: `${origin}/favicon.svg`,
    ...(SITE.contactEmail ? { email: SITE.contactEmail, contactPoint: [{ '@type': 'ContactPoint', contactType: 'customer support', email: SITE.contactEmail, availableLanguage: 'English' }] } : {}),
  };
}

function softwareApplication(origin) {
  return {
    '@type': 'SoftwareApplication',
    '@id': `${origin}/#software`,
    name: SITE.name,
    url: `${origin}/`,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: 'Send bulk WhatsApp messages and bulk emails from one dashboard, at a safe pace, from your own number and your own email account.',
    offers: PLANS.filter((p) => p.price !== null).map((p) => ({
      '@type': 'Offer',
      name: p.name,
      price: String(p.price),
      priceCurrency: 'INR',
      url: `${origin}${PATHS.pricing}`,
    })),
    publisher: { '@id': `${origin}/#organization` },
  };
}

/** What a page tells search engines and social apps. `origin` is the site address, like https://example.com. */
export function headFor(path, origin) {
  const page = pageFor(path);
  const quiet = NOINDEX[path];
  const meta = page || quiet || NOINDEX['/404'];
  const canonical = abs(origin, page ? path : path);
  const jsonLd = [];

  if (page) {
    if (path === PATHS.home) {
      jsonLd.push({
        '@context': 'https://schema.org',
        '@graph': [
          organization(origin),
          { '@type': 'WebSite', '@id': `${origin}/#website`, url: `${origin}/`, name: SITE.name, description: SITE.tagline, publisher: { '@id': `${origin}/#organization` }, inLanguage: 'en' },
          softwareApplication(origin),
        ],
      });
    }
    if (page.crumbs) {
      jsonLd.push({
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: page.crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: abs(origin, c.path) })),
      });
    }
    if (page.faq?.length) {
      jsonLd.push({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: page.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      });
    }
    if (path === PATHS.about) jsonLd.push({ '@context': 'https://schema.org', '@type': 'AboutPage', name: meta.title, url: canonical, description: ABOUT.lead });
    if (path === PATHS.contact) jsonLd.push({ '@context': 'https://schema.org', '@type': 'ContactPage', name: meta.title, url: canonical });
  }

  return {
    title: meta.title,
    description: meta.description,
    canonical,
    robots: page ? 'index, follow, max-image-preview:large' : 'noindex, nofollow',
    og: {
      type: 'website',
      siteName: SITE.name,
      title: meta.title,
      description: meta.description,
      url: canonical,
      image: `${origin}/og-image.png`,
      imageAlt: `${SITE.name}: ${SITE.tagline}`,
      locale: 'en_IN',
    },
    jsonLd,
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** JSON for a <script> tag: "<" is escaped so text can never close the tag early. */
const safeJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** The <head> tags for one page, as HTML text (the build step puts these in each page's file). */
export function headHtml(h) {
  const lines = [
    `<title>${esc(h.title)}</title>`,
    `<meta name="description" content="${esc(h.description)}" />`,
    `<meta name="robots" content="${esc(h.robots)}" />`,
    `<link rel="canonical" href="${esc(h.canonical)}" />`,
    `<meta property="og:type" content="${h.og.type}" />`,
    `<meta property="og:site_name" content="${esc(h.og.siteName)}" />`,
    `<meta property="og:title" content="${esc(h.og.title)}" />`,
    `<meta property="og:description" content="${esc(h.og.description)}" />`,
    `<meta property="og:url" content="${esc(h.og.url)}" />`,
    `<meta property="og:image" content="${esc(h.og.image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(h.og.imageAlt)}" />`,
    `<meta property="og:locale" content="${h.og.locale}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(h.og.title)}" />`,
    `<meta name="twitter:description" content="${esc(h.og.description)}" />`,
    `<meta name="twitter:image" content="${esc(h.og.image)}" />`,
    ...h.jsonLd.map((j) => `<script type="application/ld+json" data-seo="jsonld">${safeJson(j)}</script>`),
  ];
  return lines.join('\n    ');
}

export function sitemapXml(origin, isoDate) {
  const urls = PAGES.map(
    (p) => `  <url>\n    <loc>${esc(abs(origin, p.path))}</loc>\n    <lastmod>${isoDate}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority.toFixed(1)}</priority>\n  </url>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** The parts of the site that sit behind a login: search engines have no reason to visit them. */
export const PRIVATE_PATHS = ['/dashboard', '/whatsapp', '/email', '/instagram', '/facebook', '/lists', '/usage', '/notifications', '/account', '/admin', '/forgot-password', '/reset-password', '/verify-email', '/login', '/register', '/auth'];

export function robotsTxt(origin) {
  return `User-agent: *\nAllow: /\n${PRIVATE_PATHS.map((p) => `Disallow: ${p}`).join('\n')}\n\nSitemap: ${origin}/sitemap.xml\n`;
}

/** Problems with the table above, for the build to warn about (titles and descriptions that search engines cut short, repeats). */
export function checkPages() {
  const problems = [];
  const seen = new Map();
  for (const p of PAGES) {
    if (p.title.length > 62) problems.push(`${p.path}: title is ${p.title.length} characters (keep it to about 60)`);
    if (p.description.length > 165) problems.push(`${p.path}: description is ${p.description.length} characters (keep it to about 160)`);
    if (p.description.length < 70) problems.push(`${p.path}: description is short (${p.description.length} characters)`);
    for (const key of ['title', 'description']) {
      const k = `${key}:${p[key]}`;
      if (seen.has(k)) problems.push(`${p.path}: same ${key} as ${seen.get(k)}`);
      seen.set(k, p.path);
    }
  }
  return problems;
}
