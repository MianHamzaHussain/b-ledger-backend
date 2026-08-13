/**
 * Money is stored in the ledger as an integer number of **paisa** (1 rupee =
 * 100 paisa), never as a floating-point rupee amount.
 *
 * Floating point can't represent most decimals exactly, so summing thousands of
 * rupee amounts eventually drifts by a fraction — and in a double-entry ledger a
 * fraction is enough to break the "debits equal credits" invariant. Integers add
 * exactly. Everything inside the accounting module speaks paisa; these helpers
 * convert at the boundary where rupee amounts enter or leave.
 */

/** Rupees (from the API/UI) → integer paisa. Rounds to the nearest paisa. */
export const toPaisa = rupees => Math.round(Number(rupees) * 100);

/** Integer paisa → rupees, for display/response. */
export const fromPaisa = paisa => (Number(paisa) || 0) / 100;

/** True for a clean non-negative integer amount of paisa. */
export const isValidPaisa = value => Number.isInteger(value) && value >= 0;
