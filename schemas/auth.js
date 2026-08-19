import { z } from 'zod';

// Login accepts either an email or a phone as the identifier, plus a password.
export const loginSchema = z
  .object({
    email: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    password: z.string().min(1, 'Password is required')
  })
  .refine(d => Boolean(d.email || d.phone), {
    message: 'Please provide an email or phone',
    path: ['email']
  });

export const forgotPasswordSchema = z.object({
  email: z.string().trim().min(1, 'Email is required')
});

// Mirrors the model's 8-char minimum (§8 — client and server enforce the same).
export const resetPasswordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters')
});

// Self-service profile edit — only name/phone are user-editable (the controller
// whitelists these anyway; the schema makes the surface explicit).
export const updateDetailsSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').optional(),
  phone: z.string().trim().min(1, 'Phone is required').optional()
});

export const updatePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters')
});
