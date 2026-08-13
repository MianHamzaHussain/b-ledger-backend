/**
 * Single source of allowed origins, shared by the Express CORS middleware and
 * the Socket.io handshake. Previously duplicated in both, which meant adding a
 * frontend URL fixed HTTP but silently broke websockets.
 */
export const getAllowedOrigins = () => {
  const fromEnv = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(url => url.trim())
    : [];

  return [...fromEnv, process.env.FRONTEND_URL, 'http://localhost:3000'].filter(Boolean);
};
