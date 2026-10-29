import mongoose from 'mongoose';

/**
 * One signed-in device or browser. Created at sign-in, kept across refresh-token rotation, deleted
 * on sign-out (this device), on "sign out other devices", on a password change/reset, or by an
 * admin. The access token carries its id (`sid`), so deleting the row kills that device on its very
 * next request — not when its 15-minute token runs out. Mongo's TTL index sweeps expired rows.
 */
const SessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: 'User', required: true, index: true },
    browser: { type: String, trim: true, maxlength: 40 },
    os: { type: String, trim: true, maxlength: 40 },
    kind: { type: String, enum: ['desktop', 'mobile', 'tablet'], default: 'desktop' },
    /** As the proxy reports it (needs TRUST_PROXY_HOPS in production); shown to the owner only. */
    ip: { type: String, trim: true, maxlength: 64 },
    lastActiveAt: { type: Date, default: Date.now },
    /**
     * Hashes of this device's recent, already-rotated refresh tokens. A rotated token coming back is
     * the mark of a copied cookie — the whole session is then revoked (`detectReuse`).
     */
    previousHashes: { type: [String], select: false },
    /** A session adopted from a refresh cookie issued before sessions existed. */
    isLegacy: { type: Boolean, default: undefined },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Finds the device a replayed (already-rotated) refresh token belonged to.
SessionSchema.index({ previousHashes: 1 }, { sparse: true });

export default mongoose.model('Session', SessionSchema);
