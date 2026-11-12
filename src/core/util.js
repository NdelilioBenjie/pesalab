import crypto from 'node:crypto';

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

export const hex = (n = 32) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

export function randomDigits(n) {
  let out = '';
  while (out.length < n) out += crypto.randomInt(0, 10);
  return out;
}

export function randomAlnum(n) {
  let out = '';
  while (out.length < n) out += ALNUM[crypto.randomInt(0, ALNUM.length)];
  return out;
}

/** East Africa Time (UTC+3) parts for a date. Both countries share the zone. */
export function eat(date = new Date()) {
  const d = new Date(date.getTime() + 3 * 3600 * 1000);
  const p = (v, n = 2) => String(v).padStart(n, '0');
  return {
    YYYY: p(d.getUTCFullYear(), 4),
    MM: p(d.getUTCMonth() + 1),
    DD: p(d.getUTCDate()),
    hh: p(d.getUTCHours()),
    mm: p(d.getUTCMinutes()),
    ss: p(d.getUTCSeconds()),
  };
}

/** 20261112093000 */
export function stamp14(date) {
  const t = eat(date);
  return `${t.YYYY}${t.MM}${t.DD}${t.hh}${t.mm}${t.ss}`;
}

/** 12.11.2026 09:30:00 */
export function stampDotted(date) {
  const t = eat(date);
  return `${t.DD}.${t.MM}.${t.YYYY} ${t.hh}:${t.mm}:${t.ss}`;
}

export const digits = (v) => String(v ?? '').replace(/\D/g, '');

const DIAL = { KE: '254', TZ: '255' };

/**
 * Normalise a phone number to international digits (2557XXXXXXXX).
 * Accepts +255..., 255..., 07..., 7... given a country hint.
 */
export function normaliseMsisdn(raw, country) {
  const d = digits(raw);
  const cc = DIAL[country];
  if (/^25[45]\d{9}$/.test(d)) return d;
  if (cc && /^0\d{9}$/.test(d)) return cc + d.slice(1);
  if (cc && /^\d{9}$/.test(d)) return cc + d;
  return d;
}

export function countryOf(msisdn, fallback = 'TZ') {
  if (String(msisdn).startsWith('254')) return 'KE';
  if (String(msisdn).startsWith('255')) return 'TZ';
  return fallback;
}

export const currencyOf = (country) => (country === 'KE' ? 'KES' : 'TZS');

export function isPositiveAmount(v) {
  const n = Number(v);
  return v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n > 0;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isLocalUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.local');
  } catch {
    return false;
  }
}

export function isHttpUrl(u) {
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}
