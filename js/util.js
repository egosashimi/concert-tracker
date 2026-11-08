// Small helpers shared across the app.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function initials(name) {
  const parts = String(name || '?').replace(/^the\s+/i, '').split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] || '?').toUpperCase() + (parts[1]?.[0] || '').toUpperCase();
}

export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

// ---------- Dates ----------
// Dates are stored as "YYYY-MM-DD" in the venue's local time; parse them as local dates.
export function parseLocalDate(d) {
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return null;
  return new Date(y, m - 1, day);
}

export function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return toDateStr(d);
}

export function toDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function daysUntil(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return null;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 86400000);
}

export function fmtDate(dateStr, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) {
  const d = parseLocalDate(dateStr);
  if (!d) return 'Date TBA';
  return d.toLocaleDateString(undefined, opts);
}

export function fmtTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const d = new Date(2000, 0, 1, h, m || 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fmtDateTimeISO(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function countdown(dateStr) {
  const n = daysUntil(dateStr);
  if (n == null) return '';
  if (n < -1) return `${-n} days ago`;
  if (n === -1) return 'Yesterday';
  if (n === 0) return 'Tonight';
  if (n === 1) return 'Tomorrow';
  if (n < 14) return `In ${n} days`;
  if (n < 60) return `In ${Math.round(n / 7)} weeks`;
  return `In ${Math.round(n / 30.4)} months`;
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ---------- Money ----------
const moneyCache = new Map();
export function fmtMoney(n, currency = 'USD') {
  if (n == null || Number.isNaN(Number(n))) return '';
  const whole = Math.abs(n % 1) < 0.005;
  const key = `${currency}|${whole}`;
  let f = moneyCache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || 'USD',
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: whole ? 0 : 2,
      });
    } catch {
      f = { format: (v) => `$${Number(v).toFixed(whole ? 0 : 2)}` };
    }
    moneyCache.set(key, f);
  }
  return f.format(n);
}

export function fmtPriceRange(min, max, currency) {
  if (min == null && max == null) return '';
  if (min != null && max != null && Math.abs(max - min) >= 0.5) return `${fmtMoney(min, currency)}–${fmtMoney(max, currency)}`;
  return fmtMoney(min ?? max, currency);
}

// ---------- Geo ----------
export function distanceMi(a, b) {
  if (!a || !b || !isFinite(a.lat) || !isFinite(a.lon) || !isFinite(b.lat) || !isFinite(b.lon)) return null;
  const R = 3958.8;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function fmtDistance(mi, units = 'mi') {
  if (mi == null) return '';
  const v = units === 'km' ? mi * 1.609344 : mi;
  return `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()} ${units}`;
}

export function placeLine(venue) {
  if (!venue) return '';
  const parts = [venue.city, venue.region || (venue.country !== 'US' ? venue.country : '')].filter(Boolean);
  return parts.join(', ');
}

// ---------- Platform ----------
export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export function haptic() {
  try { navigator.vibrate?.(8); } catch { /* not supported on iOS */ }
}

// Share or download a file. On iOS the share sheet is the reliable way to hand files to other apps.
export async function shareOrDownload(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}
