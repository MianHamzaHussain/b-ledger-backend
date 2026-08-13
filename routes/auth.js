import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  login,
  logout,
  getMe,
  forgotPassword,
  resetPassword,
  updateDetails,
  updatePassword
} from '../controllers/authController.js';
import { protect } from '../middlewares/auth.js';

const router = express.Router();

/**
 * Credential endpoints get their own tight limiter. The global limiter
 * (1000 / 10 min) is far too generous to slow down password guessing.
 */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Log in with email or phone
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               email:    { type: string, example: "admin@b-ledger.pk" }
 *               phone:    { type: string, description: "Alternative to email" }
 *               password: { type: string, format: password }
 *     responses:
 *       200:
 *         description: Authenticated
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               token: "eyJhbGciOiJIUzI1NiIs..."
 *               mustChangePassword: false
 *       401: { description: Invalid credentials or inactive account }
 *       429: { description: Too many attempts }
 */
router.post('/login', credentialLimiter, login);

/**
 * @swagger
 * /auth/me:
 *   get:
 *     summary: Get the logged-in user with role and assigned businesses
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Current user }
 *       401: { description: Not authorized }
 */
router.get('/me', protect, getMe);

/**
 * @swagger
 * /auth/logout:
 *   get:
 *     summary: Log out (client discards the token)
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Logged out }
 */
router.get('/logout', protect, logout);

/**
 * @swagger
 * /auth/updatedetails:
 *   put:
 *     summary: Update own name and phone
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:  { type: string }
 *               phone: { type: string }
 *     responses:
 *       200: { description: Updated }
 *       400: { description: Phone number already in use }
 */
router.put('/updatedetails', protect, updateDetails);

/**
 * @swagger
 * /auth/updatepassword:
 *   put:
 *     summary: Change own password
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string, format: password }
 *               newPassword:     { type: string, format: password, minLength: 8 }
 *     responses:
 *       200: { description: Password changed, new token issued }
 *       401: { description: Current password incorrect }
 */
router.put('/updatepassword', protect, credentialLimiter, updatePassword);

/**
 * @swagger
 * /auth/forgotpassword:
 *   post:
 *     summary: Request a password reset link
 *     tags: [Auth]
 *     description: >
 *       Always returns 200 whether or not the email is registered, so the
 *       endpoint cannot be used to discover which accounts exist.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: Reset link sent if the account exists }
 *       429: { description: Too many attempts }
 */
router.post('/forgotpassword', credentialLimiter, forgotPassword);

/**
 * @swagger
 * /auth/resetpassword/{resettoken}:
 *   put:
 *     summary: Set a new password using a reset or invitation token
 *     tags: [Auth]
 *     parameters:
 *       - { in: path, name: resettoken, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password: { type: string, format: password, minLength: 8 }
 *     responses:
 *       200: { description: Password set, token issued }
 *       400: { description: Invalid or expired token }
 */
router.put('/resetpassword/:resettoken', credentialLimiter, resetPassword);

export default router;
