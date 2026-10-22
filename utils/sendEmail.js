import nodemailer from 'nodemailer';

import logger from './logger.js';

/**
 * SMTP mailer. Works against a real provider AND a local catcher like Mailpit
 * (host `localhost`, port `1025`, no auth) — which is why two things are
 * conditional:
 *
 *   - `secure` is implied by the port: 465 is implicit TLS, everything else
 *     (587 STARTTLS, 1025/25 plaintext) is not. Hard-coding it breaks one setup
 *     or the other.
 *   - `auth` is omitted entirely when no user is configured. Passing
 *     `{ user: '', pass: '' }` makes some servers attempt (and reject) a login;
 *     Mailpit accepts mail with no auth at all.
 */

/**
 * The transport settings for the current environment — separate from sending so
 * they can be tested without a mail server.
 *
 * The mail server's certificate IS checked by default: without that, anyone on the
 * network path could impersonate it and read the SMTP password. A local catcher or a
 * provider with a self-signed certificate can opt out with
 * `SMTP_REJECT_UNAUTHORIZED=false`.
 */
export const transportOptions = (env = process.env) => {
  const port = Number(env.SMTP_PORT) || 587;
  return {
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}),
    tls: { rejectUnauthorized: env.SMTP_REJECT_UNAUTHORIZED !== 'false' }
  };
};

const sendEmail = async options => {
  const transporter = nodemailer.createTransport(transportOptions());

  const message = {
    from: `${process.env.FROM_NAME || 'B Ledger'} <${process.env.FROM_EMAIL || process.env.SMTP_USER || 'no-reply@b-ledger.pk'}>`,
    to: options.email,
    subject: options.subject,
    text: options.message,
    html: options.html
  };

  const info = await transporter.sendMail(message);

  logger.info({ messageId: info.messageId, to: options.email }, 'email sent');
};

export default sendEmail;
