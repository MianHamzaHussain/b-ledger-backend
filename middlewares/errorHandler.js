import ErrorResponse from '../utils/errorResponse.js';
import logger from '../utils/logger.js';

/**
 * Terminal error middleware. Translates Mongoose failures into clean 4xx
 * responses and guarantees the { success:false, error } envelope.
 */
const errorHandler = (err, req, res, next) => {
  let error = err;

  // Bad ObjectId
  if (err.name === 'CastError') {
    error = new ErrorResponse(`Resource not found with id of ${err.value}`, 404);
  }

  // Duplicate key — name the offending field rather than a generic message.
  if (err.code === 11000) {
    const keys = Object.keys(err.keyValue || {});
    // Compound indexes (e.g. { category, name }) list the scope field first;
    // `name` is what the user actually collided on, so prefer it when present.
    const field = keys.includes('name') ? 'name' : keys[0];
    error = new ErrorResponse(
      field ? `A record with that ${field} already exists` : 'Duplicate field value entered',
      400
    );
  }

  // Schema validation — surface every message, not just the first.
  if (err.name === 'ValidationError') {
    error = new ErrorResponse(
      Object.values(err.errors).map(e => e.message),
      400
    );
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    error = new ErrorResponse('Not authorized to access this route', 401);
  }

  const statusCode = error.statusCode || 500;

  // A 500 is a bug, not a user mistake — log the stack (with the request's
  // correlation id, via req.log when pino-http attached it) so it is
  // diagnosable. 4xx responses are expected traffic and stay quiet.
  if (statusCode >= 500) {
    (req.log || logger).error({ err }, `${req.method} ${req.originalUrl} failed`);
  }

  res.status(statusCode).json({
    success: false,
    error: error.message || 'Server Error'
  });
};

export default errorHandler;
