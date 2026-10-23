import { z } from 'zod';

const id = z.string().min(1, 'Required');
const note = z.string().trim().max(200, 'Note can not be more than 200 characters').optional();
const date = z.union([z.string(), z.date()]).optional();
const pieces = z.coerce.number().int('Whole pieces only').min(1, 'Enter at least 1 piece');
/** What the supplier billed per piece, in rupees. 0 is allowed (a free sample) — the form warns. */
const unitCost = z.coerce.number().min(0, 'Cost can not be negative');

/** A size of an article we already stock. */
const existingLine = z.object({
  product: id,
  variantId: id,
  quantity: pieces,
  unitCost
});

/** An article this delivery creates — its sizes, prices and what arrived. */
const newArticleLine = z.object({
  newProduct: z.object({
    name: z
      .string()
      .trim()
      .min(1, 'Name the article')
      .max(120, 'Keep the name under 120 characters'),
    variants: z
      .array(
        z.object({
          label: z
            .string()
            .trim()
            .min(1, 'Name the size')
            .max(40, 'Keep the size under 40 characters'),
          salePrice: z.coerce.number().min(0, 'Price can not be negative'),
          quantity: pieces,
          unitCost
        })
      )
      .min(1, 'Add at least one size')
  })
});

export const goodsReceiptCreateSchema = z.object({
  business: id,
  party: id,
  date,
  note,
  lines: z.array(z.union([existingLine, newArticleLine])).min(1, 'Add at least one line'),
  /** Paid on the spot, in rupees. Blank or 0 = pay later. */
  paidNow: z.coerce.number().min(0, 'Can not be negative').optional(),
  /** A money account id, or `partner:<id>` — wins over `method`. */
  account: z.string().min(1).optional(),
  method: z.enum(['cash', 'bank']).optional()
});

/** An empty note is allowed here: it clears the note. */
export const goodsReceiptNoteSchema = z.object({
  note: z.string().trim().max(200, 'Note can not be more than 200 characters')
});

export const goodsReceiptReturnSchema = z.object({
  lines: z
    .array(z.object({ lineId: id, quantity: pieces }))
    .min(1, 'Choose what to send back')
    .refine(
      lines => new Set(lines.map(l => l.lineId)).size === lines.length,
      'Each line can only be listed once'
    ),
  date,
  note
});
