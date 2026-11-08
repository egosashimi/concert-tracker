// Shared UI pieces: icons, sheets, toasts, show cards, price chart, calendar export.

import { esc, fmtMoney, fmtPriceRange, parseLocalDate, placeLine, distanceMi, fmtDistance, daysUntil, fmtTime, initials } from './util.js';
import { getState } from './store.js';
import { STATUS_LABEL, eventName, lowestKnownPrice } from './refresh.js';

// ---------- Icons (inline SVG, stroke-based) ----------
const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  chev: '<path d="M9 18l6-6-6-6"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  ticket: '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  music: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.7 0 3.2-.5 4.5-1.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17h.01"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  heart: '<path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 21h14"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  clip: '<path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  cloud: '<path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1 0 8z"/>',
  building: '<path d="M4 21V5l8-3 8 3v16"/><path d="M9 21v-4h6v4M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};
export const icon = (name, cls = '') => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${P[name] || ''}</svg>`;

// ---------- Toasts ----------
export function toast(msg, { error = false, ms = 2600 } = {}) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast${error ? ' err' : ''}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ---------- Bottom sheet ----------
let openSheetEl = null;
export function openSheet({ title, body, onMount, onClose, left = '' }) {
  closeSheet(true);
  const root = document.getElementById('sheet-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', title);
  sheet.innerHTML = `
    <div class="sheet-grab"></div>
    <div class="sheet-head">
      ${left || '<span class="spacer"></span>'}
      <h3>${esc(title)}</h3>
      <button class="icon-btn" data-close aria-label="Close">${icon('close')}</button>
    </div>
    <div class="sheet-body">${body}</div>`;
  root.append(backdrop, sheet);
  const close = () => closeSheet();
  backdrop.addEventListener('click', close);
  sheet.querySelector('[data-close]').addEventListener('click', close);
  enableSwipeDown(sheet, close);
  openSheetEl = { backdrop, sheet, onClose };
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  });
  onMount?.(sheet.querySelector('.sheet-body'), close);
  return close;
}

export function closeSheet(immediate = false) {
  if (!openSheetEl) return;
  const { backdrop, sheet, onClose } = openSheetEl;
  openSheetEl = null;
  onClose?.();
  if (immediate) { backdrop.remove(); sheet.remove(); return; }
  backdrop.classList.remove('open');
  sheet.classList.remove('open');
  setTimeout(() => { backdrop.remove(); sheet.remove(); }, 300);
}
export const sheetIsOpen = () => !!openSheetEl;

function enableSwipeDown(sheet, close) {
  const grab = sheet.querySelector('.sheet-grab');
  const head = sheet.querySelector('.sheet-head');
  let startY = null;
  let dy = 0;
  const start = (e) => { startY = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none'; };
  const move = (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (startY == null) return;
    sheet.style.transition = '';
    sheet.style.transform = '';
    startY = null;
    if (dy > 90) close();
  };
  for (const el of [grab, head]) {
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', end);
  }
}

export function confirmSheet({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    openSheet({
      title,
      body: `<p class="muted" style="margin:4px 4px 18px">${esc(message)}</p>
        <div class="stack">
          <button class="btn block ${danger ? 'danger' : 'primary'}" data-yes>${esc(confirm)}</button>
          <button class="btn block" data-no>Cancel</button>
        </div>`,
      onMount: (body, close) => {
        body.querySelector('[data-yes]').onclick = () => { answered = true; resolve(true); close(); };
        body.querySelector('[data-no]').onclick = () => close();
      },
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

// ---------- Show helpers ----------
export function eventTitle(ev) {
  return eventName(ev);
}

/** Where the lowest price comes from: 'face' | 'resale' | 'manual'. */
export function lowSource(ev) {
  const low = lowestKnownPrice(ev);
  if (low == null) return null;
  if (ev.priceMin === low) return 'face';
  if (ev.resale && !ev.resale.gone && ev.resale.min === low) return 'resale';
  return 'manual';
}

export function eventDistance(ev) {
  const home = getState().settings.home;
  if (!home) return null;
  return distanceMi(home, ev.venue);
}

export function isCancelled(ev) {
  return ev.status === 'cancelled' || ev.status === 'canceled';
}

export function onSaleSoon(ev) {
  const now = Date.now();
  const times = [ev.onSale, ...(ev.presales || []).map((p) => p.start)]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => Number.isFinite(t) && t > now);
  if (!times.length) return null;
  return Math.min(...times);
}

export function eventBadges(ev, { compact = false } = {}) {
  const b = [];
  const m = ev.mine || {};
  if (ev.isNew) b.push('<span class="badge new">New</span>');
  if (m.status === 'tickets') b.push(`<span class="badge good">${icon('ticket')}Got tickets</span>`);
  else if (m.status === 'going') b.push(`<span class="badge accent">${icon('check')}Going</span>`);
  else if (m.status === 'interested') b.push(`<span class="badge info">${icon('star')}Interested</span>`);
  if (isCancelled(ev)) b.push('<span class="badge bad">Cancelled</span>');
  else if (ev.status === 'postponed') b.push('<span class="badge warn">Postponed</span>');
  else if (ev.status === 'rescheduled') b.push('<span class="badge warn">Rescheduled</span>');
  else if (ev.status === 'soldout') b.push('<span class="badge warn">Sold out</span>');
  else if (ev.status === 'offsale' && !onSaleSoon(ev)) b.push('<span class="badge">Off sale</span>');
  if (ev.alertedAt && m.targetPrice != null) b.push(`<span class="badge good">${icon('target')}Under target</span>`);
  const soon = onSaleSoon(ev);
  if (soon && !isCancelled(ev)) {
    const days = (soon - Date.now()) / 86400000;
    const label = days < 1 ? 'On sale today' : days < 7
      ? `On sale ${new Date(soon).toLocaleDateString(undefined, { weekday: 'short' })}`
      : `On sale ${new Date(soon).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    b.push(`<span class="badge info">${icon('clock')}${label}</span>`);
  }
  if (ev.delisted && !isCancelled(ev)) b.push('<span class="badge warn">No longer listed</span>');
  if (!compact && ev.source === 'manual') b.push('<span class="badge">Added by you</span>');
  return b.join('');
}

export function dateBox(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return '<div class="datebox tba"><span class="mon">DATE</span><span class="day">TBA</span></div>';
  return `<div class="datebox">
    <span class="mon">${d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</span>
    <span class="day">${d.getDate()}</span>
    <span class="dow">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
  </div>`;
}

export function showCard(ev, { showArtist = true } = {}) {
  const m = ev.mine || {};
  const dist = eventDistance(ev);
  const units = getState().settings.units;
  const low = lowestKnownPrice(ev);
  const place = [ev.venue?.name, placeLine(ev.venue)].filter(Boolean).join(' · ');
  const n = daysUntil(ev.date);
  const timeBits = [n != null && n >= 0 && n <= 7 ? (n === 0 ? 'Tonight' : n === 1 ? 'Tomorrow' : `In ${n} days`) : '', fmtTime(ev.time), dist != null ? fmtDistance(dist, units) : '']
    .filter(Boolean).join(' · ');
  let priceHtml = '';
  if (m.status === 'tickets' && m.paid != null) {
    priceHtml = `<span>paid</span><b>${esc(fmtMoney(m.paid, ev.currency))}</b>`;
  } else if (low != null) {
    let change = '';
    if (ev.priceChange && Date.now() - ev.priceChange.t < 7 * 86400000) {
      change = ev.priceChange.dir === 'down'
        ? `<span class="drop">▼ ${esc(fmtMoney(ev.priceChange.from - ev.priceChange.to, ev.currency))}</span>`
        : `<span class="rise">▲ ${esc(fmtMoney(ev.priceChange.to - ev.priceChange.from, ev.currency))}</span>`;
    }
    priceHtml = `<span>${lowSource(ev) === 'resale' ? 'resale' : 'from'}</span><b>${esc(fmtMoney(low, ev.currency))}</b>${change}`;
  }
  const cls = ['show-card', m.status ? `mine-${m.status}` : '', isCancelled(ev) ? 'cancelled dim' : '', m.hidden ? 'dim' : ''].join(' ');
  return `<a class="${cls}" href="#/event/${encodeURIComponent(ev.id)}">
    ${dateBox(ev.date)}
    <div class="info">
      ${showArtist ? `<div class="artist">${esc(eventTitle(ev))}</div>` : `<div class="artist">${esc(ev.venue?.name || ev.name)}</div>`}
      <div class="venue">${esc(showArtist ? place : placeLine(ev.venue))}</div>
      ${timeBits ? `<div class="venue small muted">${esc(timeBits)}</div>` : ''}
      <div class="badges">${eventBadges(ev, { compact: true })}</div>
    </div>
    ${priceHtml ? `<div class="price">${priceHtml}</div>` : ''}
  </a>`;
}

export function avatar(artist, cls = '') {
  if (artist?.image) return `<img class="avatar ${cls}" src="${esc(artist.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  return `<div class="avatar ${cls}" aria-hidden="true">${esc(initials(artist?.name))}</div>`;
}

export function groupByMonth(events) {
  const groups = [];
  let cur = null;
  for (const ev of events) {
    const d = parseLocalDate(ev.date);
    const key = d ? `${d.getFullYear()}-${d.getMonth()}` : 'tba';
    if (!cur || cur.key !== key) {
      const label = d
        ? d.toLocaleDateString(undefined, { month: 'long', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
        : 'Date TBA';
      cur = { key, label, events: [] };
      groups.push(cur);
    }
    cur.events.push(ev);
  }
  return groups;
}

export function sortEvents(list) {
  return list.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || ''));
  });
}

// ---------- Calendar (.ics) ----------
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}
function foldLine(line) {
  const out = [];
  while (line.length > 74) { out.push(line.slice(0, 74)); line = ` ${line.slice(74)}`; }
  out.push(line);
  return out.join('\r\n');
}
export function buildICS(events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Encore//Concert Tracker//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const ev of events) {
    if (!ev.date) continue;
    const d = ev.date.replace(/-/g, '');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.id}@encore`);
    lines.push(`DTSTAMP:${stamp}`);
    if (ev.dateTime) {
      // Exact UTC start from Ticketmaster; assume a 3h show.
      const s = new Date(ev.dateTime);
      const e = new Date(s.getTime() + 3 * 3600000);
      const f = (x) => x.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
      lines.push(`DTSTART:${f(s)}`, `DTEND:${f(e)}`);
    } else if (ev.time) {
      const [h, mi] = ev.time.split(':').map(Number);
      const p = (n) => String(n).padStart(2, '0');
      const endH = h + 3;
      const endDate = new Date(parseLocalDate(ev.date).getTime());
      endDate.setHours(endH, mi || 0);
      const ed = `${endDate.getFullYear()}${p(endDate.getMonth() + 1)}${p(endDate.getDate())}T${p(endDate.getHours())}${p(endDate.getMinutes())}00`;
      lines.push(`DTSTART:${d}T${p(h)}${p(mi || 0)}00`, `DTEND:${ed}`);
    } else {
      const next = new Date(parseLocalDate(ev.date).getTime() + 86400000);
      const p = (n) => String(n).padStart(2, '0');
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next.getFullYear()}${p(next.getMonth() + 1)}${p(next.getDate())}`);
    }
    lines.push(`SUMMARY:${icsEscape(eventTitle(ev))}`);
    const loc = [ev.venue?.name, ev.venue?.address || placeLine(ev.venue)].filter(Boolean).join(', ');
    if (loc) lines.push(`LOCATION:${icsEscape(loc)}`);
    const desc = [ev.name, ev.mine?.seats ? `Seats: ${ev.mine.seats}` : '', ev.mine?.notes, ev.url].filter(Boolean).join('\n');
    if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    if (ev.url) lines.push(`URL:${ev.url}`);
    if (isCancelled(ev)) lines.push('STATUS:CANCELLED');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n');
}

export function statusLabel(code) {
  return STATUS_LABEL[code] || (code ? code[0].toUpperCase() + code.slice(1) : '');
}
