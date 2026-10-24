import { logger } from '../utils/logger.js';

export const notFound = (_req, res) => res.status(404).json({ error: 'Not found' });

/** Maps every kind of failure to a clean JSON response. Nothing internal ever reaches the client. */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const send = (status, error, extra = {}) => res.status(status).json({ error, ...extra });

  // body-parser
  if (err.type === 'entity.too.large') return send(413, 'The request is too large');
  if (err.type === 'entity.parse.failed') return send(400, 'The request body is not valid JSON');
  if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') return send(415, 'Unsupported encoding');

  // multer (file uploads)
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') return send(413, 'That file is too large (the limit is 2 MB)');
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return send(400, 'Upload the contacts file in the "file" field');
    return send(400, 'The upload could not be read');
  }

  // mongoose / MongoDB
  if (err.name === 'CastError') return send(404, 'Not found');
  if (err.name === 'ValidationError') return send(400, Object.values(err.errors || {})[0]?.message || 'Invalid data');
  if (err.code === 11000) return send(409, 'That already exists');
  if (/^Mongo(Network|ServerSelection|NotConnected)/.test(err.name)) {
    logger.error({ err, reqId: req.id }, 'database unavailable');
    return send(503, 'The service is temporarily unavailable. Try again in a moment.');
  }

  // errors we raised on purpose with bad(message, status)
  if (err.status && err.status >= 400 && err.status < 500) return send(err.status, err.message, err.code && typeof err.code === 'string' ? { code: err.code } : {});
  if (err.status === 503) return send(503, err.message);

  logger.error({ err, reqId: req.id, method: req.method, path: req.path, userId: req.userId }, 'unhandled error');
  return send(500, 'Something went wrong', { requestId: req.id });
}
