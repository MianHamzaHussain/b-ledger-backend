import pino from 'pino';

/**
 * The single application logger. Everything that used `console.*` for a runtime
 * event routes through here so we get levels, timestamps, JSON output for log
 * aggregators, and — most importantly — redaction of anything sensitive.
 *
 * Level precedence: explicit `LOG_LEVEL` wins; otherwise `info` in production,
 * `silent` under test (keeps `npm test` output clean), `debug` in development.
 */
const level =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === 'production'
    ? 'info'
    : process.env.NODE_ENV === 'test' || process.env.npm_lifecycle_event === 'test'
      ? 'silent'
      : 'debug');

// Pretty, colourised lines in development only; production and test stay pure
// JSON (no worker-thread transport), which is what aggregators want anyway.
const transport =
  process.env.NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' }
      }
    : undefined;

const logger = pino({
  level,
  // A bearer token, cookie or password must never reach the logs, even by
  // accident when a whole req/err object is logged.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      '*.password'
    ],
    censor: '[redacted]'
  },
  serializers: { err: pino.stdSerializers.err },
  ...(transport ? { transport } : {})
});

export default logger;
