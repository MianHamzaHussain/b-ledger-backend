import ErrorResponse from '../utils/errorResponse.js';

/** A Zod failure as the 400 the envelope uses (§4.1): the first message, and the whole list as an array. */
const validationError = zodError => {
  const messages = zodError.issues.map(issue => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const err = new ErrorResponse(messages[0] || 'Invalid request', 400);
  err.message = messages; // a true array — errorHandler forwards it as-is
  return err;
};

/**
 * Zod request-body validation. Runs after `protect`/`can`, before the
 * controller — so a route reads `validate(schema)` between its guard and its
 * handler, and the controller can trust `req.body`.
 *
 * On failure it returns 400 with the multi-field error ARRAY the envelope uses
 * (§4.1), one entry per bad field. On success it replaces `req.body` with the
 * parsed data (unknown keys are stripped, so a client can't smuggle fields past
 * Mongoose), while preserving the audit fields `protect` stamps from the JWT
 * (`createdBy`/`updatedBy`) — those are set on req.body before this runs.
 */
export const validate = schema => (req, res, next) => {
  const result = schema.safeParse(req.body);

  if (!result.success) return next(validationError(result.error));

  const data = result.data;
  if (req.body.createdBy) data.createdBy = req.body.createdBy;
  if (req.body.updatedBy) data.updatedBy = req.body.updatedBy;
  req.body = data;
  next();
};

/**
 * The same for a GET's query string. The parsed values (numbers coerced, defaults filled, unknown keys dropped)
 * replace `req.query`, so a controller reads only what the schema allows. Express 5 gives `req.query` a getter
 * only, hence defineProperty rather than an assignment.
 */
export const validateQuery = schema => (req, res, next) => {
  const result = schema.safeParse(req.query);
  if (!result.success) return next(validationError(result.error));

  Object.defineProperty(req, 'query', {
    value: result.data,
    writable: true,
    configurable: true,
    enumerable: true
  });
  next();
};

export default validate;
