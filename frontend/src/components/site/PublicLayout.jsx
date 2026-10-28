import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { API_BASE } from '../../api.js';
import { PATHS, SITE } from '../../site/siteConfig.js';
import { Logo } from '../AuthShell.jsx';
import Icon from '../Icon.jsx';
import { Container } from './parts.jsx';

const NAV = [
  { to: PATHS.features, label: 'Features' },
  { to: PATHS.pricing, label: 'Pricing' },
  { to: PATHS.about, label: 'About' },
  { to: PATHS.contact, label: 'Contact' },
];

function Header() {
  const [open, setOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const { pathname } = useLocation();

  // Looked up after the page loads, so the pre-built page and the live page start out identical.
  useEffect(() => {
    try {
      setSignedIn(Boolean(localStorage.getItem('token')));
    } catch {
      setSignedIn(false);
    }
  }, [pathname]);
  useEffect(() => setOpen(false), [pathname]);

  const link = ({ isActive }) => `rounded-lg px-3 py-2 text-[0.95rem] font-medium transition ${isActive ? 'text-stone-900' : 'text-stone-600 hover:text-stone-900'}`;

  return (
    <header className="sticky top-0 z-30 border-b border-stone-200 bg-stone-50/90 backdrop-blur">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link to={PATHS.home} aria-label="Reachroute home">
          <Logo />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={link}>{n.label}</NavLink>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          {signedIn ? (
            <Link to="/dashboard" className="rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-stone-700">Open dashboard</Link>
          ) : (
            <>
              <Link to={PATHS.login} className="rounded-lg px-3 py-2 text-[0.95rem] font-medium text-stone-700 hover:text-stone-900">Log in</Link>
              <Link to={PATHS.register} className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700">Start free</Link>
            </>
          )}
        </div>
        <button
          type="button"
          className="grid h-10 w-10 place-items-center rounded-lg text-stone-800 hover:bg-stone-200/60 md:hidden"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? 'close' : 'menu'} />
        </button>
      </Container>
      {open && (
        <div id="mobile-menu" className="border-t border-stone-200 bg-stone-50 md:hidden">
          <Container className="flex flex-col gap-1 py-3">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => `rounded-lg px-3 py-3 text-base font-medium ${isActive ? 'bg-stone-200/60 text-stone-900' : 'text-stone-700'}`}>{n.label}</NavLink>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-2">
              {signedIn ? (
                <Link to="/dashboard" className="col-span-2 rounded-xl bg-stone-900 px-4 py-3 text-center text-sm font-semibold text-white">Open dashboard</Link>
              ) : (
                <>
                  <Link to={PATHS.login} className="rounded-xl border border-stone-300 px-4 py-3 text-center text-sm font-semibold text-stone-900">Log in</Link>
                  <Link to={PATHS.register} className="rounded-xl bg-emerald-600 px-4 py-3 text-center text-sm font-semibold text-white">Start free</Link>
                </>
              )}
            </div>
          </Container>
        </div>
      )}
    </header>
  );
}

function FooterColumn({ title, children }) {
  return (
    <div>
      <h2 className="mb-3 font-sans text-sm font-semibold !text-white">{title}</h2>
      <ul className="space-y-2 text-[0.95rem]">{children}</ul>
    </div>
  );
}
const FLink = ({ to, children }) => (
  <li>
    <Link to={to} className="text-stone-300 hover:text-white hover:underline">{children}</Link>
  </li>
);

function Footer() {
  return (
    <footer className="bg-stone-950 pb-10 pt-14 text-stone-300">
      <Container>
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo light />
            <p className="mt-4 max-w-xs text-[0.95rem] leading-relaxed text-stone-400">{SITE.tagline}. For people who asked to hear from you.</p>
          </div>
          <FooterColumn title="Product">
            <FLink to={PATHS.whatsapp}>Bulk WhatsApp messaging</FLink>
            <FLink to={PATHS.email}>Bulk email sending</FLink>
            <FLink to={PATHS.instagram}>Bulk Instagram (planned)</FLink>
            <FLink to={PATHS.facebook}>Bulk Facebook (planned)</FLink>
            <FLink to={PATHS.pricing}>Pricing</FLink>
          </FooterColumn>
          <FooterColumn title="Company">
            <FLink to={PATHS.about}>About</FLink>
            <FLink to={PATHS.contact}>Contact</FLink>
            <FLink to={PATHS.login}>Log in</FLink>
            <FLink to={PATHS.register}>Create an account</FLink>
          </FooterColumn>
          <FooterColumn title="Legal">
            <li><a href={`${API_BASE}/legal/terms`} className="text-stone-300 hover:text-white hover:underline">Terms of use</a></li>
            <li><a href={`${API_BASE}/legal/privacy`} className="text-stone-300 hover:text-white hover:underline">Privacy policy</a></li>
            <li><a href={`${API_BASE}/legal/refunds`} className="text-stone-300 hover:text-white hover:underline">Refund and cancellation</a></li>
          </FooterColumn>
        </div>
        <div className="mt-12 flex flex-col gap-2 border-t border-white/10 pt-6 text-sm text-stone-400 sm:flex-row sm:justify-between">
          <p>© {new Date().getFullYear()} {SITE.operator || SITE.name}. All rights reserved.</p>
          <p>Not affiliated with WhatsApp, Meta, Instagram or Facebook.</p>
        </div>
      </Container>
    </footer>
  );
}

/** Frame for every page that needs no login. */
export default function PublicLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:shadow">
        Skip to content
      </a>
      <Header />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
