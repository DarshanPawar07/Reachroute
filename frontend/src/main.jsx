import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

const root = document.getElementById('root');
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// Pages written ahead of time by the build (see scripts/prerender.mjs) come with their content already in place:
// React attaches to it. The app pages (dashboard, campaigns...) start empty and are drawn in the browser.
if (root.hasAttribute('data-prerendered')) hydrateRoot(root, app);
else createRoot(root).render(app);
