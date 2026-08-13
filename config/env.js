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
const RECOMMENDED = ['ALLOWED_ORIGINS', 'JWT_EXPIRE'];

const isBlank = key => !process.env[key] || !String(process.env[key]).trim();

const missing = REQUIRED.filter(isBlank);
if (missing.length) {
  console.error(`\n✗ Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('  Copy example.env to .env, fill these in, then restart.\n');
  process.exit(1);
}

const softMissing = RECOMMENDED.filter(isBlank);
if (softMissing.length) {
  console.warn(`Note: optional env not set (using defaults): ${softMissing.join(', ')}`);
}
