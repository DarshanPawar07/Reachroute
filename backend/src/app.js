import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { config } from './config.js';
import { whatsappChannel, whatsappEngine } from './engine/channels.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { requestLog } from './middleware/requestLog.js';
import { renderMetrics } from './monitoring/ops.js';
import { attachmentsRouter } from './routes/attachments.js';
import { accountRouter } from './routes/account.js';
import { legalApiRouter, legalPagesRouter } from './routes/legal.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { campaignRouter } from './routes/campaigns.js';
import dashboardRoutes from './routes/dashboard.js';
import { emailRouter } from './routes/email.js';
import { feedbackRouter } from './routes/emailFeedback.js';
import hooksRoutes from './routes/hooks.js';
import { listsRouter } from './routes/lists.js';
import { templatesRouter } from './routes/templates.js';
import notificationRoutes from './routes/notifications.js';
import statsRoutes from './routes/stats.js';
import unsubscribeRoutes from './routes/unsubscribe.js';
import { imapRouter } from './routes/imap.js';
import repliesRouter, { emailRepliesRouter } from './routes/replies.js';
import { whatsappRouter } from './routes/whatsapp.js';

/**
 * Builds the Express app. No side effects (no listening, no database connection), so tests can import it.
 * `limiters` comes from createLimiters(); `isDraining()` makes /ready fail during shutdown so load balancers stop sending traffic.
 */
export function buildApp(limiters, { isDraining = () => false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(requestLog);
  app.use(helmet());
  app.use(
    cors({
      // requests without an Origin header (curl, server to server, mail apps) are not browsers and are always fine
      origin: (origin, done) => done(null, !origin || config.corsOrigins.includes(origin)),
      maxAge: 600,
    })
  );

  // Probes sit before rate limiting and body parsing.
  app.get('/health', (_req, res) => res.json({ ok: true })); // process is alive
  app.get('/ready', async (_req, res) => {
    // database reachable and not shutting down: safe to receive traffic
    try {
      if (isDraining() || mongoose.connection.readyState !== 1) throw new Error('not ready');
      await mongoose.connection.db.admin().ping();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // Metrics for Prometheus / Grafana / uptime tools. Off unless METRICS_TOKEN is set; then it needs "Authorization: Bearer <token>".
  app.get('/metrics', async (req, res) => {
    if (!config.metricsToken) return res.status(404).json({ error: 'Not found' });
    const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
    const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!crypto.timingSafeEqual(digest(given), digest(config.metricsToken))) return res.status(401).json({ error: 'Unauthorized' });
    res.set('Cache-Control', 'no-store').type('text/plain; version=0.0.4; charset=utf-8').send(await renderMetrics({ draining: isDraining() }));
  });

  app.use(limiters.global);

  // Public: bounce and complaint notices from email providers. Before the normal body parser: notices can be larger,
  // and Amazon SNS labels its JSON as text/plain. The secret in the address says which account it is for.
  app.use('/hooks/email', limiters.webhook, express.json({ limit: '1mb', type: () => true }), hooksRoutes);

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' })); // one-click unsubscribe posts a small form

  // Public: linked from every email
  app.use('/legal', legalPagesRouter());
  app.use('/unsubscribe', limiters.unsubscribe, unsubscribeRoutes);

  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/auth', authRouter(limiters));
  app.use('/api/legal', legalApiRouter()); // public: the Terms and Privacy Policy

  // Everything below needs a logged-in user and is rate limited per user.
  app.use('/api', requireAuth, limiters.api);
  app.use('/api/admin', adminRouter());
  app.use('/api/account', accountRouter());
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/lists', listsRouter());
  app.use('/api/templates', templatesRouter());
  app.use('/api/attachments', attachmentsRouter(limiters));
  app.use('/api/whatsapp/campaigns', campaignRouter(whatsappChannel, whatsappEngine, { createLimiter: limiters.createCampaign }));
  app.use('/api/whatsapp/replies', repliesRouter);
  app.use('/api/whatsapp', whatsappRouter({ connectLimiter: limiters.waConnect }));
  app.use('/api/email/feedback', feedbackRouter(limiters));
  app.use('/api/email/replies', emailRepliesRouter());
  app.use('/api/email/imap', imapRouter(limiters));
  app.use('/api/email', emailRouter(limiters));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
