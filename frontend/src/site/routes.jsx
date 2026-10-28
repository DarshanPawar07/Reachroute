// The pages that need no login, in one list: used by the live app and by the build step that writes them ahead of time.
import PublicLayout from '../components/site/PublicLayout.jsx';
import About from '../pages/site/About.jsx';
import Contact from '../pages/site/Contact.jsx';
import FeaturePage from '../pages/site/FeaturePage.jsx';
import Features from '../pages/site/Features.jsx';
import Home from '../pages/site/Home.jsx';
import NotFound from '../pages/site/NotFound.jsx';
import Pricing from '../pages/site/Pricing.jsx';
import { PATHS } from './siteConfig.js';

export { PublicLayout, NotFound };

export const PUBLIC_ROUTES = [
  { path: PATHS.home, element: <Home /> },
  { path: PATHS.features, element: <Features /> },
  { path: PATHS.whatsapp, element: <FeaturePage channel="whatsapp" /> },
  { path: PATHS.email, element: <FeaturePage channel="email" /> },
  { path: PATHS.instagram, element: <FeaturePage channel="instagram" /> },
  { path: PATHS.facebook, element: <FeaturePage channel="facebook" /> },
  { path: PATHS.pricing, element: <Pricing /> },
  { path: PATHS.about, element: <About /> },
  { path: PATHS.contact, element: <Contact /> },
];
