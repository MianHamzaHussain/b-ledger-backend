import './config/env.js'; // fail fast on missing required env, before anything boots

import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import hpp from 'hpp';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import rateLimit from 'express-rate-limit';
import { xss } from 'express-xss-sanitizer';
import swaggerUi from 'swagger-ui-express';

import logger from './utils/logger.js';
import connectDB from './config/db.js';
import swaggerSpec from './config/swagger.js';
import routes from './routes/index.js';
import errorHandler from './middlewares/errorHandler.js';
import ErrorResponse from './utils/errorResponse.js';
import { getAllowedOrigins } from './utils/cors.js';
import { initSocket } from './utils/socket.js';

const dirName = path.dirname(fileURLToPath(import.meta.url));

await connectDB();

const app = express();

// Behind reverse proxies in production, so `req.ip` (used by express-rate-limit)
// reads the real client from X-Forwarded-For instead of the proxy — otherwise
// rate limiting buckets everyone together and Express 5's express-rate-limit
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. The value is the number of proxy
// hops to trust, counted from the server outward:
//   Cloudflare → nginx → node  ⇒  2  (this deploy)
//   nginx only (no Cloudflare)  ⇒  1
// Set via TRUST_PROXY_HOPS so a different topology needs no code change; 0 (its
// default) disables it, which is correct for local dev with no proxy.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 0);

// Express 5's default query parser is "simple" (flat `qty[gte]` keys); Express 4
// used qs. Pin "extended" so nested-bracket queries keep parsing to real objects
// — advancedResults' operator mapping (?qty[gte]=20 → $gte) and the client `$`
// operator stripping both depend on it.
app.set('query parser', 'extended');

const server = http.createServer(app);

initSocket(server);

// Security headers first, so everything below is covered.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use(
  cors({
    origin: getAllowedOrigins(),
    credentials: true,
    optionsSuccessStatus: 200
  })
);

// Swagger is mounted before the sanitizers, which rewrite the request object
// in ways the UI does not expect. Assets come from a CDN because serving them
// from disk does not work on Vercel.
app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customCssUrl: 'https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css',
    customJs: [
      'https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js',
      'https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-standalone-preset.js'
    ]
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser()); // populates req.cookies for the refresh-token flow

// Express 5 leaves `req.body` UNDEFINED on a request with no body (a bodiless
// POST/PUT action like /users/:id/reinvite, /production/:id/close). Normalise it
// to {} once, here, so `protect`'s audit stamping and every controller can read,
// write or delete `req.body.*` without a "Cannot ... properties of undefined"
// 500. Runs before the sanitizers so they operate on a consistent object.
app.use((req, res, next) => {
  if (req.body == null) req.body = {};
  next();
});

app.use(xss());
app.use(hpp());

// Structured request logging in every environment (JSON in prod, pretty in
// dev). Each request gets a child logger on `req.log` with a correlation id;
// 4xx log at warn, 5xx at error, everything else at info. The health probe is
// silenced so uptime pings do not drown the log.
app.use(
  pinoHttp({
    logger,
    customLogLevel(_req, res, err) {
      if (res.statusCode >= 500 || err) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // One concise line per request (morgan-style). The structured req/res are
    // still attached for the JSON logs; only the terminal hides them (logger.js).
    customSuccessMessage: (req, res, responseTime) =>
      `${req.method} ${req.url} ${res.statusCode} (${responseTime}ms)`,
    customErrorMessage: (req, res, err) =>
      `${req.method} ${req.url} ${res.statusCode} - ${err.message}`,
    autoLogging: { ignore: req => req.url === '/api/v1/health' }
  })
);

// Broad backstop. Credential endpoints apply their own far tighter limit.
app.use(
  rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(express.static(path.join(dirName, 'public')));

/** Liveness probe for uptime checks and load balancers. */
app.get('/api/v1/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    uptime: process.uptime(),
    env: process.env.NODE_ENV
  });
});

app.use('/api/v1', routes);

// Unmatched routes become a proper 404 instead of falling through to static.
app.use((req, res, next) => {
  next(new ErrorResponse(`Route not found: ${req.method} ${req.originalUrl}`, 404));
});

app.use(errorHandler);

const PORT = process.env.PORT || 5000;

server.listen(PORT, () =>
  logger.info(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`)
);

process.on('unhandledRejection', err => {
  logger.error({ err }, 'unhandled rejection');
});

export default app;
