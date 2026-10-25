/**
 * One spelling per phone number, so "0300-1234567", "03001234567" and "+92 300 1234567" are one
 * customer, and a list exported for WhatsApp is correct.
 *
 * A Pakistani mobile becomes `03XXXXXXXXX`. Anything else (a landline, a foreign number, a
 * number someone typed oddly) is kept as plain digits rather than refused — old data is messy,
 * and losing a contact is worse than keeping an unusual one.
 */
const MOBILE = /^03\d{9}$/;

export const normalizePhone = input => {
  if (typeof input !== 'string') return input;
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('0092')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('92') && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (digits.length === 10 && digits.startsWith('3')) digits = `0${digits}`;
  return digits;
};

export const isMobile = phone => MOBILE.test(phone);

/** The number as WhatsApp wants it — country code, no leading 0, no +. */
export const toWhatsApp = phone => (isMobile(phone) ? `92${phone.slice(1)}` : phone);

/** Why a number can not be saved, or null when it can. */
export const phoneProblem = phone => {
  if (!phone) return 'The phone number is missing';
  if (phone.length < 7) return 'The phone number looks too short';
  if (phone.length > 15) return 'The phone number looks too long';
  return null;
};
