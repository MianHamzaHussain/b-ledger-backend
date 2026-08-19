import crypto from 'crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { ACTIONS, SCOPES, RESOURCE_KEYS } from '../utils/permissions.js';

/**
 * A per-user delta on top of the role's grid.
 *
 * This is the escape hatch for "Ali is a Dispatcher but he should also see
 * reports" — without cloning the whole role. Deny always beats grant.
 */
const PermissionOverrideSchema = new mongoose.Schema(
  {
    resource: {
      type: String,
      required: true,
      enum: {
        values: RESOURCE_KEYS,
        message: 'Unknown resource "{VALUE}" — it is not in the permission registry'
      }
    },
    actions: {
      type: [String],
      default: [],
      enum: { values: ACTIONS, message: 'Unknown action "{VALUE}"' }
    },
    effect: {
      type: String,
      enum: ['grant', 'deny'],
      required: [true, 'Override must be either grant or deny']
    },
    scope: {
      type: String,
      enum: SCOPES,
      default: 'own'
    }
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a name'],
      trim: true,
      maxlength: [100, 'Name can not be more than 100 characters']
    },
    email: {
      type: String,
      required: [true, 'Please add an email'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please add a valid email']
    },
    phone: {
      type: String,
      required: [true, 'Please add a phone number'],
      unique: true,
      trim: true
    },
    password: {
      type: String,
      required: [true, 'Please add a password'],
      minlength: 8,
      select: false
    },
    /**
     * Every user has exactly one role, which supplies their baseline grid.
     * A user with no role resolves to zero permissions (default-deny).
     */
    role: {
      type: mongoose.Schema.ObjectId,
      ref: 'Role',
      required: [true, 'Please assign a role']
    },
    permissionOverrides: {
      type: [PermissionOverrideSchema],
      default: []
    },
    /**
     * Which businesses this user works on. Drives `scope: 'own'` — a dispatcher
     * assigned to two businesses sees only those businesses' rows.
     */
    assignedBusinesses: [
      {
        type: mongoose.Schema.ObjectId,
        ref: 'Business'
      }
    ],
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active'
    },
    /**
     * Last successful sign-in (also stamped when an invite/reset link is used,
     * since that logs the user straight in). Its presence is what "verified"
     * means in the UI — you can only sign in with a password you set from the
     * emailed link, so a login proves the address was reachable.
     */
    lastLogin: { type: Date },
    /** Set on invite; cleared once the user chooses their own password. */
    mustChangePassword: {
      type: Boolean,
      default: false,
      select: false
    },
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpire: { type: Date, select: false },
    /**
     * Baked into every JWT and re-checked by `protect`. Bumping it invalidates
     * every token issued before the bump — this is how logout, a password
     * change, and an admin "sign out everywhere" actually revoke sessions, since
     * a stateless JWT can't otherwise be recalled. `select: false` keeps it out
     * of API responses; `protect` re-requests it explicitly.
     */
    tokenVersion: { type: Number, default: 0, select: false },
    /** Web Push endpoints for PWA background notifications. */
    pushSubscriptions: [
      {
        endpoint: { type: String, required: true },
        keys: {
          p256dh: { type: String, required: true },
          auth: { type: String, required: true }
        }
      }
    ],
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

/** Hash password on create and on any change. */
UserSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

UserSchema.methods.getSignedJwtToken = function () {
  // Short-lived ACCESS token — the client refreshes it from the httpOnly refresh
  // cookie (POST /auth/refresh). tokenVersion travels in it so `protect` can
  // reject a stale one after a logout / password change / forced sign-out.
  return jwt.sign({ id: this._id, tokenVersion: this.tokenVersion ?? 0 }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRE || '15m'
  });
};

UserSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

/**
 * Returns the plain token; only its SHA-256 hash is stored. `expiresInMs`
 * defaults to 10 minutes for a password reset — invites pass a longer window
 * (24h) so a new hire has time to act on it.
 */
UserSchema.methods.getResetPasswordToken = function (expiresInMs = 10 * 60 * 1000) {
  const resetToken = crypto.randomBytes(32).toString('hex');

  this.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');

  this.resetPasswordExpire = Date.now() + expiresInMs;

  return resetToken;
};

export default mongoose.model('User', UserSchema);
