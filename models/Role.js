import mongoose from 'mongoose';
import { ACTIONS, SCOPES, RESOURCE_KEYS } from '../utils/permissions.js';

/**
 * One row of a role's checkbox grid: a resource plus the ticked actions
 * and the read scope.
 */
const PermissionSchema = new mongoose.Schema(
  {
    resource: {
      type: String,
      required: [true, 'Please provide a resource'],
      enum: {
        values: RESOURCE_KEYS,
        message: 'Unknown resource "{VALUE}" — it is not in the permission registry'
      }
    },
    actions: {
      type: [String],
      default: [],
      enum: {
        values: ACTIONS,
        message: 'Unknown action "{VALUE}"'
      }
    },
    scope: {
      type: String,
      enum: SCOPES,
      default: 'own'
    }
  },
  { _id: false }
);

const RoleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a role name'],
      unique: true,
      trim: true,
      maxlength: [50, 'Role name can not be more than 50 characters']
    },
    description: {
      type: String,
      trim: true,
      maxlength: [200, 'Description can not be more than 200 characters']
    },
    permissions: {
      type: [PermissionSchema],
      default: []
    },
    /**
     * Unconditional allow — bypasses the permission matrix entirely.
     * `can()` short-circuits on this BEFORE reading any checkbox, so an admin
     * can never be locked out by a mis-ticked grid. Only the Admin role has it,
     * and it is not settable through the API.
     */
    fullAccess: {
      type: Boolean,
      default: false
    },
    /**
     * System roles cannot be edited or deleted through the API. Paired with
     * fullAccess on Admin so neither the flag nor the role itself can be
     * removed by an over-confident click.
     */
    isSystem: {
      type: Boolean,
      default: false
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

/** One permission row per resource — prevents contradictory duplicates. */
RoleSchema.pre('validate', function () {
  const seen = new Set();
  for (const perm of this.permissions) {
    if (seen.has(perm.resource)) {
      this.invalidate('permissions', `Duplicate permission entry for resource "${perm.resource}"`);
    }
    seen.add(perm.resource);
  }
});

export default mongoose.model('Role', RoleSchema);
