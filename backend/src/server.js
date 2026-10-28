import http from 'node:http';
import mongoose from 'mongoose';
import { buildApp } from './app.js';
import { startAttachmentPurge } from './attachments/store.js';
import { config } from './config.js';
import { closeAllSenders } from './email/mailer.js';
import { emailEngine, whatsappEngine } from './engine/channels.js';
import { engineEvents } from './engine/sendEngine.js';
import { startAuditPurge } from './audit/audit.js';
import { startBillingJob } from './billing/service.js';
import { ensureDefaultPlans } from './plans/defaults.js';
import { startReplyPoller } from './email/imap.js';
import { createWatchdog } from './monitoring/ops.js';
import { closeRateLimitStore, createLimiters, initRateLimitStore } from './middleware/limits.js';
import { logger } from './utils/logger.js';
import { notify } from './utils/notify.js';
import { startHealthMonitor } from './whatsapp/health.js';
import * as wa from './whatsapp/sessionManager.js';

let draining = false;
let server;
let healthMonitor;
let watchdog;
let auditPurge;
let attachmentPurge;
let replyPoller;
let stopBilling;

async function connectDatabase() {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 30 });

  // Build indexes now. A failure (for example duplicates already in old data) is logged but must not stop the server.
  await Promise.all(
    Object.values(mongoose.models).map((m) =>
      m.init().catch((err) => logger.error({ err: err.message, model: m.modelName }, 'could not build indexes'))
    )
  );
}

async function main() {
  await connectDatabase();
  await initRateLimitStore();
  const made = await ensureDefaultPlans();
  if (made.length) logger.info({ plans: made }, 'created the starting plans');
  const app = buildApp(createLimiters(), { isDraining: () => draining });

  // When someone's WhatsApp login ends, pause their running campaigns so nothing sits half-sent, and tell them.
  wa.sessionEvents.on('ended', async ({ userId, reason, pause, byUser }) => {
    if (pause === false) return; // the session just moved to another server: nothing is wrong
    let paused = 0;
    try {
      paused = await whatsappEngine.pauseAllForUser(userId, reason);
    } catch (err) {
      logger.error({ err, userId }, 'could not pause campaigns');
    }
    if (byUser) return; // they pressed Disconnect themselves: no alert needed
    await notify(userId, {
      type: 'whatsapp_disconnected',
      level: 'error',
      title: 'WhatsApp disconnected',
      message: `${reason}${paused ? ` ${paused} running campaign${paused === 1 ? ' was' : 's were'} paused.` : ''}`,
      link: '/whatsapp',
      dedupeKey: 'whatsapp_disconnected',
      email: true,
    });
  });

  // Alerts for campaigns: paused by a problem (needs attention) and finished.
  engineEvents.on('paused', ({ channel, userId, campaignId, campaignName, reason }) =>
    notify(userId, {
      type: 'campaign_paused',
      level: 'warning',
      title: `Campaign paused: ${campaignName}`,
      message: reason,
      link: `/${channel}/campaigns/${campaignId}`,
      dedupeKey: `paused:${campaignId}`,
      email: true,
    })
  );
  engineEvents.on('completed', ({ channel, userId, campaignId, campaignName, total, sent, failed, skipped }) =>
    notify(userId, {
      type: 'campaign_completed',
      level: failed > 0 ? 'warning' : 'success',
      title: `Campaign finished: ${campaignName}`,
      message: `${sent} sent, ${failed} failed, ${skipped} skipped, out of ${total}.`,
      link: `/${channel}/campaigns/${campaignId}`,
      dedupeKey: `completed:${campaignId}`,
    })
  );

  whatsappEngine.start();
  emailEngine.start();
  wa.startLoops();
  healthMonitor = startHealthMonitor({ engine: whatsappEngine, ownedUserIds: wa.ownedUserIds });

  watchdog = createWatchdog();
  watchdog.start();
  auditPurge = startAuditPurge();
  attachmentPurge = startAttachmentPurge();
  replyPoller = startReplyPoller();
  stopBilling = startBillingJob();

  server = http.createServer(app);
  server.keepAliveTimeout = 65_000; // longer than common load balancer idle timeouts (60s), so no 502s from reused sockets
  server.headersTimeout = 66_000;
  server.requestTimeout = 60_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, resolve);
  });
  logger.info({ port: config.port, instanceId: config.instanceId, env: config.env }, 'API listening');
}

let shuttingDown = false;

/** Stop taking traffic, let sends in progress finish, release WhatsApp sessions, close the database. */
async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  draining = true;
  logger.info({ reason }, 'shutting down');

  const force = setTimeout(() => {
    logger.error('shutdown took too long, exiting');
    process.exit(1);
  }, 35_000);
  force.unref();

  try {
    if (server) {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 10_000).unref();
      await Promise.race([closed, new Promise((r) => setTimeout(r, 12_000))]);
    }
    healthMonitor?.stop();
    watchdog?.stop();
    auditPurge?.stop();
    attachmentPurge?.stop();
    replyPoller?.stop();
    stopBilling?.();
    await Promise.all([whatsappEngine.stop(20_000), emailEngine.stop(20_000)]);
    await wa.shutdown();
    closeAllSenders();
    await closeRateLimitStore();
    await mongoose.disconnect();
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    exitCode = exitCode || 1;
  }
  process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// WhatsApp libraries sometimes leave stray rejections. Log them and carry on.
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
// After an uncaught exception the process state is unknown: finish what we can and let the process manager restart us.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  shutdown('uncaughtException', 1);
});

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
