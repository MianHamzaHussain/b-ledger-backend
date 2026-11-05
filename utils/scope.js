/**
 * True when `business` is inside the caller's scope (admins pass). A business outside it must read as "not found",
 * never as forbidden (root CLAUDE.md §6), so every handler that takes a business id asks this first.
 */
export const inScope = (req, business) => {
  const allowed = req.accessFilter?.business?.$in;
  return !allowed || allowed.map(String).includes(String(business));
};
