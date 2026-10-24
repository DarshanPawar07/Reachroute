import { Router } from 'express';
import { allDocuments, getDocument, renderHtml } from '../legal/documents.js';
import { bad } from '../utils/http.js';

const summary = (d) => ({ doc: d.doc, title: d.title, version: d.version, url: `/legal/${d.doc}` });

/** Public: the documents as data (for the app) under /api/legal. */
export function legalApiRouter() {
  const router = Router();
  router.get('/', (_req, res) => res.json({ documents: allDocuments().map(summary) }));
  router.get('/:doc', (req, res) => {
    const doc = getDocument(req.params.doc);
    if (!doc) throw bad('Not found', 404);
    res.json({ document: doc });
  });
  return router;
}

/** Public: the same documents as plain web pages under /legal, for links in emails and the sign-up form. */
export function legalPagesRouter() {
  const router = Router();
  router.get('/:doc', (req, res) => {
    const doc = getDocument(req.params.doc);
    if (!doc) throw bad('Not found', 404);
    res.type('html').send(renderHtml(doc));
  });
  return router;
}
