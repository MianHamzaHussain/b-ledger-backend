import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from './errorResponse.js';

/**
 * Builds the five standard CRUD handlers for a resource.
 *
 * Extracted once roles, businesses and categories all needed the same five
 * near-identical handlers — the "second real duplication" threshold in
 * CLAUDE.md §5.3. It is deliberately small: hooks cover the differences that
 * actually occur, and anything more unusual should just be a hand-written
 * controller rather than another option on this factory.
 *
 * Assumes the route chain already ran:
 *   can(...)          → sets req.accessFilter
 *   advancedResults   → sets res.advancedResults   (list)
 *   loadScoped(Model) → sets req.resource          (single / update / delete)
 *
 * @param {object}   options
 * @param {mongoose.Model} options.model
 * @param {string[]} [options.protectedFields] Stripped from the request body on
 *        create and update — for flags only the server may set.
 * @param {Function} [options.beforeDelete] async (doc, req) => ErrorResponse|null
 * @param {string}   [options.populate] Populate path applied to create/update
 *        responses so the client gets the same shape the list endpoint returns.
 */
export const createCrudHandlers = ({ model, protectedFields = [], beforeDelete, populate }) => {
  const strip = body => {
    for (const field of protectedFields) delete body[field];
    return body;
  };

  const withPopulate = doc => (populate ? doc.populate(populate) : doc);

  return {
    /** GET / — list. advancedResults already built the envelope. */
    getAll: asyncHandler(async (req, res) => {
      res.status(200).json(res.advancedResults);
    }),

    /** GET /:id — loadScoped already fetched and scope-checked the document. */
    getOne: asyncHandler(async (req, res) => {
      res.status(200).json({ success: true, data: await withPopulate(req.resource) });
    }),

    /** POST / — createdBy is stamped by `protect`, never read from the body. */
    create: asyncHandler(async (req, res) => {
      const doc = await model.create(strip(req.body));
      res.status(201).json({ success: true, data: await withPopulate(doc) });
    }),

    /**
     * PUT /:id — assign-then-save rather than findByIdAndUpdate, so schema
     * validators and pre-save hooks run against the full document.
     */
    update: asyncHandler(async (req, res) => {
      Object.assign(req.resource, strip(req.body));
      await req.resource.save();
      res.status(200).json({ success: true, data: await withPopulate(req.resource) });
    }),

    /** DELETE /:id */
    remove: asyncHandler(async (req, res, next) => {
      if (beforeDelete) {
        const blocked = await beforeDelete(req.resource, req);
        if (blocked) return next(blocked);
      }

      await req.resource.deleteOne();
      res.status(200).json({ success: true, data: {} });
    })
  };
};

/**
 * Guard that refuses to delete a document other records still point at.
 *
 * Deleting reference data out from under its dependants is how you end up with
 * businesses whose category will not populate and reports that quietly
 * undercount. Blocking is louder and cheaper than cascading.
 *
 *   beforeDelete: blockIfReferencedBy(Business, 'category', 'business')
 *
 * @param {mongoose.Model} refModel Model that holds the reference
 * @param {string} field            Field on refModel pointing back at this doc
 * @param {string} label            Singular noun used in the error message
 */
/** Minimal English pluralizer — enough for resource labels. */
const pluralize = word => {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`; // subcategory → subcategories
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`; // business → businesses
  return `${word}s`;
};

export const blockIfReferencedBy = (refModel, field, label) => async doc => {
  const count = await refModel.countDocuments({ [field]: doc._id });

  if (count > 0) {
    const noun = count === 1 ? label : pluralize(label);
    const verb = count === 1 ? 'uses' : 'use';
    const pronoun = count === 1 ? 'it' : 'them';
    return new ErrorResponse(
      `Cannot delete — ${count} ${noun} still ${verb} this. Reassign ${pronoun} first.`,
      400
    );
  }

  return null;
};

/**
 * Composes several `blockIfReferencedBy` guards into one `beforeDelete`.
 *
 * When a doc is referenced from more than one model, its delete must check each
 * one. Runs them in order and returns the first block hit — the user fixes one
 * dependency, retries, and sees the next, which is clearer than a merged
 * multi-part message.
 *
 *   beforeDelete: blockIfAnyReference([
 *     blockIfReferencedBy(Business, 'category', 'business'),
 *     blockIfReferencedBy(Product, 'category', 'product'),
 *   ])
 *
 * @param {Array<Function>} guards `beforeDelete`-shaped functions
 */
export const blockIfAnyReference = guards => async (doc, req) => {
  for (const guard of guards) {
    const blocked = await guard(doc, req);
    if (blocked) return blocked;
  }
  return null;
};
