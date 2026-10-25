/**
 * One CSV cell, safe to open in Excel or Sheets. Commas, quotes and line breaks are quoted; and
 * a value that starts with = + - @ (or a tab / carriage return) would be run as a formula by a
 * spreadsheet, so it is prefixed with an apostrophe — a customer named =HYPERLINK(...) must stay
 * a name.
 */
export const csvCell = value => {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const csvRow = cells => cells.map(csvCell).join(',');

/** Excel needs this to read UTF-8 (Urdu names) correctly. */
export const CSV_BOM = '﻿';
