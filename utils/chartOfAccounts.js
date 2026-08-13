import Account from '../models/Account.js';
import { ACCOUNT_TYPES } from './constants.js';
import ErrorResponse from './errorResponse.js';

const { ASSET, LIABILITY, EQUITY, INCOME, EXPENSE } = ACCOUNT_TYPES;

/**
 * Semantic handles for the accounts the posting engine reaches for by name, so
 * controllers say `CODES.SALES` instead of a bare '4000'. Numbering follows the
 * usual convention: 1000s assets, 2000s liabilities, 3000s equity, 4000s income,
 * 5000s expenses.
 */
export const CODES = {
  CASH: '1000',
  BANK: '1010',
  ACCOUNTS_RECEIVABLE: '1200',
  COD_RECEIVABLE: '1210',
  WHT_RECEIVABLE: '1220',
  INVENTORY: '1300',
  WIP: '1310',
  GOODS_ON_APPROVAL: '1320',
  // Fixed assets — things bought to keep and use, not resell. Accumulated
  // depreciation is a contra-asset (netted against the asset's cost).
  FIXED_ASSETS: '1400',
  ACCUMULATED_DEPRECIATION: '1450',
  ACCOUNTS_PAYABLE: '2000',
  SALARIES_PAYABLE: '2100',
  // Money borrowed (bank or a person) — a liability until repaid.
  LOAN_PAYABLE: '2200',
  OWNERS_CAPITAL: '3000',
  DRAWINGS: '3100',
  RETAINED_EARNINGS: '3900',
  SALES: '4000',
  COGS: '5000',
  RAW_MATERIAL: '5100',
  TAILORING: '5110',
  PACKING: '5120',
  DELIVERY_CHARGES: '5200',
  RETURN_CHARGES: '5210',
  WITHHOLDING_TAX: '5220',
  SALES_TAX: '5230',
  DEPRECIATION: '5240',
  INTEREST_EXPENSE: '5250',
  SALARIES: '5300',
  RENT: '5400',
  UTILITIES: '5410',
  MISC_EXPENSE: '5900'
};

/** The standard chart every business is seeded with. `control` = detail by party. */
export const DEFAULT_CHART = [
  { code: CODES.CASH, name: 'Cash', type: ASSET },
  { code: CODES.BANK, name: 'Bank', type: ASSET },
  { code: CODES.ACCOUNTS_RECEIVABLE, name: 'Accounts Receivable', type: ASSET, control: true },
  { code: CODES.COD_RECEIVABLE, name: 'COD Receivable — Courier', type: ASSET, control: true },
  { code: CODES.WHT_RECEIVABLE, name: 'Advance Tax (WHT Receivable)', type: ASSET },
  { code: CODES.INVENTORY, name: 'Inventory — Finished', type: ASSET },
  { code: CODES.WIP, name: 'Work in Progress', type: ASSET },
  { code: CODES.GOODS_ON_APPROVAL, name: 'Goods on Approval', type: ASSET, control: true },
  { code: CODES.FIXED_ASSETS, name: 'Fixed Assets', type: ASSET },
  { code: CODES.ACCUMULATED_DEPRECIATION, name: 'Accumulated Depreciation', type: ASSET },
  { code: CODES.ACCOUNTS_PAYABLE, name: 'Accounts Payable', type: LIABILITY, control: true },
  { code: CODES.SALARIES_PAYABLE, name: 'Salaries Payable', type: LIABILITY },
  { code: CODES.LOAN_PAYABLE, name: 'Loan Payable', type: LIABILITY },
  { code: CODES.OWNERS_CAPITAL, name: "Owner's Capital", type: EQUITY },
  { code: CODES.DRAWINGS, name: 'Drawings', type: EQUITY },
  { code: CODES.RETAINED_EARNINGS, name: 'Retained Earnings', type: EQUITY },
  { code: CODES.SALES, name: 'Sales', type: INCOME },
  { code: CODES.COGS, name: 'Cost of Goods Sold', type: EXPENSE },
  { code: CODES.RAW_MATERIAL, name: 'Raw Material', type: EXPENSE },
  { code: CODES.TAILORING, name: 'Tailoring', type: EXPENSE },
  { code: CODES.PACKING, name: 'Packing', type: EXPENSE },
  { code: CODES.DELIVERY_CHARGES, name: 'Delivery Charges', type: EXPENSE },
  { code: CODES.RETURN_CHARGES, name: 'Return Charges', type: EXPENSE },
  { code: CODES.WITHHOLDING_TAX, name: 'Withholding Tax (COD)', type: EXPENSE },
  { code: CODES.SALES_TAX, name: 'Sales Tax (COD)', type: EXPENSE },
  { code: CODES.DEPRECIATION, name: 'Depreciation', type: EXPENSE },
  { code: CODES.INTEREST_EXPENSE, name: 'Interest Expense', type: EXPENSE },
  { code: CODES.SALARIES, name: 'Salaries', type: EXPENSE },
  { code: CODES.RENT, name: 'Rent', type: EXPENSE },
  { code: CODES.UTILITIES, name: 'Utilities', type: EXPENSE },
  { code: CODES.MISC_EXPENSE, name: 'Miscellaneous', type: EXPENSE }
];

/**
 * Ensure a business has its chart. Idempotent: inserts only the accounts it is
 * missing, so it both seeds a new business and backfills one created before the
 * accounting module existed. Called at the start of any finance operation.
 */
export const ensureChart = async businessId => {
  const existing = await Account.find({ business: businessId }).select('code').lean();
  const have = new Set(existing.map(a => a.code));

  const missing = DEFAULT_CHART.filter(a => !have.has(a.code)).map(a => ({
    business: businessId,
    code: a.code,
    name: a.name,
    type: a.type,
    isControl: Boolean(a.control),
    isSystem: true
  }));

  if (missing.length) await Account.insertMany(missing);
};

/** Resolve one account for a business by its code, seeding the chart if needed. */
export const accountByCode = async (businessId, code) => {
  let account = await Account.findOne({ business: businessId, code });
  if (!account) {
    await ensureChart(businessId);
    account = await Account.findOne({ business: businessId, code });
  }
  if (!account) throw new ErrorResponse(`Account ${code} is not set up for this business`, 500);
  return account;
};
