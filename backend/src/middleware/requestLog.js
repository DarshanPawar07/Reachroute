import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { registry } from '../utils/metrics.js';

const QUIET_PATHS = new Set(['/health', '/ready', '/metrics']);
const SAFE_ID = /^[\w-]{8,64}$/;

/**
 * The route that handled the request ("/api/lists/:id"), never the real address, so ids and tokens cannot appear in
 * metrics and the number of different values stays small. Built from the address that was asked for, with each part
 * that Express read as a parameter (an id, a token, a key) replaced by the parameter's name. This does not depend on
 * which router prefix Express remembers, which changes while a request travels through nested routers.
 */
export function routeLabel(req) {
  if (!req.route) return 'unmatched';
  const names = new Map();
  for (const [name, value] of Object.entries(req.params || {})) if (typeof value === 'string' && value) names.set(value, name);
  const decode = (part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const path = String(req.originalUrl).split('?')[0];
  const label = path
    .split('/')
    .map((part) => (names.has(decode(part)) ? `:${names.get(decode(part))}` : part))
    .join('/')
    .replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id') // safety net: an id the parameters did not explain
    .replace(/\/$/, '');
  return label || '/';
}

/** The address for the log: no query string, no ids, and never an unsubscribe token or a webhook secret. */
function loggedPath(originalUrl) {
  const path = String(originalUrl).split('?')[0];
  if (path.startsWith('/unsubscribe')) return '/unsubscribe/:token';
  if (path.startsWith('/hooks/email')) return '/hooks/email/:key';
  return path.replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id');
}

/** Gives every request an id (returned in X-Request-Id, so support can find the log line), logs it and counts it when done. */
export function requestLog(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.set('X-Request-Id', req.id);

  // Express forgets which router prefix handled the request once it has finished, so read the route when the response starts.
  let route = 'unmatched';
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    route = routeLabel(req);
    return writeHead.apply(this, args);
  };

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (QUIET_PATHS.has(req.path)) return;
    const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
    const labels = { method: req.method, route, status: `${Math.floor(res.statusCode / 100)}xx` };
    registry.inc('bulkmessenger_http_requests_total', 'Requests handled, by method, route and status class.', labels);
    registry.observe('bulkmessenger_http_request_duration_seconds', 'How long requests took.', { method: labels.method, route: labels.route }, ms / 1000);

    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](
      {
        reqId: req.id,
        method: req.method,
        path: loggedPath(req.originalUrl),
        status: res.statusCode,
        ms,
        userId: req.userId,
      },
      'request'
    );
  });
  next();
}
