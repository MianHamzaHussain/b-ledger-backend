import Role from '../models/Role.js';

/** Ids of the roles that see and may do everything (Admin). One query; the Role collection is tiny. */
export const fullAccessRoleIds = async () => {
  const roles = await Role.find({ fullAccess: true }).select('_id');
  return roles.map(r => r._id);
};
