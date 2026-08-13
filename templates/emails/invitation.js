import { wrapEmail } from './layout.js';

const APP_NAME = process.env.APP_NAME || 'B Ledger';

/**
 * Invitation email. Carries a single-use link, never a password — a credential
 * emailed in plaintext lives forever in the recipient's inbox.
 */
export const getInvitationEmail = (name, inviteUrl) => {
  const content = `
        <h2 style="text-align: center; margin-bottom: 24px;">Welcome to ${APP_NAME}</h2>
        <p>Hello <strong>${name}</strong>,</p>
        <p>An account has been created for you on the <strong>${APP_NAME}</strong> portal.</p>

        <p>Use the button below to choose your password and activate your account.</p>

        <div style="text-align: center;">
            <a href="${inviteUrl}" class="btn">Set Your Password</a>
        </div>

        <p style="font-size: 0.9em; color: #94a3b8; margin-top: 24px;">
            This link can only be used once and expires in 24 hours. If it has
            expired, ask an administrator to resend your invitation.
        </p>

        <p style="font-size: 0.9em; color: #94a3b8; margin-top: 30px; text-align: center;">
            If you did not expect this invitation, please ignore this email.
        </p>
    `;
  return wrapEmail(content, `Welcome to ${APP_NAME}`);
};
