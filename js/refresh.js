// Pull fresh data for tracked artists and merge it into local state:
// detects new shows, price changes, status changes (cancelled / rescheduled), and price alerts.

import { getState, update } from './store.js';
import { tmArtistEvents, bitArtistEvents, ApiError } from './api.js';
import { normalizeName, sleep, todayStr, fmtMoney } from './util.js';

export const STATUS_LABEL = {
  onsale: 'On sale',
  offsale: 'Off sale',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
  postponed: 'Postponed',
  rescheduled: 'Rescheduled',
  soldout: 'Sold out',
};

export function emptyMine() {
  return { status: '', hidden: false, targetPrice: null, notes: '', qty: null, paid: null, seats: '' };
}

let running = null;
export const isRefreshing = () => !!running;

/**
 * Refresh all artists (or one). onProgress(done, total, artistName) is called as it goes.
 * Resolves to { newShows, priceDrops, alerts, errors, checked }.
 */
export function refresh({ artistId = null, onProgress } = {}) {
  if (running) return running;
  running = doRefresh({ artistId, onProgress }).finally(() => { running = null; });
  return running;
}

async function doRefresh({ artistId, onProgress }) {
  const s = getState();
  const { tmKey, bitAppId, countryCode } = s.settings;
  const artists = s.artists.filter((a) => !artistId || a.id === artistId);
  const summary = { newShows: [], priceDrops: [], alerts: [], statusChanges: [], errors: [], checked: 0 };
  if (!tmKey && !bitAppId) {
    summary.errors.push('Add a Ticketmaster API key in Settings to look up shows automatically.');
    return summary;
  }

  const results = [];
  let fatal = false;
  for (let i = 0; i < artists.length && !fatal; i++) {
    const a = artists[i];
    onProgress?.(i, artists.length, a.name);
    const res = { artistId: a.id, bySource: {}, error: '' };
    if (tmKey && a.tmId) {
      try {
        res.bySource.tm = await tmArtistEvents(a.tmId, tmKey, countryCode);
      } catch (e) {
        res.error = e.message;
        if (e instanceof ApiError && e.fatal) { fatal = true; summary.errors.push(e.message); }
      }
      await sleep(230);
    }
    if (bitAppId && !fatal) {
      try {
        res.bySource.bit = await bitArtistEvents(a.bitName || a.name, bitAppId);
      } catch (e) {
        if (!res.error) res.error = e.message;
      }
    }
    if (res.error && !fatal) summary.errors.push(`${a.name}: ${res.error}`);
    results.push(res);
  }
  onProgress?.(artists.length, artists.length, '');

  const now = Date.now();
  update((st) => {
    for (const r of results) {
      const artist = st.artists.find((x) => x.id === r.artistId);
      if (!artist) continue; // removed mid-refresh
      const firstCheck = !artist.lastChecked;
      for (const [source, events] of Object.entries(r.bySource)) {
        mergeEvents(st, artist, source, events, now, firstCheck, summary);
      }
      if (Object.keys(r.bySource).length) {
        artist.lastChecked = now;
        summary.checked++;
      }
      artist.lastError = r.error || '';
    }
    if (!artistId && summary.checked) st.lastRefresh = now;
    prunePast(st);
  });

  await maybeNotify(summary);
  return summary;
}

function sameShow(a, b) {
  if (!a.date || !b.date || a.date !== b.date) return false;
  const ca = normalizeName(a.venue?.city);
  const cb = normalizeName(b.venue?.city);
  if (ca && cb && ca === cb) return true;
  const va = normalizeName(a.venue?.name);
  const vb = normalizeName(b.venue?.name);
  return !!va && !!vb && (va.includes(vb) || vb.includes(va));
}

function mergeEvents(st, artist, source, incoming, now, firstCheck, summary) {
  const seen = new Set();
  for (const ev of incoming) {
    let target = st.events[ev.id];

    // Bandsintown often duplicates Ticketmaster listings — fold those in.
    if (!target && source === 'bit') {
      const dup = Object.values(st.events).find((x) => x.source !== 'bit' && x.artistIds?.includes(artist.id) && sameShow(x, ev));
      if (dup) {
        dup.altUrls = { ...(dup.altUrls || {}), bit: ev.url };
        dup.lastSeen = now;
        seen.add(dup.id);
        continue;
      }
    }

    if (!target) {
      target = {
        ...ev,
        artistIds: [artist.id],
        firstSeen: now,
        lastSeen: now,
        isNew: !firstCheck,
        delisted: false,
        priceHistory: [],
        priceChange: null,
        statusChange: null,
        altUrls: {},
        mine: emptyMine(),
      };
      st.events[ev.id] = target;
      if (target.isNew && ev.date && ev.date >= todayStr()) summary.newShows.push(target);
    } else {
      const prevStatus = target.status;
      const keep = {
        artistIds: target.artistIds || [],
        firstSeen: target.firstSeen,
        isNew: target.isNew,
        priceHistory: target.priceHistory || [],
        priceChange: target.priceChange,
        statusChange: target.statusChange,
        altUrls: target.altUrls || {},
        mine: { ...emptyMine(), ...(target.mine || {}) },
        alertedAt: target.alertedAt,
        image: ev.image || target.image,
      };
      Object.assign(target, ev, keep, { lastSeen: now, delisted: false });
      if (!target.artistIds.includes(artist.id)) target.artistIds.push(artist.id);
      if (prevStatus && ev.status && prevStatus !== ev.status) {
        target.statusChange = { from: prevStatus, to: ev.status, t: now };
        summary.statusChanges.push(target);
      }
    }
    seen.add(target.id);
    trackPrice(target, now, summary);
  }

  // Shows from this source that disappeared from the listing (but are still in the future).
  const today = todayStr();
  for (const ev of Object.values(st.events)) {
    if (ev.source !== source || !ev.artistIds?.includes(artist.id)) continue;
    if (seen.has(ev.id) || !ev.date || ev.date < today) continue;
    ev.delisted = true;
  }
}

function trackPrice(ev, now, summary) {
  if (ev.priceMin == null && ev.priceMax == null) return;
  const apiHist = ev.priceHistory.filter((h) => h.src === 'api');
  const last = apiHist[apiHist.length - 1];
  if (!last || last.min !== ev.priceMin || last.max !== ev.priceMax) {
    ev.priceHistory.push({ t: now, min: ev.priceMin, max: ev.priceMax, src: 'api' });
    if (last && last.min != null && ev.priceMin != null && ev.priceMin !== last.min) {
      ev.priceChange = { dir: ev.priceMin < last.min ? 'down' : 'up', from: last.min, to: ev.priceMin, t: now };
      if (ev.priceChange.dir === 'down') summary.priceDrops.push(ev);
    }
  }
  checkTarget(ev, now, summary);
}

export function lowestKnownPrice(ev) {
  const vals = [];
  if (ev.priceMin != null) vals.push(ev.priceMin);
  const manual = (ev.priceHistory || []).filter((h) => h.src === 'manual');
  const lastManual = manual[manual.length - 1];
  if (lastManual?.min != null) vals.push(lastManual.min);
  return vals.length ? Math.min(...vals) : null;
}

export function checkTarget(ev, now = Date.now(), summary = null) {
  const target = ev.mine?.targetPrice;
  const low = lowestKnownPrice(ev);
  if (target == null || low == null) return false;
  if (low <= target) {
    if (!ev.alertedAt) {
      ev.alertedAt = now;
      summary?.alerts.push(ev);
    }
    return true;
  }
  ev.alertedAt = null; // re-arm once it goes back above target
  return false;
}

// Keep past shows you went to (your concert history); drop other past shows after 30 days.
function prunePast(st) {
  const cutoff = todayStr(-30);
  for (const [id, ev] of Object.entries(st.events)) {
    if (!ev.date || ev.date >= cutoff) continue;
    const m = ev.mine || {};
    if (m.status === 'going' || m.status === 'tickets' || m.notes) continue;
    delete st.events[id];
  }
}

async function maybeNotify(summary) {
  const s = getState();
  if (!s.settings.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const lines = [];
  const name = (ev) => artistNames(ev).join(', ') || ev.name;
  for (const ev of summary.alerts.slice(0, 3)) lines.push(`🎯 ${name(ev)} under your target — ${fmtMoney(lowestKnownPrice(ev), ev.currency)}`);
  for (const ev of summary.newShows.slice(0, 3)) lines.push(`🆕 ${name(ev)} · ${ev.venue?.city || ev.venue?.name || ''} ${ev.date || ''}`);
  for (const ev of summary.priceDrops.slice(0, 2)) lines.push(`⬇️ ${name(ev)} now from ${fmtMoney(ev.priceMin, ev.currency)}`);
  for (const ev of summary.statusChanges.slice(0, 2)) lines.push(`⚠️ ${name(ev)}: ${STATUS_LABEL[ev.status] || ev.status}`);
  if (!lines.length) return;
  const title = summary.alerts.length ? 'Price alert' : summary.newShows.length ? `${summary.newShows.length} new show${summary.newShows.length > 1 ? 's' : ''}` : 'Show updates';
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body: lines.join('\n'), icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'encore-refresh' };
    if (reg?.showNotification) await reg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch (e) {
    console.warn('Notification failed', e);
  }
}

export function artistNames(ev) {
  const s = getState();
  return (ev.artistIds || []).map((id) => s.artists.find((a) => a.id === id)?.name).filter(Boolean);
}
