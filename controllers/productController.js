import Product from '../models/Product.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import { createCrudHandlers } from '../utils/crudController.js';

/**
 * Products — CRUD, with a custom update.
 *
 * Reads are scoped by business (a user with `products` scope 'own' sees only
 * their assigned businesses' stock), enforced by `can()` + `loadScoped` in the
 * route chain. Writes into an unassigned business are blocked by
 * `restrictBusinessToScope` on the routes.
 *
 * Article number generation, per-SKU barcode generation and variant validation
 * live in the model's hooks. Category is derived from the business, so the
 * client can't set it (`protectedFields`).
 *
 * @route  GET    /api/v1/products      (products:read — scoped)
 * @route  GET    /api/v1/products/:id  (products:read — scoped)
 * @route  POST   /api/v1/products      (products:create)
 * @route  PUT    /api/v1/products/:id  (products:update — scoped)
 * @route  DELETE /api/v1/products/:id  (products:delete — scoped)
 */
const handlers = createCrudHandlers({
  model: Product,
  protectedFields: ['category'],
  populate: [{ path: 'category', select: 'name status' }]
});

export const {
  getAll: getProducts,
  getOne: getProduct,
  create: createProduct,
  remove: deleteProduct
} = handlers;

/**
 * @desc   Update a product. The form owns the name, threshold and each variant's
 *         LABEL and SALE PRICE only — a variant's cost and stock belong to
 *         Production (moving-averaged on batch close) and to the order flow
 *         (reserved/restored), so existing variants keep those untouched. New
 *         variants start at cost 0 / stock 0 until their first batch.
 * @route  PUT /api/v1/products/:id  (products:update — scoped)
 */
export const updateProduct = asyncHandler(async (req, res) => {
  const product = req.resource;
  const { name, lowStockThreshold, status, variants } = req.body;

  if (name != null) product.name = name;
  if (lowStockThreshold != null) product.lowStockThreshold = lowStockThreshold;
  if (status != null) product.status = status;

  if (Array.isArray(variants)) {
    const byId = new Map(product.variants.map(v => [String(v._id), v]));
    product.variants = variants.map(incoming => {
      const existing = incoming._id ? byId.get(String(incoming._id)) : null;
      if (existing) {
        return {
          _id: existing._id,
          label: incoming.label ?? existing.label,
          salePrice: incoming.salePrice != null ? incoming.salePrice : existing.salePrice,
          // Preserved from the DB — never taken from the form.
          costPrice: existing.costPrice,
          stock: existing.stock,
          barcode: existing.barcode
        };
      }
      return { label: incoming.label, salePrice: incoming.salePrice, costPrice: 0, stock: 0 };
    });
  }

  product.updatedBy = req.user.id;
  await product.save();
  res.status(200).json({ success: true, data: await product.populate('category', 'name status') });
});
