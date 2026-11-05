/**
 * Reading a PostEx Cash Payment Receipt (CPR) — the PDF PostEx releases for each payout into the merchant's PostEx
 * wallet. PostEx has no API for it, so the PDF is the only source of what it actually paid and charged, parcel by parcel.
 *
 * The PDF is read by POSITION, not by the order its text comes out in: every parcel is one table row, and each column
 * sits at a fixed place across the page. A receipt is accepted only if it adds up — every row against PostEx's own rule
 * (COD − shipping − GST − 4% = net; a return is −(shipping + GST)), and the rows against the totals printed on the
 * receipt. Anything that does not add up is refused, never half-read: a layout change shows up as a refusal.
 */

/** "13,171.75" → 1317175, "(268.25)" → -26825. Amounts are read as text, so no rounding ever happens. */
export const amountToPaisa = text => {
  const raw = String(text ?? '').trim();
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  const clean = raw.replace(/[(),\s-]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [rupees, paisa = ''] = clean.split('.');
  const value = Number(rupees) * 100 + Number(paisa.padEnd(2, '0'));
  return negative ? -value : value;
};

/** dd/mm/yyyy → yyyy-mm-dd (a Pakistan day), or null. */
const day = text => {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(String(text ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/**
 * Where each column of the parcel table sits (the x of its numbers). Ranges, not points, because numbers are
 * right-aligned and move a little with their width.
 */
const COLUMNS = [
  ['cod', 235, 290],
  ['upfrontAmount', 290, 310],
  ['reserve', 310, 345],
  ['shipping', 345, 390],
  ['upfrontCharges', 395, 430],
  ['gst', 430, 470],
  ['deduction', 480, 535],
  ['net', 535, 600]
];
const columnAt = x => COLUMNS.find(([, from, to]) => x >= from && x < to)?.[0];

const TRACKING = /^\d{10,16}$/;
const near = (a, b, within) => Math.abs(a - b) <= within;

/** The value printed on the same line as a summary label ("Net Total … 12,903.50"), on the right half of page 1. */
const summaryValue = (items, label, { column = 'amount' } = {}) => {
  // The summary's labels start at x≈279–282; the table header has its own "GST" and "Deduction (4%)" further right.
  const tag = items.find(i => i.page === 1 && i.str.trim() === label && i.x > 270 && i.x < 300);
  if (!tag) return null;
  const sameLine = items.filter(i => i.page === 1 && near(i.y, tag.y, 6) && i !== tag);
  if (column === 'count') return sameLine.find(i => i.x >= 370 && i.x < 420)?.str ?? null;
  // The right-most value on the line is the payable / total figure.
  const right = sameLine.filter(i => i.x > 420).sort((a, b) => b.x - a.x)[0];
  return right?.str ?? null;
};

/**
 * Text items `{ page, x, y, str }` → `{ receipt, problems }`. `receipt` is null when anything does not add up;
 * `problems` then says what, in plain words.
 */
export const parsePostexReceipt = items => {
  const problems = [];
  const words = items.filter(i => i.str && i.str.trim());

  const cprNumber = words.find(i => /^CPR-[A-Z0-9]+$/.test(i.str.trim()))?.str.trim();
  const dateTag = words.find(i => i.page === 1 && i.str.trim() === 'CPR Date');
  const cprDate = dateTag
    ? day(words.find(i => i.page === 1 && near(i.y, dateTag.y, 4) && i.x > dateTag.x + 20)?.str)
    : null;
  const merchantTag = words.find(i => i.page === 1 && i.str.trim() === 'Merchant Details');
  const merchant = merchantTag
    ? words
        .filter(
          i =>
            i.page === 1 &&
            i.y < merchantTag.y &&
            i.y > merchantTag.y - 40 &&
            near(i.x, merchantTag.x, 6)
        )
        .sort((a, b) => b.y - a.y)[0]
        ?.str.trim()
    : null;
  if (!cprNumber) problems.push('No CPR number found — is this a PostEx Cash Payment Receipt?');
  if (!cprDate) problems.push('No CPR date found');

  const totals = {
    netPaisa: amountToPaisa(summaryValue(words, 'Net Total')),
    shippingPaisa: amountToPaisa(summaryValue(words, 'Shipping Charges')),
    gstPaisa: amountToPaisa(summaryValue(words, 'GST')),
    deductionPaisa: amountToPaisa(summaryValue(words, 'Deduction (4%)')),
    upfrontChargesPaisa: amountToPaisa(summaryValue(words, 'Upfront Charges')),
    carryForwardPaisa: amountToPaisa(summaryValue(words, 'Carry Forward')),
    miscellaneousPaisa: amountToPaisa(summaryValue(words, 'Miscellaneous')),
    adjustmentPaisa: amountToPaisa(summaryValue(words, 'Adjustment(s)')),
    codPaisa: amountToPaisa(summaryValue(words, 'Total')),
    delivered: Number(summaryValue(words, 'Delivered', { column: 'count' })),
    returned: Number(summaryValue(words, 'Returned', { column: 'count' }))
  };
  for (const [name, value] of Object.entries(totals)) {
    if (value === null || Number.isNaN(value))
      problems.push(`The receipt's "${name}" figure could not be read`);
  }

  // One row per tracking number: everything printed on that row's band of the same page. A number only counts as
  // a parcel when it sits below the table header (page 1) and its band carries a status word — the merchant's own
  // mobile number, printed above the table, looks just like a tracking number.
  const headerY =
    words.find(i => i.page === 1 && i.str.trim() === 'Tracking' && i.x < 90)?.y ?? Infinity;
  const rows = [];
  for (const tag of words.filter(
    i => TRACKING.test(i.str.trim()) && i.x < 90 && (i.page > 1 || i.y < headerY - 5)
  )) {
    const band = words.filter(i => i.page === tag.page && i.y <= tag.y + 2 && i.y >= tag.y - 16);
    if (!band.some(i => /^(Delivered|Return(ed)?)$/i.test(i.str.trim()))) continue;
    const cells = {};
    for (const i of band) {
      const col = columnAt(i.x);
      const paisa = amountToPaisa(i.str);
      if (col && paisa !== null) cells[col] = paisa;
    }
    const statusWord = band.find(i => /^(Delivered|Return(ed)?)$/i.test(i.str.trim()))?.str.trim();
    const dates = band.map(i => i.str).filter(s => /\d{2}\/\d{2}\/\d{4}/.test(s));
    rows.push({
      tracking: tag.str.trim(),
      status: /^deliver/i.test(statusWord ?? '') ? 'delivered' : statusWord ? 'returned' : null,
      orderedOn: day(dates.find(s => !/D\/R/.test(s))),
      doneOn: day(dates.find(s => /D\/R/.test(s))),
      codPaisa: cells.cod ?? null,
      shippingPaisa: cells.shipping ?? null,
      upfrontChargesPaisa: cells.upfrontCharges ?? 0,
      gstPaisa: cells.gst ?? null,
      deductionPaisa: cells.deduction ?? null,
      netPaisa: cells.net ?? null
    });
  }
  if (!rows.length) problems.push('No parcels were found on the receipt');

  // Every row against PostEx's own rule.
  for (const r of rows) {
    const missing = [
      'status',
      'codPaisa',
      'shippingPaisa',
      'gstPaisa',
      'deductionPaisa',
      'netPaisa'
    ].filter(k => r[k] === null);
    if (missing.length) {
      problems.push(`Parcel ${r.tracking}: could not read ${missing.join(', ')}`);
      continue;
    }
    const charges = r.shippingPaisa + r.gstPaisa + r.upfrontChargesPaisa;
    const expected = r.status === 'delivered' ? r.codPaisa - charges - r.deductionPaisa : -charges;
    if (expected !== r.netPaisa) {
      problems.push(
        `Parcel ${r.tracking}: its net ${r.netPaisa / 100} does not equal its own figures (${expected / 100})`
      );
    }
  }

  // The rows against the totals printed on the receipt.
  const sum = key => rows.reduce((s, r) => s + (r[key] ?? 0), 0);
  const check = (label, rowsTotal, printed) => {
    if (printed !== null && Math.abs(rowsTotal) !== Math.abs(printed)) {
      problems.push(
        `${label}: the parcels add up to ${rowsTotal / 100}, the receipt says ${Math.abs(printed) / 100}`
      );
    }
  };
  check('Net total', sum('netPaisa'), totals.netPaisa);
  check('Shipping charges', sum('shippingPaisa'), totals.shippingPaisa);
  check('GST', sum('gstPaisa'), totals.gstPaisa);
  check('Deduction (4%)', sum('deductionPaisa'), totals.deductionPaisa);
  const delivered = rows.filter(r => r.status === 'delivered').length;
  const returned = rows.filter(r => r.status === 'returned').length;
  if (delivered !== totals.delivered || returned !== totals.returned) {
    problems.push(
      `Parcel count: found ${delivered} delivered and ${returned} returned, the receipt says ${totals.delivered} and ${totals.returned}`
    );
  }
  if (new Set(rows.map(r => r.tracking)).size !== rows.length)
    problems.push('A tracking number appears twice');

  // Lines this import does not handle yet are refused rather than guessed at.
  for (const [key, label] of [
    ['carryForwardPaisa', 'Carry forward'],
    ['miscellaneousPaisa', 'Miscellaneous'],
    ['adjustmentPaisa', 'Adjustment(s)'],
    ['upfrontChargesPaisa', 'Upfront charges']
  ]) {
    if (totals[key])
      problems.push(
        `${label} is not zero on this receipt — this kind of receipt can not be imported yet`
      );
  }

  if (problems.length) return { receipt: null, problems };
  return {
    receipt: {
      cprNumber,
      cprDate,
      merchant: merchant ?? null,
      totals: {
        netPaisa: totals.netPaisa,
        codPaisa: totals.codPaisa,
        shippingPaisa: Math.abs(totals.shippingPaisa),
        gstPaisa: Math.abs(totals.gstPaisa),
        deductionPaisa: Math.abs(totals.deductionPaisa),
        delivered,
        returned
      },
      rows
    },
    problems: []
  };
};

/** A PDF (bytes) → its text items with their page and position. */
export const pdfTextItems = async bytes => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0
  }).promise;
  const pages = await Promise.all(
    Array.from({ length: doc.numPages }, async (_, index) => {
      const { items: found } = await (await doc.getPage(index + 1)).getTextContent();
      return found
        .filter(i => i.str?.trim())
        .map(i => ({ page: index + 1, x: i.transform[4], y: i.transform[5], str: i.str }));
    })
  );
  await doc.destroy();
  return pages.flat();
};

/** A PostEx receipt PDF → `{ receipt, problems }`. An unreadable file is a problem, not a crash. */
export const readPostexReceipt = async bytes => {
  try {
    return parsePostexReceipt(await pdfTextItems(bytes));
  } catch {
    return { receipt: null, problems: ['This file could not be read as a PDF'] };
  }
};
