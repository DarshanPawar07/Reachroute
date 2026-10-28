// The facts about the business that appear on the public pages. Change them here, nowhere else.

const env = import.meta.env || {};

export const SITE = {
  name: 'Reachroute',
  tagline: 'Bulk WhatsApp and email campaigns from one place',
  // Shown on the Contact page and in search results. Set VITE_CONTACT_EMAIL in the frontend environment (Vercel / Netlify).
  contactEmail: env.VITE_CONTACT_EMAIL || '',
  // The legal name of whoever runs the service, for the footer and the About page. Set VITE_LEGAL_NAME to your own.
  operator: env.VITE_LEGAL_NAME || '',
  // How quickly you answer messages. Only promise what you will keep.
  replyTime: 'We usually reply within two working days.',
  // The backend address (legal pages are served from there).
  apiBase: env.VITE_API_URL || 'http://localhost:4000',
};

/** Paths of the pages that need no login. Used by links, the sitemap and the pre-render step. */
export const PATHS = {
  home: '/',
  features: '/features',
  whatsapp: '/features/bulk-whatsapp-messaging',
  email: '/features/bulk-email-sending',
  instagram: '/features/bulk-instagram-messaging',
  facebook: '/features/bulk-facebook-messaging',
  pricing: '/pricing',
  about: '/about',
  contact: '/contact',
  login: '/login',
  register: '/register',
};
