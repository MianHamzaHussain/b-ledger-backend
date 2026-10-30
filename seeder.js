import mongoose from 'mongoose';
import connectDB from './config/db.js';
import Role from './models/Role.js';
import User from './models/User.js';
import { ADMIN_ROLE_NAME } from './utils/constants.js';

/**
 * Seeds the protected Admin role and the first admin user.
 *
 * The Admin role carries fullAccess, which bypasses the permission matrix
 * entirely — it deliberately has no permission rows, so it cannot be broken by
 * editing checkboxes.
 *
 * Credentials come from the environment; there is no hardcoded default
 * password, because seeded defaults are the single most common way a system
 * ships with a known admin login.
 */
const importData = async () => {
  const { SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_PHONE, SEED_ADMIN_NAME } = process.env;

  if (!SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD || !SEED_ADMIN_PHONE) {
    console.error(
      'Missing seed configuration. Set SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD and\n' +
        'SEED_ADMIN_PHONE in .env before running the seeder.'
    );
    process.exit(1);
  }

  if (SEED_ADMIN_PASSWORD.length < 8) {
    console.error('SEED_ADMIN_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  let adminRole = await Role.findOne({ name: ADMIN_ROLE_NAME });

  if (!adminRole) {
    adminRole = await Role.create({
      name: ADMIN_ROLE_NAME,
      description: 'Unrestricted access to everything. Cannot be edited or deleted.',
      fullAccess: true,
      isSystem: true,
      permissions: []
    });
    console.log(`Created role: ${ADMIN_ROLE_NAME}`);
  } else {
    console.log(`Role already present: ${ADMIN_ROLE_NAME}`);
  }

  const existingAdmin = await User.findOne({ email: SEED_ADMIN_EMAIL.toLowerCase() });

  if (existingAdmin) {
    console.log(`Admin user already exists: ${existingAdmin.email} — nothing to do.`);
  } else {
    const admin = await User.create({
      name: SEED_ADMIN_NAME || 'Administrator',
      email: SEED_ADMIN_EMAIL,
      phone: SEED_ADMIN_PHONE,
      password: SEED_ADMIN_PASSWORD,
      role: adminRole._id,
      status: 'active'
    });
    console.log(`Created admin user: ${admin.email}`);
  }

  console.log('Seed complete.');
};

const run = async () => {
  await connectDB();

  try {
    if (process.argv[2] === '-i') {
      await importData();
    } else {
      console.log('Usage: npm run seed');
    }
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    await mongoose.disconnect();
    process.exit(1);
  }
};

run();
