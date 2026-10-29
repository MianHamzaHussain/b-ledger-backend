/**
 * A person-readable device from a `User-Agent` string: "Chrome on Windows", "Safari on iPhone".
 * Deliberately small and dependency-free — it only has to be recognisable on the "Where you are
 * signed in" screen, not exact. Anything it does not know reads as "Unknown browser / device".
 */

// Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari".
const BROWSERS = [
  [/edg(e|a|ios)?\//i, 'Edge'],
  [/opr\/|opera/i, 'Opera'],
  [/samsungbrowser/i, 'Samsung Internet'],
  [/firefox|fxios/i, 'Firefox'],
  [/chrome|crios|chromium/i, 'Chrome'],
  [/safari/i, 'Safari']
];

const SYSTEMS = [
  [/iphone/i, 'iPhone'],
  [/ipad/i, 'iPad'],
  [/android/i, 'Android'],
  [/windows/i, 'Windows'],
  [/mac os x|macintosh/i, 'Mac'],
  [/cros/i, 'Chromebook'],
  [/linux/i, 'Linux']
];

export const describeDevice = (userAgent = '') => {
  const ua = String(userAgent);
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? 'Unknown browser';
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? 'Unknown device';
  const kind = /ipad|tablet/i.test(ua)
    ? 'tablet'
    : /mobile|iphone|android/i.test(ua)
      ? 'mobile'
      : 'desktop';
  return { browser, os, kind };
};

/** "Chrome on Windows" — the one line a session row leads with. */
export const deviceLabel = ({ browser, os }) => `${browser} on ${os}`;

/** Coarse identity of a device (no address), to tell "a device we have seen" from a new one. */
export const deviceFingerprint = ({ browser, os, kind }) => `${browser}|${os}|${kind}`;
