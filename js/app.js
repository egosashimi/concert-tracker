// Encore — app entry: routing, global actions, refresh orchestration, service worker.

import { getState, update, subscribe, requestPersistence, lastSaveError } from './store.js';
import { refresh, isRefreshing } from './refresh.js';
import { $, $$, isStandalone, todayStr, haptic } from './util.js';
import { toast, sheetIsOpen, closeSheet } from './ui.js';
import * as V from './views.js';
import * as M from './views-more.js';
import { syncEnabled, scheduleSync, syncNow } from './sync.js';
import { handleSpotifyRedirect } from './spotify.js';

const app = $('#app');
let currentRoute = null;

// ---------------- Routing ----------------
function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'shows';
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').map(decodeURIComponent);
  return { name: parts[0] || 'shows', id: parts[1] || null, params: new URLSearchParams(query), key: path };
}

function go(hash, replace = false) {
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  render({ scrollTop: true });
}

let navDepth = 0;
window.addEventListener('hashchange', () => {
  navDepth++;
  if (sheetIsOpen()) closeSheet(true);
  render({ scrollTop: true });
});

function render({ scrollTop = false } = {}) {
  const route = parseRoute();
  const sameRoute = currentRoute && currentRoute.key === route.key;
  const scrollY = window.scrollY;

  // Preserve focus & caret in text inputs across re-renders.
  const active = document.activeElement;
  const focusId = active && active.id && app.contains(active) ? active.id : null;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  let html;
  let wire = () => {};
  const rerender = () => render();
  switch (route.name) {
    case 'calendar':
      html = V.renderCalendar();
      wire = () => V.wireCalendar(app, rerender);
      break;
    case 'artists':
      html = V.renderArtists();
      break;
    case 'discover':
      html = M.renderDiscover();
      wire = () => M.wireDiscover(app, rerender);
      break;
    case 'place':
      html = M.renderPlace(route.id);
      wire = () => M.wirePlace(app, route.id, go);
      break;
    case 'import':
      if (route.params.get('artists')) {
        M.setImportCandidates(M.parseArtistText(route.params.get('artists')), 'Link');
        history.replaceState(null, '', '#/import');
      }
      html = M.renderImport();
      wire = () => M.wireImport(app, rerender);
      break;
    case 'stats':
      html = M.renderStats();
      wire = () => M.wireStats(app, rerender);
      break;
    case 'tonight':
      html = M.renderTonight(route.id);
      wire = () => M.wireTonight(app, route.id);
      break;
    case 'artist':
      html = V.renderArtist(route.id);
      break;
    case 'event':
      html = V.renderEvent(route.id);
      wire = () => V.wireEvent(app, route.id, rerender, go);
      break;
    case 'settings':
      html = V.renderSettings();
      wire = () => V.wireSettings(app, rerender);
      break;
    case 'shows':
    default:
      html = V.renderShows();
      wire = () => V.wireShows(app, rerender);
  }
  app.innerHTML = html;
  wire();

  const tab = { artist: 'artists', event: 'shows', import: 'artists', place: 'discover', stats: 'calendar', tonight: 'shows' }[route.name] || route.name;
  $$('.tabbar .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  updateBadge();

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* type=number */ }
    }
  }
  if (scrollTop && !sameRoute) window.scrollTo(0, 0);
  else window.scrollTo(0, scrollY);

  if (route.name === 'artists' && route.params.get('add') === '1') {
    history.replaceState(null, '', '#/artists');
    currentRoute = { ...route, key: 'artists' };
    V.openAddArtist();
    return;
  }
  currentRoute = route;
}

function updateBadge() {
  const today = todayStr();
  const n = Object.values(getState().events).filter((e) => e.isNew && e.artistIds?.length && !e.mine?.hidden && (!e.date || e.date >= today)).length;
  const b = $('#badge-shows');
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : String(n);
  try {
    if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge();
  } catch { /* unsupported */ }
}

// Re-render whenever data changes (unless a sheet is open — it'll render on close).
let pendingRender = false;
subscribe((st) => {
  applyTheme();
  if (syncEnabled() && st.updatedAt > (st.settings.sync?.base || 0)) scheduleSync();
  if (pendingRender) return;
  pendingRender = true;
  requestAnimationFrame(() => {
    pendingRender = false;
    render();
  });
  const err = lastSaveError();
  if (err) toast('Storage is full — export a backup and remove some artists.', { error: true, ms: 5000 });
});

// ---------------- Global click actions ----------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const route = parseRoute();
  switch (action) {
    case 'back':
      if (navDepth > 0 && history.length > 1) history.back();
      else go({ event: '#/shows', tonight: '#/shows', place: '#/discover', stats: '#/calendar' }[route.name] || '#/artists', true);
      break;
    case 'refresh':
      doRefresh({ artistId: route.name === 'artist' ? route.id : null, placeId: route.name === 'place' ? route.id : null, manual: true });
      break;
    case 'add-place':
      M.openAddPlace(el.dataset.kind || 'venue');
      break;
    case 'add-artist':
      V.openAddArtist();
      break;
    case 'artist-sort': {
      const order = ['name', 'next', 'recent'];
      V.ui.artistSort = order[(order.indexOf(V.ui.artistSort) + 1) % order.length];
      render();
      break;
    }
    case 'add-show':
      V.openShowForm({ artistId: el.dataset.artist || (route.name === 'artist' ? route.id : null), status: route.name === 'stats' ? 'going' : '' });
      break;
    case 'edit-show':
      V.openShowForm({ eventId: route.id });
      break;
    case 'delete-show':
      V.deleteShow(route.id, go);
      break;
    case 'relink-artist':
      V.relinkArtist(el.dataset.id);
      break;
    case 'rename-artist':
      V.renameArtist(el.dataset.id);
      break;
    case 'remove-artist':
      V.removeArtist(el.dataset.id, go);
      break;
    case 'dismiss-install':
      update((s) => { s.installHintDismissed = true; });
      break;
    case 'mark-seen':
      update((s) => { for (const ev of Object.values(s.events)) ev.isNew = false; });
      break;
    case 'toggle-past':
      V.ui.showPast = !V.ui.showPast;
      render();
      break;
    case 'log-price':
      V.logPrice(route.id);
      break;
    case 'share-event':
      V.shareEvent(route.id);
      break;
    case 'ics': {
      const ev = getState().events[route.id];
      if (ev) V.exportICS([ev], `${(ev.name || 'concert').replace(/[^\w-]+/g, '-').slice(0, 40)}.ics`);
      break;
    }
    case 'export-mine-ics':
    case 'export-all-ics': {
      const evs = V.myUpcoming().filter((x) => (action === 'export-mine-ics' ? ['going', 'tickets'] : ['interested', 'going', 'tickets']).includes(x.mine?.status));
      V.exportICS(evs, 'encore-shows.ics');
      break;
    }
    case 'toggle-hide':
      update((s) => {
        const ev = s.events[route.id];
        if (ev) V.touchMine(ev).hidden = !ev.mine?.hidden;
      });
      break;
    case 'cal-prev':
      V.shiftMonth(-1, render);
      break;
    case 'cal-next':
      V.shiftMonth(1, render);
      break;
    case 'cal-today': {
      const d = new Date();
      V.ui.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      V.ui.calSelected = todayStr();
      render();
      break;
    }
    case 'cal-clear':
      V.ui.calSelected = null;
      render();
      break;
    case 'export':
      V.exportBackup();
      break;
    case 'reset':
      V.resetData();
      break;
    default:
      break;
  }
});

// ---------------- Refresh ----------------
async function doRefresh({ artistId = null, placeId = null, manual = false } = {}) {
  const s = getState();
  if (!s.settings.tmKey && !s.settings.bitAppId && !s.settings.sgClientId) {
    if (manual) toast('Add a Ticketmaster API key in Settings to fetch shows.', { ms: 3500 });
    return;
  }
  if (!s.artists.length && !s.places?.length) {
    if (manual) toast('Add an artist first');
    return;
  }
  if (isRefreshing()) return;
  if (navigator.onLine === false) {
    if (manual) toast('You are offline', { error: true });
    return;
  }
  V.ui.refreshProgress = { done: 0, total: artistId || placeId ? 1 : s.artists.length + (s.settings.tmKey ? s.places.length : 0), name: '' };
  render();
  try {
    const res = await refresh({
      artistId,
      placeId,
      onProgress: (done, total, name) => {
        V.ui.refreshProgress = { done, total, name };
        const bar = $('.progress > div');
        const line = $('.status-line');
        if (bar) bar.style.width = `${Math.max(5, Math.round((done / Math.max(1, total)) * 100))}%`;
        if (line && name) line.innerHTML = `<span>Checking ${name.replace(/[<&]/g, '')}</span><span>${done}/${total}</span>`;
      },
    });
    const bits = [];
    if (res.newShows.length) bits.push(`${res.newShows.length} new show${res.newShows.length > 1 ? 's' : ''}`);
    if (res.priceDrops.length) bits.push(`${res.priceDrops.length} price drop${res.priceDrops.length > 1 ? 's' : ''}`);
    if (res.alerts.length) bits.push(`${res.alerts.length} under target 🎯`);
    if (res.statusChanges.length) bits.push(`${res.statusChanges.length} status change${res.statusChanges.length > 1 ? 's' : ''}`);
    if (res.errors.length && !res.checked) toast(res.errors[0], { error: true, ms: 4500 });
    else if (bits.length) toast(bits.join(' · '), { ms: 3500 });
    else if (manual) toast(res.errors.length ? `Updated, with ${res.errors.length} error${res.errors.length > 1 ? 's' : ''}` : 'Up to date');
  } catch (e) {
    toast(e.message || 'Refresh failed', { error: true });
  } finally {
    V.ui.refreshProgress = null;
    render();
  }
}

window.addEventListener('encore:refresh', (e) => doRefresh({ artistId: e.detail?.artistId || null, placeId: e.detail?.placeId || null }));

function autoRefreshIfStale() {
  const s = getState();
  const hours = +s.settings.autoRefreshHours;
  if (!hours || (!s.artists.length && !s.places?.length)) return;
  if (Date.now() - (s.lastRefresh || 0) > hours * 3600000) doRefresh();
}

async function syncThenRefresh() {
  if (syncEnabled()) {
    try { await syncNow(); } catch (e) { console.warn('Sync failed', e); }
  }
  autoRefreshIfStale();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    syncThenRefresh();
    render();
  } else if (syncEnabled() && getState().updatedAt > getState().settings.sync.base) {
    syncNow().catch(() => {});
  }
});
window.addEventListener('online', () => autoRefreshIfStale());

// ---------------- Pull to refresh ----------------
(function pullToRefresh() {
  const ptr = $('#ptr');
  let startY = null;
  let dy = 0;
  const threshold = 70;
  const routeOk = () => ['shows', 'artist', 'artists', 'calendar', 'discover', 'place'].includes(parseRoute().name);
  window.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0 || sheetIsOpen() || !routeOk() || isRefreshing()) { startY = null; return; }
    startY = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    dy = e.touches[0].clientY - startY;
    if (dy <= 0) { ptr.style.opacity = 0; return; }
    const pull = Math.min(dy, 120);
    ptr.style.transition = 'none';
    ptr.style.opacity = Math.min(1, pull / threshold);
    ptr.style.transform = `translateY(${pull * 0.6}px) rotate(${pull * 3}deg)`;
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (startY == null) return;
    startY = null;
    ptr.style.transition = 'transform 0.25s, opacity 0.25s';
    if (dy > threshold) {
      haptic();
      ptr.classList.add('loading');
      ptr.style.transform = 'translateY(36px)';
      const r = parseRoute();
      await doRefresh({ artistId: r.name === 'artist' ? r.id : null, placeId: r.name === 'place' ? r.id : null, manual: true });
      ptr.classList.remove('loading');
    }
    ptr.style.transform = 'translateY(-60px)';
    ptr.style.opacity = 0;
  });
})();

// ---------------- Theme ----------------
function applyTheme() {
  const t = getState().settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  $$('meta[name="theme-color"]').forEach((m) => {
    m.setAttribute('content', dark ? '#0e0d12' : '#f6f5f8');
    m.removeAttribute('media');
  });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

// ---------------- Service worker ----------------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Encore updated — reopen to use the new version.', { ms: 4000 });
          }
        });
      });
    } catch (e) {
      console.warn('SW registration failed', e);
    }
  });
}

// Tapping a background-alert notification while the app is open.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open' && e.data.url) location.hash = e.data.url.replace(/^.*#/, '#');
});

// ---------------- Boot ----------------
applyTheme();
render();
if (isStandalone()) requestPersistence();
handleSpotifyRedirect().then((r) => {
  if (!r) return;
  M.setImportCandidates(r.artists, 'Spotify', { handoff: r.handoff });
  location.hash = '#/import';
  render();
  toast(`Found ${r.artists.length} artists on Spotify`);
}).catch((e) => {
  location.hash = '#/import';
  toast(e.message, { error: true, ms: 4500 });
});
setTimeout(syncThenRefresh, 600);
