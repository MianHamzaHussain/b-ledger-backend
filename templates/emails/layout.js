/**
 * Shared HTML shell for every transactional email.
 *
 * Table-based with an mso conditional block because email clients (Outlook
 * especially) ignore modern CSS layout — this is the one place in the codebase
 * where that markup is correct rather than dated.
 *
 * Branding mirrors the app's palette (see frontend/src/config/theme.ts): neon
 * cyan on graphite. The header is dark on purpose — the logo is built to glow
 * against near-black, so a white header would wash it out. Colours are inline
 * hex, never CSS variables, because no mail client resolves custom properties.
 */
export const wrapEmail = (content, title = 'B Ledger') => {
  const appName = process.env.APP_NAME || 'B Ledger';
  const baseUrl = process.env.SERVER_URI || 'http://localhost:5000';
  const logoUrl = `${baseUrl}/images/logo.png`;
  const websiteUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  // Brand palette — kept in step with frontend/src/config/theme.ts.
  const cyan = '#22D9E0'; // neon accent (glow border)
  const cyanDeep = '#0E9FB5'; // primary on light — readable button/link
  const graphite = '#14181D'; // near-black header/footer
  const silver = '#9BA5AE'; // muted footer text
  const year = new Date().getFullYear();

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <!--[if mso]>
    <noscript>
    <xml>
    <o:OfficeDocumentSettings>
    <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings>
    </xml>
    </noscript>
    <![endif]-->
    <style>
        body { margin: 0; padding: 0; min-width: 100%; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 16px; line-height: 1.5; background-color: #eef1f4; color: #334155; }
        a { color: ${cyanDeep}; text-decoration: none; font-weight: 600; }
        img { display: block; max-width: 100%; height: auto; border: 0; }

        .wrapper { width: 100%; table-layout: fixed; background-color: #eef1f4; padding-bottom: 40px; }
        .main { background-color: #ffffff; margin: 0 auto; width: 100%; max-width: 600px; border-radius: 14px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }

        .header { background-color: ${graphite}; padding: 28px 20px; text-align: center; border-bottom: 3px solid ${cyan}; }
        .content { padding: 40px 32px; }
        .footer { background-color: ${graphite}; padding: 28px 20px; text-align: center; font-size: 13px; color: ${silver}; }

        h1, h2, h3 { color: ${graphite}; margin-top: 0; font-weight: 700; }
        p { margin: 0 0 16px; }

        .btn { display: inline-block; background-color: ${cyanDeep}; color: #ffffff !important; padding: 13px 34px; border-radius: 10px; text-decoration: none; font-weight: 600; margin-top: 8px; text-align: center; }
        .btn:hover { background-color: #0b8399; }

        .text-center { text-align: center; }
        .text-sm { font-size: 14px; }
        .text-muted { color: #64748b; }
        .footer-link { color: ${cyan} !important; text-decoration: none; }

        @media only screen and (max-width: 600px) {
            .content { padding: 32px 20px; }
            .header { padding: 24px 20px; }
            .btn { display: block; width: 100%; box-sizing: border-box; }
        }
    </style>
</head>
<body>
    <div class="wrapper">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
            <tr>
                <td style="padding: 20px 0;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                        <tr>
                            <td align="center">
                                <div class="main">

                                    <!-- Header -->
                                    <div class="header">
                                        <a href="${websiteUrl}" target="_blank" style="display: inline-block;">
                                           <img src="${logoUrl}" alt="${appName}" style="height: 48px; width: auto; margin: 0 auto; border: 0; outline: none; text-decoration: none;">
                                        </a>
                                    </div>

                                    <!-- Content -->
                                    <div class="content">
                                        ${content}
                                    </div>

                                    <!-- Footer -->
                                    <div class="footer">
                                        <p style="margin-bottom: 6px; color: #ffffff; font-weight: 700; letter-spacing: 0.3px;">
                                            ${appName}
                                        </p>
                                        <p style="margin-bottom: 14px; font-size: 12px; color: ${silver};">
                                            Orders, stock and payments for your businesses — in one place.
                                        </p>
                                        <p style="margin-bottom: 12px;">
                                            <a href="${websiteUrl}" class="footer-link">Open ${appName}</a>
                                        </p>
                                        <p style="margin-bottom: 0; font-size: 12px; color: ${silver};">
                                            &copy; ${year} ${appName}. All rights reserved.
                                        </p>
                                    </div>

                                </div>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>
    </div>
</body>
</html>
    `;
};
