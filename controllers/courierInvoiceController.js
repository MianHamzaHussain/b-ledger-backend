import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { openCourierItems, recordCourierInvoice } from '../utils/courierInvoice.js';
import { resolveMoney } from '../utils/moneyAccounts.js';
import { toPaisa, fromPaisa } from '../utils/money.js';
import { PARTY_TYPES } from '../utils/constants.js';

const rupees = paisa => fromPaisa(paisa);

/** The party must be a courier — invoices and open parcels mean nothing otherwise. */
const assertCourier = party => {
  if (party.type !== PARTY_TYPES.COURIER) {
    throw new ErrorResponse('Only a courier sends invoices', 400);
  }
};

/**
 * @desc   What is still open with a courier: parcels whose COD it hasn't paid,
 *         and parcels whose delivery / return charge it hasn't billed yet.
 * @route  GET /api/v1/parties/:id/courier-items  (journal:read — scoped)
 */
export const getCourierItems = asyncHandler(async (req, res) => {
  const courier = req.resource;
  assertCourier(courier);
  const items = await openCourierItems(courier.business, courier._id);
  res.status(200).json({
    success: true,
    data: {
      defaultMoneyAccount: courier.defaultMoneyAccount ?? null,
      items: items.map(i => ({
        ...i,
        cod: i.cod && {
          cod: rupees(i.cod.codPaisa),
          withholdingTax: rupees(i.cod.whtPaisa),
          salesTax: rupees(i.cod.salesTaxPaisa),
          net: rupees(i.cod.netPaisa)
        }
      }))
    }
  });
});

/**
 * @desc   Record a courier invoice: the CODs it paid, the charges it billed per
 *         parcel, and what actually arrived (which may be nothing — a week where
 *         the courier only deducted charges).
 * @route  POST /api/v1/parties/:id/courier-invoices  (journal:create — scoped)
 */
export const createCourierInvoice = asyncHandler(async (req, res) => {
  const courier = req.resource;
  assertCourier(courier);
  const { invoiceNumber, invoiceDate, account, cod = [], charges = [], memo } = req.body;
  const receivedPaisa = toPaisa(Number(req.body.received) || 0);
  const money =
    receivedPaisa > 0 ? await resolveMoney(courier.business, { account }, req.user) : null;

  const result = await recordCourierInvoice({
    courier,
    invoiceNumber,
    invoiceDate,
    money,
    receivedPaisa,
    codOrderIds: cod,
    charges,
    memo,
    userId: req.user.id
  });

  res.status(201).json({
    success: true,
    data: {
      invoice: result.invoice,
      expected: rupees(result.expectedPaisa),
      received: rupees(result.receivedPaisa),
      difference: rupees(result.differencePaisa),
      codCount: result.codCount,
      chargeCount: result.chargeCount
    }
  });
});
