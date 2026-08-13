import { wrapEmail } from './layout.js';

const getPasswordResetEmail = (name, resetUrl) => {
  const content = `
        <div style="text-align: center; margin-bottom: 24px;">
            <p>Hello <strong>${name}</strong>,</p>
            <p>You have requested to reset your password.</p>
        </div>

        <div style="text-align: center; margin: 32px 0;">
            <a href="${resetUrl}" class="btn">Reset Password</a>
        </div>

        <p style="text-align: center; color: #94a3b8; font-size: 0.9em;">If you did not request this, please ignore this email.</p>
    `;
  return wrapEmail(content, 'Password Reset Request');
};

export default getPasswordResetEmail;
