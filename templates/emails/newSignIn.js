import { wrapEmail } from './layout.js';

/** User-derived text goes into HTML, so it is escaped here rather than trusted. */
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const getNewSignInEmail = ({ name, device, ip, when }) => {
  const content = `
        <div style="text-align: center; margin-bottom: 24px;">
            <p>Hello <strong>${esc(name)}</strong>,</p>
            <p>Your account was just signed in from a device we have not seen before.</p>
        </div>

        <div style="margin: 24px auto; max-width: 360px; line-height: 1.7;">
            <div><strong>Device:</strong> ${esc(device)}</div>
            ${ip ? `<div><strong>Address:</strong> ${esc(ip)}</div>` : ''}
            <div><strong>Time:</strong> ${esc(when)}</div>
        </div>

        <p style="text-align: center;">If this was you, there is nothing to do.</p>
        <p style="text-align: center; color: #94a3b8; font-size: 0.9em;">If it was not, sign in, open <strong>Where you are signed in</strong>, sign that device out and change your password.</p>
    `;
  return wrapEmail(content, 'New sign-in to your account');
};

export default getNewSignInEmail;
