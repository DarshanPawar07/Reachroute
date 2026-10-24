import mongoose from 'mongoose';

/** Error that the error handler turns into a JSON response with this status. */
export const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/** Express param middleware: `router.param('id', validId)` makes malformed ids a clean 404. */
export const validId = (req, _res, next, value) => {
  if (!mongoose.isValidObjectId(value)) return next(bad('Not found', 404));
  next();
};
