import express from 'express';

import authRoutes from './auth.js';
import userRoutes from './users.js';
import roleRoutes from './roles.js';
import categoryRoutes from './categories.js';
import productRoutes from './products.js';
import orderRoutes from './orders.js';
import customerRoutes from './customers.js';
import businessRoutes from './businesses.js';
import partyRoutes from './parties.js';
import financeRoutes from './finance.js';
import productionRoutes from './production.js';
import consignmentRoutes from './consignments.js';
import partnerRoutes from './partners.js';
import notificationRoutes from './notifications.js';
import pushRoutes from './push.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/categories', categoryRoutes);
router.use('/products', productRoutes);
router.use('/orders', orderRoutes);
router.use('/customers', customerRoutes);
router.use('/businesses', businessRoutes);
router.use('/parties', partyRoutes);
router.use('/finance', financeRoutes);
router.use('/production', productionRoutes);
router.use('/consignments', consignmentRoutes);
router.use('/partners', partnerRoutes);
router.use('/notifications', notificationRoutes);
router.use('/push', pushRoutes);

export default router;
