/**
 * One list of cities for the whole system. Orders and customers store a city as
 * typed, so "Lahore", "lahore " and "LHR" would be three cities in a courier
 * report. Every write goes through `normalizeCity`, and the order form offers
 * this same list (served by GET /system/cities), so the report groups by a name
 * that means one place.
 */
export const PAKISTAN_CITIES = [
  'Abbottabad',
  'Attock',
  'Bahawalpur',
  'Chiniot',
  'Dera Ghazi Khan',
  'Dera Ismail Khan',
  'Faisalabad',
  'Gilgit',
  'Gujranwala',
  'Gujrat',
  'Gwadar',
  'Hyderabad',
  'Islamabad',
  'Jhang',
  'Jhelum',
  'Karachi',
  'Kasur',
  'Khuzdar',
  'Kohat',
  'Lahore',
  'Larkana',
  'Mardan',
  'Mianwali',
  'Mingora (Swat)',
  'Mirpur Khas',
  'Multan',
  'Murree',
  'Muzaffarabad',
  'Nowshera',
  'Okara',
  'Peshawar',
  'Quetta',
  'Rahim Yar Khan',
  'Rawalpindi',
  'Sahiwal',
  'Sargodha',
  'Sheikhupura',
  'Sialkot',
  'Sukkur',
  'Taxila',
  'Turbat',
  'Wah Cantt'
];

/** How people actually write them. Keys are in `keyOf` form (lower-case, no dots). */
const CITY_ALIASES = {
  lhr: 'Lahore',
  lahor: 'Lahore',
  'lahore city': 'Lahore',
  khi: 'Karachi',
  krachi: 'Karachi',
  'karachi city': 'Karachi',
  isb: 'Islamabad',
  isl: 'Islamabad',
  islamabd: 'Islamabad',
  rwp: 'Rawalpindi',
  pindi: 'Rawalpindi',
  'rawal pindi': 'Rawalpindi',
  fsd: 'Faisalabad',
  lyallpur: 'Faisalabad',
  'dg khan': 'Dera Ghazi Khan',
  dgk: 'Dera Ghazi Khan',
  'dera ghazi khan': 'Dera Ghazi Khan',
  'di khan': 'Dera Ismail Khan',
  ryk: 'Rahim Yar Khan',
  'rahimyar khan': 'Rahim Yar Khan',
  hyd: 'Hyderabad',
  pesh: 'Peshawar',
  pwr: 'Peshawar',
  mingora: 'Mingora (Swat)',
  swat: 'Mingora (Swat)',
  wah: 'Wah Cantt',
  'wah cant': 'Wah Cantt',
  shekhupura: 'Sheikhupura',
  sheikhupura: 'Sheikhupura'
};

/** Comparison form: case, dots, stray punctuation and repeated spaces don't matter. */
const keyOf = text =>
  text
    .toLowerCase()
    .replace(/[.,;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const CANONICAL_BY_KEY = new Map(PAKISTAN_CITIES.map(name => [keyOf(name), name]));

const titleCase = text =>
  text
    .split(' ')
    .map(word => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(' ');

/**
 * The canonical city for whatever was typed: a listed city (or a known alias) by
 * its proper name, anything else tidied into Title Case, empty as `undefined`.
 * Also used as a Mongoose setter, so it must accept non-strings without throwing.
 */
export const normalizeCity = raw => {
  if (typeof raw !== 'string') return undefined;
  const key = keyOf(raw);
  if (!key) return undefined;
  return CANONICAL_BY_KEY.get(key) || CITY_ALIASES[key] || titleCase(key);
};

/** True when a stored city is already a listed one (the backfill skips those). */
export const isListedCity = city =>
  typeof city === 'string' && CANONICAL_BY_KEY.get(keyOf(city)) === city;

/**
 * The identity of a place for matching a courier's list: letters and digits only, lower case — so
 * "Islam Kot", "islamkot" and "Islam-Kot" are the same place. Not used to store anything.
 */
export const cityMatchKey = text =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Edit distance between two short keys (insert, delete, change), for "did you mean". */
const distance = (a, b) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
};

/** Up to three of `names` that look like what was typed: contains it, or is within two edits. */
export const nearCities = (names, typed) => {
  const key = cityMatchKey(typed);
  if (key.length < 3) return [];
  return names
    .map(name => ({ name, k: cityMatchKey(name) }))
    .filter(({ k }) => k.includes(key) || key.includes(k) || distance(k, key) <= 2)
    .sort((x, y) => distance(x.k, key) - distance(y.k, key))
    .slice(0, 3)
    .map(({ name }) => name);
};
