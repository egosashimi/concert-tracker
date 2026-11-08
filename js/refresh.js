// Pull fresh data for followed artists, venues and areas, then merge it into local state:
// detects new shows, face-value and resale price changes, status changes, and price-target alerts.

import { getState, update } from './store.js';
import {
  tmArtistEvents, bitArtistEvents, tmPlaceEvents, sgFindPerformer, sgPerformerEvents, sameShow, ApiError,
} from './api.js';
import { sleep, todayStr, fmtMoney } from './util.js';

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
  return { status: '', hidden: false, targetPrice: null, notes: '', qty: null, paid: null, seats: '', doors: '', files: [], t: 0 };
}

let running = null;
export const isRefreshing = () => !!running;

/**
 * Refresh everything, one artist, or one place. onProgress(done, total, label) is called as it goes.
 * Resolves to { newShows, priceDrops, alerts, statusChanges, errors, checked }.
 */
export function refresh({ artistId = null, placeId = null, onProgress } = {}) {
  if (running) return running;
  running = doRefresh({ artistId, placeId, onProgress }).finally(() => { running = null; });
  return running;
}

async function doRefresh({ artistId, placeId, onProgress }) {
  const s = getState();
  const { tmKey, bitAppId, sgClientId, countryCode } = s.settings;
  const all = !artistId && !placeId;
  const artists = placeId ? [] : s.artists.filter((a) => !artistId || a.id === artistId);
  const places = artistId ? [] : (s.places || []).filter((p) => !placeId || p.id === placeId);
  const summary = { newShows: [], priceDrops: [], alerts: [], statusChanges: [], errors: [], checked: 0 };
  if (!tmKey && !bitAppId && !sgClientId) {
    summary.errors.push('Add a Ticketmaster API key in Settings to look up shows automatically.');
    return summary;
  }

  const total = artists.length + (tmKey ? places.length : 0);
  let done = 0;
  const results = [];
  let tmDead = !tmKey;
  let sgDead = !sgClientId;

  for (const a of artists) {
    onProgress?.(done, total, a.name);
    const res = { owner: { kind: 'artist', id: a.id }, bySource: {}, error: '', patch: {} };
    if (!tmDead && a.tmId) {
      try {
        res.bySource.tm = await tmArtistEvents(a.tmId, tmKey, countryCode);
      } catch (e) {
        res.error = e.message;
        if (e instanceof ApiError && e.fatal) { tmDead = true; summary.errors.push(e.message); }
      }
      await sleep(230);
    }
    if (bitAppId) {
      try {
        res.bySource.bit = await bitArtistEvents(a.bitName || a.name, bitAppId);
      } catch (e) {
        if (!res.error) res.error = e.message;
      }
    }
    if (!sgDead) {
      try {
        let sgId = a.sgId;
        if (!sgId && Date.now() - (a.sgChecked || 0) > 7 * 86400000) {
          const p = await sgFindPerformer(a.name, sgClientId);
          sgId = p ? String(p.id) : '';
          res.patch.sgId = sgId;
          res.patch.sgChecked = Date.now();
        }
        if (sgId) res.bySource.sg = await sgPerformerEvents(sgId, sgClientId);
      } catch (e) {
        if (e instanceof ApiError && e.fatal) { sgDead = true; summary.errors.push(e.message); }
        else if (!res.error) res.error = `SeatGeek: ${e.message}`;
      }
    }
    if (res.error && !summary.errors.includes(res.error)) summary.errors.push(`${a.name}: ${res.error}`);
    results.push(res);
    done++;
  }

  for (const p of places) {
    if (tmDead) break;
    onProgress?.(done, total, p.name);
    const res = { owner: { kind: 'place', id: p.id }, bySource: {}, error: '', patch: {} };
    try {
      res.bySource.tm = await tmPlaceEvents(p, tmKey);
    } catch (e) {
      res.error = e.message;
      if (e instanceof ApiError && e.fatal) tmDead = true;
      summary.errors.push(`${p.name}: ${e.message}`);
    }
    results.push(res);
    done++;
    await sleep(230);
  }
  onProgress?.(total, total, '');

  const now = Date.now();
  update((st) => {
    for (const r of results) {
      const list = r.owner.kind === 'artist' ? st.artists : st.places;
      const owner = list.find((x) => x.id === r.owner.id);
      if (!owner) continue; // removed mid-refresh
      Object.assign(owner, r.patch);
      const firstCheck = !owner.lastChecked;
      // Primary sources first so secondary listings fold into them.
      for (const source of ['tm', 'bit', 'sg']) {
        if (r.bySource[source]) mergeEvents(st, r.owner.kind, owner, source, r.bySource[source], now, firstCheck, summary);
      }
      if (Object.keys(r.bySource).length) {
        owner.lastChecked = now;
        summary.checked++;
      }
      owner.lastError = r.error || '';
    }
    if (all && summary.checked) st.lastRefresh = now;
    prune(st);
  });

  for (const k of ['newShows', 'priceDrops', 'alerts', 'statusChanges']) {
    summary[k] = [...new Map(summary[k].map((e) => [e.id, e])).values()];
  }
  await maybeNotify(summary);
  return summary;
}

function newEvent(ev, now) {
  return {
    ...ev,
    artistIds: [],
    placeIds: [],
    firstSeen: now,
    lastSeen: now,
    isNew: false,
    delisted: false,
    priceHistory: [],
    priceChange: null,
    statusChange: null,
    altUrls: {},
    mine: emptyMine(),
  };
}

function mergeEvents(st, kind, owner, source, incoming, now, firstCheck, summary) {
  const key = kind === 'artist' ? 'artistIds' : 'placeIds';
  const seen = new Set();
  const today = todayStr();

  for (const ev of incoming) {
    let target = st.events[ev.id];
    if (st.deleted?.events?.[ev.id]) continue;

    // Bandsintown and SeatGeek often list the same show as Ticketmaster — fold those in.
    if (!target && source !== 'tm') {
      const dup = Object.values(st.events).find((x) => x.source !== source && x[key]?.includes(owner.id) && sameShow(x, ev));
      if (dup) {
        const before = lowestKnownPrice(dup);
        dup.altUrls = { ...(dup.altUrls || {}), [source]: ev.url };
        if (source === 'sg') trackResale(dup, ev.resale, now);
        noteChange(dup, before, now, summary);
        checkTarget(dup, now, summary);
        seen.add(dup.id);
        continue;
      }
    }

    if (!target) {
      target = newEvent(ev, now);
      target[key] = [owner.id];
      const announce = !firstCheck && !(kind === 'place' && owner.kind === 'area');
      target.isNew = announce;
      st.events[ev.id] = target;
      if (announce && ev.date && ev.date >= today) summary.newShows.push(target);
      if (source === 'sg') {
        target.resale = null;
        trackResale(target, ev.resale, now);
      }
    } else {
      const prevStatus = target.status;
      const before = lowestKnownPrice(target);
      const keep = {
        artistIds: target.artistIds || [],
        placeIds: target.placeIds || [],
        firstSeen: target.firstSeen,
        isNew: target.isNew,
        priceHistory: target.priceHistory || [],
        priceChange: target.priceChange,
        statusChange: target.statusChange,
        altUrls: target.altUrls || {},
        mine: { ...emptyMine(), ...(target.mine || {}) },
        alertedAt: target.alertedAt,
        resale: target.resale || null,
        image: ev.image || target.image,
      };
      Object.assign(target, ev, keep, { lastSeen: now, delisted: false });
      if (source === 'sg') trackResale(target, ev.resale, now);
      if (prevStatus && ev.status && prevStatus !== ev.status) {
        target.statusChange = { from: prevStatus, to: ev.status, t: now };
        summary.statusChanges.push(target);
      }
      trackFace(target, now);
      noteChange(target, before, now, summary);
    }
    if (!target[key]) target[key] = [];
    if (!target[key].includes(owner.id)) target[key].push(owner.id);
    if (st.events[ev.id] === target && source === 'tm' && target.priceHistory.length === 0) trackFace(target, now);
    seen.add(target.id);
    checkTarget(target, now, summary);

    // Fill in the artist's genre/photo from Ticketmaster data (used for suggestions).
    if (kind === 'artist' && source === 'tm' && owner.tmId) {
      const me = (ev.attractions || []).find((a) => a.tmId === owner.tmId);
      if (me) {
        if (!owner.genreIds?.length && (me.genreId || me.subGenreId)) {
          owner.genreIds = [me.genreId].filter(Boolean);
          owner.subGenreIds = [me.subGenreId].filter(Boolean);
          if (!owner.genre) owner.genre = [me.genre, me.subGenre].filter((g, i, a) => g && a.indexOf(g) === i).join(' · ');
        }
        if (!owner.image && me.image) owner.image = me.image;
      }
    }
  }

  // Shows from this source that disappeared from the listing.
  for (const ev of Object.values(st.events)) {
    if (!ev[key]?.includes(owner.id) || seen.has(ev.id) || !ev.date || ev.date < today) continue;
    if (kind === 'place') {
      // Area/venue feeds only cover a window; just detach the show.
      if (ev.source === 'tm' && source === 'tm') ev.placeIds = ev.placeIds.filter((x) => x !== owner.id);
    } else if (ev.source === source) {
      ev.delisted = true;
    }
  }
}

function trackFace(ev, now) {
  if (ev.priceMin == null && ev.priceMax == null) return;
  const hist = ev.priceHistory.filter((h) => h.src === 'api');
  const last = hist[hist.length - 1];
  if (!last || last.min !== ev.priceMin || last.max !== ev.priceMax) {
    ev.priceHistory.push({ t: now, min: ev.priceMin, max: ev.priceMax, src: 'api' });
  }
}

function trackResale(ev, resale, now) {
  if (!resale) {
    if (ev.resale) ev.resale = { ...ev.resale, count: 0, t: now, gone: true };
    return;
  }
  ev.resale = { ...resale, t: now };
  ev.priceHistory = ev.priceHistory || [];
  const hist = ev.priceHistory.filter((h) => h.src === 'resale');
  const last = hist[hist.length - 1];
  if (!last || last.min !== resale.min) {
    ev.priceHistory.push({ t: now, min: resale.min, max: resale.max ?? null, src: 'resale', note: resale.src || 'SeatGeek' });
  }
}

function noteChange(ev, before, now, summary) {
  const after = lowestKnownPrice(ev);
  if (before == null || after == null || Math.abs(after - before) < 0.5) return;
  ev.priceChange = { dir: after < before ? 'down' : 'up', from: before, to: after, t: now };
  if (after < before) summary.priceDrops.push(ev);
}

/** Lowest price we know of right now: face value, current resale, or the last price you logged. */
export function lowestKnownPrice(ev) {
  const vals = [];
  if (ev.priceMin != null) vals.push(ev.priceMin);
  if (ev.resale && !ev.resale.gone && ev.resale.min != null) vals.push(ev.resale.min);
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

// Keep past shows you went to (your concert history); drop other past shows.
export function prune(st) {
  const today = todayStr();
  const cutoff = todayStr(-30);
  for (const [id, ev] of Object.entries(st.events)) {
    const m = ev.mine || {};
    const mine = m.status || m.notes || m.files?.length;
    const orphan = !ev.artistIds?.length && !ev.placeIds?.length;
    if (mine) continue;
    if (orphan || (ev.date && ev.date < cutoff) || (!ev.artistIds?.length && ev.date && ev.date < today)) {
      delete st.events[id];
    }
  }
}

async function maybeNotify(summary) {
  const s = getState();
  // With background alerts on, the server sends pushes; don't double up.
  if (s.settings.push?.enabled) return;
  if (!s.settings.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const lines = [];
  const name = (ev) => eventName(ev);
  for (const ev of summary.alerts.slice(0, 3)) lines.push(`🎯 ${name(ev)} under your target — ${fmtMoney(lowestKnownPrice(ev), ev.currency)}`);
  for (const ev of summary.newShows.slice(0, 3)) lines.push(`🆕 ${name(ev)} · ${ev.venue?.city || ev.venue?.name || ''} ${ev.date || ''}`);
  for (const ev of summary.priceDrops.slice(0, 2)) lines.push(`⬇️ ${name(ev)} now from ${fmtMoney(lowestKnownPrice(ev), ev.currency)}`);
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

/** Display name: followed artists first, otherwise the headliners from the lineup. */
export function eventName(ev) {
  const names = artistNames(ev);
  if (names.length) return names.join(' & ');
  if (ev.lineup?.length) return ev.lineup.slice(0, 2).join(' & ');
  return ev.name || 'Concert';
}
