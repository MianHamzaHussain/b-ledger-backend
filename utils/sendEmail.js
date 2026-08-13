import nodemailer from 'nodemailer';

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
const sendEmail = async options => {
  const port = Number(process.env.SMTP_PORT) || 587;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    ...(process.env.SMTP_USER
      ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }
      : {}),
    tls: {
      rejectUnauthorized: false
    }
  });

  const message = {
    from: `${process.env.FROM_NAME || 'B Ledger'} <${process.env.FROM_EMAIL || process.env.SMTP_USER || 'no-reply@b-ledger.pk'}>`,
    to: options.email,
    subject: options.subject,
    text: options.message,
    html: options.html
  };

  const info = await transporter.sendMail(message);

  console.log('Message sent: %s', info.messageId);
};

export default sendEmail;
