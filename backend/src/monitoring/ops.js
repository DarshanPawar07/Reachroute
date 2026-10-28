import { monitorEventLoopDelay } from 'node:perf_hooks';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { Campaign, EmailCampaign, EmailRecipient, Lock, Recipient } from '../models.js';
import { sendSystemEmail } from '../utils/systemMail.js';
import { logger } from '../utils/logger.js';
import { registry } from '../utils/metrics.js';
import { ownedUserIds, isConnected } from '../whatsapp/sessionManager.js';

const log = logger.child({ mod: 'ops' });

const CHANNELS = [
  ['whatsapp', Recipient, Campaign],
  ['email', EmailRecipient, EmailCampaign],
];
const STATS_CACHE_MS = 10_000;
const ALERT_GAP_MS = 30 * 60_000; // one alert per problem every 30 minutes across all instances

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

// ---------------------------------------------------------------- queue numbers

let cached = null;

/**
 * What the send queues look like right now, per channel:
 *  - due: messages whose send time has passed and that are waiting
 *  - oldestDueSeconds: how long the one that waited longest has been waiting
 *  - sending / stuckSending: messages being sent, and those claimed so long ago that the reaper should have dealt with them
 *  - running / paused: campaigns
 * Cached for a few seconds so a busy scraper cannot load the database.
 */
export async function collectQueueStats({ now = Date.now(), fresh = false, stuckAfterMs = config.claimTimeoutMs + 5 * 60_000 } = {}) {
  if (!fresh && cached && now - cached.at < STATS_CACHE_MS && now >= cached.at) return cached.value;
  const due = { status: 'pending', scheduledFor: { $ne: null, $lte: new Date(now) } };
  const value = {};
  await Promise.all(
    CHANNELS.map(async ([channel, R, C]) => {
      const [dueCount, oldest, sending, stuck, running, paused] = await Promise.all([
        R.countDocuments(due),
        R.findOne(due).sort({ scheduledFor: 1 }).select('scheduledFor').lean(),
        R.countDocuments({ status: 'sending' }),
        R.countDocuments({ status: 'sending', claimedAt: { $lt: new Date(now - stuckAfterMs) } }),
        C.countDocuments({ status: 'running' }),
        C.countDocuments({ status: 'paused' }),
      ]);
      value[channel] = {
        due: dueCount,
        oldestDueSeconds: oldest ? Math.max(0, Math.round((now - oldest.scheduledFor.getTime()) / 1000)) : 0,
        sending,
        stuckSending: stuck,
        running,
        paused,
      };
    })
  );
  cached = { at: now, value };
  return value;
}

export const clearStatsCache = () => {
  cached = null;
};

// ---------------------------------------------------------------- /metrics

/** The whole /metrics document. Database numbers are skipped (and database_up is 0) when the database is unreachable. */
export async function renderMetrics({ draining = false } = {}) {
  const mem = process.memoryUsage();
  const delay = loopDelay.percentile(99) / 1e9;
  loopDelay.reset();
  const dbUp = mongoose.connection.readyState === 1;

  const gauges = [
    { name: 'bulkmessenger_process_uptime_seconds', help: 'Seconds this process has been running.', samples: [{ value: Math.round(process.uptime()) }] },
    { name: 'bulkmessenger_process_resident_memory_bytes', help: 'Memory used by this process.', samples: [{ value: mem.rss }] },
    { name: 'bulkmessenger_process_heap_used_bytes', help: 'JavaScript heap in use.', samples: [{ value: mem.heapUsed }] },
    { name: 'bulkmessenger_eventloop_delay_p99_seconds', help: 'Event loop delay (99th percentile) since the last scrape.', samples: [{ value: Number.isFinite(delay) ? delay : 0 }] },
    { name: 'bulkmessenger_database_up', help: '1 when the database connection is up.', samples: [{ value: dbUp ? 1 : 0 }] },
    { name: 'bulkmessenger_draining', help: '1 while this instance is shutting down.', samples: [{ value: draining ? 1 : 0 }] },
    {
      name: 'bulkmessenger_whatsapp_sessions',
      help: 'WhatsApp sessions held by this instance.',
      samples: (() => {
        const ids = ownedUserIds();
        return [
          { labels: { state: 'held' }, value: ids.length },
          { labels: { state: 'connected' }, value: ids.filter((id) => isConnected(id)).length },
        ];
      })(),
    },
  ];

  if (dbUp) {
    try {
      const stats = await collectQueueStats();
      const per = (pick) => Object.entries(stats).map(([channel, s]) => ({ labels: { channel }, value: pick(s) }));
      gauges.push(
        { name: 'bulkmessenger_queue_due', help: 'Messages whose send time has passed and are waiting.', samples: per((s) => s.due) },
        { name: 'bulkmessenger_queue_oldest_due_seconds', help: 'How long the longest-waiting due message has waited.', samples: per((s) => s.oldestDueSeconds) },
        { name: 'bulkmessenger_queue_sending', help: 'Messages being sent right now.', samples: per((s) => s.sending) },
        { name: 'bulkmessenger_queue_stuck_sending', help: 'Messages claimed long ago and never finished.', samples: per((s) => s.stuckSending) },
        {
          name: 'bulkmessenger_campaigns',
          help: 'Campaigns that are running or paused.',
          samples: Object.entries(stats).flatMap(([channel, s]) => [
            { labels: { channel, status: 'running' }, value: s.running },
            { labels: { channel, status: 'paused' }, value: s.paused },
          ]),
        }
      );
    } catch (err) {
      log.warn({ err: err.message }, 'could not read queue numbers for /metrics');
    }
  }
  return registry.render(gauges);
}

// ---------------------------------------------------------------- watchdog

async function defaultNotifyOps(problem) {
  if (!config.opsAlertEmails.length) return;
  for (const to of config.opsAlertEmails) {
    await sendSystemEmail({
      to,
      subject: `[Reachroute ops] ${problem.key}`,
      text: `${problem.message}\n\nInstance: ${config.instanceId}\nEnvironment: ${config.env}\n\nThis alert is sent once per problem (at most every 30 minutes) even when several instances notice it.`,
    });
  }
}

/** True for the one instance that gets to raise this alert; others see the lock and stay quiet. */
async function claimAlert(key) {
  try {
    await Lock.findOneAndUpdate(
      { _id: `ops-alert:${key}`, expiresAt: { $lte: new Date() } },
      { $set: { owner: config.instanceId, expiresAt: new Date(Date.now() + ALERT_GAP_MS) } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
}

/**
 * Looks for a send engine that has stopped doing its job and tells the operator.
 *  - "<channel>-backlog": messages are due but have waited longer than WATCHDOG_STUCK_MINUTES
 *  - "<channel>-stuck": messages claimed long ago that the reaper has not cleaned up
 * A problem must be seen on two checks in a row before anyone is told, and is reported once until it clears.
 */
export function createWatchdog({ intervalMs = 60_000, notifyOps = defaultNotifyOps } = {}) {
  const streaks = new Map();
  const reported = new Set();
  let timer = null;

  async function findProblems(now) {
    if (mongoose.connection.readyState !== 1) return []; // /ready and database_up already say this
    const limit = config.watchdogStuckMinutes * 60;
    const stats = await collectQueueStats({ now, fresh: true });
    const problems = [];
    for (const [channel, s] of Object.entries(stats)) {
      if (s.oldestDueSeconds > limit) {
        problems.push({
          key: `${channel}-backlog`,
          message: `${channel}: ${s.due} message(s) are due and the oldest has waited ${Math.round(s.oldestDueSeconds / 60)} minutes (limit ${config.watchdogStuckMinutes}). The send engine may be stopped or overloaded.`,
        });
      }
      if (s.stuckSending > 0) {
        problems.push({ key: `${channel}-stuck`, message: `${channel}: ${s.stuckSending} message(s) have been "sending" for far too long and were not cleaned up.` });
      }
    }
    return problems;
  }

  async function runOnce(now = Date.now()) {
    const problems = await findProblems(now);
    const present = new Set(problems.map((p) => p.key));
    for (const key of [...streaks.keys()]) {
      if (present.has(key)) continue;
      streaks.delete(key);
      if (reported.delete(key)) log.info({ key }, 'problem cleared');
    }
    const fired = [];
    for (const problem of problems) {
      const seen = (streaks.get(problem.key) || 0) + 1;
      streaks.set(problem.key, seen);
      if (seen < 2 || reported.has(problem.key)) continue;
      reported.add(problem.key);
      if (!(await claimAlert(problem.key))) continue;
      fired.push(problem);
      log.error({ key: problem.key }, problem.message);
      await notifyOps(problem).catch((err) => log.error({ err: err.message, key: problem.key }, 'could not send the ops alert'));
    }
    return { problems, fired };
  }

  return {
    runOnce,
    start() {
      if (timer || config.watchdogStuckMinutes === 0) return;
      timer = setInterval(() => runOnce().catch((err) => log.error({ err: err.message }, 'watchdog pass failed')), intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
