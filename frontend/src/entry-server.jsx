// Used only by the build step (scripts/prerender.mjs): turns one public page into HTML text.
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { headFor, headHtml } from './site/seo.js';
import { NotFound, PUBLIC_ROUTES, PublicLayout } from './site/routes.jsx';

export function render(path, origin) {
  const html = renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<PublicLayout />}>
          {PUBLIC_ROUTES.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  return { html, head: headHtml(headFor(path, origin)) };
}

export { PUBLIC_ROUTES };
