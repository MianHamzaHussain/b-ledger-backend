import mongoose from 'mongoose';

/**
 * A long-lived refresh token, stored only as a SHA-256 hash (like a password) so
 * a database leak can't be replayed. One row per issued token; rotation deletes
 * the consumed row and inserts a fresh one, so a replayed (already-rotated) token
 * simply isn't found and is rejected. Mongo's TTL index sweeps expired rows.
 */
const RefreshTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

// TTL: MongoDB removes the document once expiresAt passes.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('RefreshToken', RefreshTokenSchema);
