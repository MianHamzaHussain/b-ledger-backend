import mongoose from 'mongoose';

import logger from '../utils/logger.js';

/**
 * Cache the connection across invocations. On a warm serverless container the
 * module stays loaded between requests, so memoising the connect promise avoids
 * opening a fresh pool every time (and the "buffering timed out" errors that
 * come from racing multiple connects). Locally it's a harmless singleton.
 */
const cache = (globalThis.__mongoose ??= { conn: null, promise: null });

const connectDB = async () => {
  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(process.env.MONGODB_URI, {
        // Bounded pool so a burst of requests can't exhaust connections.
        maxPoolSize: 10,
        // Fail fast when the DB is unreachable rather than hanging ~30s.
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000
      })
      .then(m => {
        logger.info(`MongoDB Connected: ${m.connection.host}`);
        return m;
      });
  }

  try {
    cache.conn = await cache.promise;
  } catch (err) {
    // Reset so the next call can retry instead of reusing a rejected promise.
    cache.promise = null;
    throw err;
  }

  return cache.conn;
};

export default connectDB;
