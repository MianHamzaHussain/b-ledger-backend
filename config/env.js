/**
 * Fail fast at boot if a required environment variable is missing — instead of
 * discovering it on the first request. A missing `JWT_SECRET`, for instance,
 * otherwise only surfaces when someone tries to log in. Imported before anything
 * else in server.js so the process refuses to start half-configured.
 *
 * Env is loaded by Node itself (`node --env-file=.env`), so `process.env` is
 * already populated by the time this module evaluates.
 */

/** Without these the app cannot function — refuse to start. */
const REQUIRED = ['MONGODB_URI', 'JWT_SECRET'];

/** Nice to have; we fall back to sensible defaults, so only a note. */
const RECOMMENDED = ['ALLOWED_ORIGINS'];

const isBlank = key => !process.env[key] || !String(process.env[key]).trim();

const missing = REQUIRED.filter(isBlank);
if (missing.length) {
  console.error(`\n✗ Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('  Copy example.env to .env, fill these in, then restart.\n');
  process.exit(1);
}

/**
 * Settings that exist only so a demo or recording can run against a stand-in courier. They must never
 * be live on a real server: the courier's key would be sent to the stand-in address instead of PostEx,
 * and booked parcels would be fake. Refuse to start in production rather than rely on remembering.
 */
const DEMO_ONLY = ['POSTEX_BASE_URL', 'COURIER_SYNC_SECONDS'].filter(key => !isBlank(key));
if (DEMO_ONLY.length && process.env.NODE_ENV === 'production') {
  console.error(`\n✗ ${DEMO_ONLY.join(', ')} must not be set in production (demo-only settings).`);
  console.error('  Remove them from .env and restart.\n');
  process.exit(1);
}
if (!isBlank('POSTEX_BASE_URL')) {
  console.warn(`Demo mode: courier calls go to ${process.env.POSTEX_BASE_URL}, not to PostEx.`);
}

// A wrong courier key is only discovered when someone presses Save key; say so at boot instead.
if (!isBlank('COURIER_SECRET_KEY') && !/^[0-9a-fA-F]{64}$/.test(process.env.COURIER_SECRET_KEY)) {
  console.warn(
    'Note: COURIER_SECRET_KEY is set but not valid (64 characters, 0-9 and a-f only) — courier connections will be refused.'
  );
}

const softMissing = RECOMMENDED.filter(isBlank);
if (softMissing.length) {
  console.warn(`Note: optional env not set (using defaults): ${softMissing.join(', ')}`);
}
