/**
 * `defaultSelect` is the lean list projection: a space-separated field list a
 * route declares so the list endpoint returns only what its cards render, never
 * the full document (the detail-by-id endpoint is where everything lives). A
 * client `?select=` still overrides it for the rare bespoke need.
 */
const advancedResults =
  (model, populate, searchFields = ['name'], defaultSelect = null) =>
  async (req, res, next) => {
    let query;

    // FAIL CLOSED: req.accessFilter is set only by can(). If it is undefined,
    // this route never declared a permission — serving it would leak every row.
    // This is the safety net for the classic "someone forgot the guard" bug.
    if (!req.accessFilter) {
      return next(
        new Error(
          `advancedResults on ${model.modelName} ran without a permission check — ` +
            `add can('<resource>', 'read') before it in the route chain`
        )
      );
    }

    // Copy req.query
    const reqQuery = { ...req.query };

    // Fields to exclude
    const removeFields = ['select', 'sort', 'page', 'limit', 'search'];

    // Loop over removeFields and delete them from reqQuery
    removeFields.forEach(param => delete reqQuery[param]);

    // Strip Mongo operators supplied by the client. Express' qs parser turns
    // ?role[$ne]=admin into a real { $ne: ... } object, which would otherwise
    // reach find() as an operator. Only the bracket syntax handled below
    // (?age[gte]=20) is allowed to become an operator.
    const stripOperators = obj => {
      for (const key of Object.keys(obj)) {
        if (key.startsWith('$')) {
          delete obj[key];
        } else if (obj[key] && typeof obj[key] === 'object') {
          stripOperators(obj[key]);
        }
      }
    };
    stripOperators(reqQuery);

    // Generic Search Implementation
    if (req.query.search) {
      // Escape regex metacharacters — user input is a literal, not a pattern.
      // Unescaped, "(((" is a syntax error and ".*.*.*" is a ReDoS vector.
      const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = { $regex: escaped, $options: 'i' };

      if (searchFields.length > 1) {
        reqQuery.$or = searchFields.map(field => ({ [field]: searchRegex }));
      } else {
        reqQuery[searchFields[0]] = searchRegex;
      }
    }

    // Create query string
    // Standardize query keys: un-flatten 'field[op]' -> { field: { op: value } }
    Object.keys(reqQuery).forEach(key => {
      const match = key.match(/^(\w+)\[(\w+)\]$/);
      if (match) {
        const field = match[1];
        const operator = match[2];
        if (!reqQuery[field] || typeof reqQuery[field] !== 'object') {
          reqQuery[field] = {};
        }
        reqQuery[field][operator] = reqQuery[key];
        delete reqQuery[key];
      }
    });

    let queryStr = JSON.stringify(reqQuery);

    // Create operators ($gt, $gte, etc)
    // Note: Date strings (e.g., '2025-12-19') are treated as UTC 00:00 by Mongoose/MongoDB.
    queryStr = queryStr.replace(/\b(gt|gte|lt|lte|in)\b/g, match => `$${match}`);

    // Merge the scope filter set by can(). $and rather than spread: the scope
    // fragment can contain the same keys as the user's query (notably _id),
    // and a spread would let the client's value silently win.
    let queryObj = JSON.parse(queryStr);

    if (Object.keys(req.accessFilter).length) {
      queryObj = { $and: [queryObj, req.accessFilter] };
    }

    // Finding resource
    query = model.find(queryObj);

    // Select Fields — an explicit client select wins; otherwise fall back to the
    // route's lean list projection so lists never ship full documents.
    const selectFields = req.query.select ? req.query.select.split(',').join(' ') : defaultSelect;
    if (selectFields) {
      query = query.select(selectFields);
    }

    // Sort
    if (req.query.sort) {
      const sortBy = req.query.sort.split(',').join(' ');
      query = query.sort(sortBy);
    } else {
      query = query.sort('-createdAt');
    }

    // Pagination
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const total = await model.countDocuments(queryObj);

    query = query.skip(startIndex).limit(limit);

    if (populate) {
      query = query.populate(populate);
    }

    // Executing query
    const results = await query;

    // Pagination result
    const pagination = {};

    if (endIndex < total) {
      pagination.next = {
        page: page + 1,
        limit
      };
    }

    if (startIndex > 0) {
      pagination.prev = {
        page: page - 1,
        limit
      };
    }

    res.advancedResults = {
      success: true,
      count: results.length,
      total, // Total documents matching query
      pagination,
      data: results
    };

    next();
  };

export default advancedResults;
