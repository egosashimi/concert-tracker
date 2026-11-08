// Additional screens: Discover (venues, areas, suggestions), Place, Import, Stats & year in review,
// Show-day view, ticket wallet, and the Sync & background alerts settings section.

import { getState, update } from './store.js';
import { tmSearchArtists, tmSearchVenues, tmGenreEventsNear, geocodeCity } from './api.js';
import { lowestKnownPrice } from './refresh.js';
import {
  esc, uid, debounce, fmtDate, fmtTime, fmtMoney, timeAgo, placeLine, fmtDistance, distanceMi, todayStr,
  parseLocalDate, daysUntil, normalizeName, shareOrDownload, fmtBytes, isStandalone,
} from './util.js';
import {
  icon, toast, openSheet, confirmSheet, showCard, avatar, groupByMonth, sortEvents, eventTitle, isCancelled,
} from './ui.js';
import {
  header, backBtn, refreshButton, progressBar, upcomingEvents, isMyShow, addArtist, touchMine, ui, openShowForm,
} from './views.js';
import { putFile, getFile, deleteFile, shrinkImage } from './files.js';
import {
  getToken, connect, disconnect, syncNow, syncEnabled, enablePush, disablePush, pushSupported, hostingRepo,
} from './sync.js';
import { startSpotifyLogin, redirectUri } from './spotify.js';

const refreshEvt = (detail = {}) => window.dispatchEvent(new CustomEvent('encore:refresh', { detail }));
const copy = async (text, what = 'Copied') => {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Couldn’t copy — select and copy it manually', { error: true }); }
};

// =====================================================================
// Discover
// =====================================================================
const more = { placeFilter: 'all', limit: 40, suggest: null, suggestLoading: false, suggestError: '' };

export function renderDiscover() {
  const s = getState();
  const places = s.places || [];
  const today = todayStr();
  const evs = sortEvents(Object.values(s.events).filter((e) => e.placeIds?.length && (!e.date || e.date >= today) && !e.mine?.hidden));
  if (more.placeFilter !== 'all' && !places.find((p) => p.id === more.placeFilter)) more.placeFilter = 'all';
  const shown = more.placeFilter === 'all' ? evs : evs.filter((e) => e.placeIds.includes(more.placeFilter));
  const limited = shown.slice(0, more.limit);

  const placeChips = places.length ? `<div class="chips">
      <button class="chip ${more.placeFilter === 'all' ? 'active' : ''}" data-place-filter="all">All<span class="count">${evs.length}</span></button>
      ${places.map((p) => `<button class="chip ${more.placeFilter === p.id ? 'active' : ''}" data-place-filter="${esc(p.id)}">${esc(p.name)}<span class="count">${evs.filter((e) => e.placeIds.includes(p.id)).length}</span></button>`).join('')}
    </div>` : '';

  return `
    ${header({
      title: 'Discover',
      sub: places.length ? `Following ${places.length} venue${places.length === 1 ? '' : 's'} & area${places.length === 1 ? '' : 's'}` : '',
      right: `<button class="icon-btn" data-action="add-place" aria-label="Follow a venue or area">${icon('plus')}</button>${places.length ? refreshButton() : ''}`,
    })}
    ${progressBar()}
    ${!s.settings.tmKey ? `<a class="banner" href="#/settings">${icon('key')}<div class="grow"><b>Needs a Ticketmaster key</b><p>Discover uses Ticketmaster to find shows at venues and near you. Add a free key in Settings.</p></div></a>` : ''}

    <div class="section-title"><span>Suggested artists</span>${s.settings.tmKey && s.settings.home ? '<button class="btn sm" data-action="refresh-suggest">Refresh</button>' : ''}</div>
    <div id="suggestions">${renderSuggestions()}</div>

    <div class="section-title"><span>Venues & areas</span>${places.length ? `<a href="#/place/${esc(more.placeFilter !== 'all' ? more.placeFilter : places[0].id)}">Manage</a>` : ''}</div>
    ${places.length ? placeChips : `<div class="card pad stack">
        <p class="small muted" style="margin:0">Follow your favorite venues or your whole area to see every concert coming up — not just your artists.</p>
        <div class="btn-grid">
          <button class="btn sm" data-action="add-place" data-kind="venue">${icon('building')}Follow a venue</button>
          <button class="btn sm" data-action="add-place" data-kind="area">${icon('pin')}Follow an area</button>
        </div>
      </div>`}
    ${limited.length ? groupByMonth(limited).map((g) => `<div class="month-title">${esc(g.label)}</div><div class="shows">${g.events.map((e) => showCard(e)).join('')}</div>`).join('')
      : places.length ? `<div class="empty" style="padding:24px"><p>${places.some((p) => p.lastChecked) ? 'No upcoming shows found.' : 'Pull down or tap refresh to load shows.'}</p></div>` : ''}
    ${shown.length > limited.length ? `<button class="btn block" style="margin-top:12px" data-action="more-discover">Show more (${shown.length - limited.length})</button>` : ''}
  `;
}

export function wireDiscover(root, rerender) {
  root.querySelectorAll('[data-place-filter]').forEach((b) => b.addEventListener('click', () => {
    more.placeFilter = b.dataset.placeFilter;
    more.limit = 40;
    rerender();
  }));
  root.querySelector('[data-action="more-discover"]')?.addEventListener('click', () => { more.limit += 60; rerender(); });
  root.querySelector('[data-action="refresh-suggest"]')?.addEventListener('click', () => { more.suggest = null; loadSuggestions(rerender, true); });
  wireSuggestions(root, rerender);
  loadSuggestions(rerender);
}

function followedTmIds() {
  return new Set(getState().artists.map((a) => a.tmId).filter(Boolean));
}

/** Artists sharing a bill with ones you follow — free, from data we already have. */
function coBillSuggestions() {
  const s = getState();
  const followed = followedTmIds();
  const followedNames = new Set(s.artists.map((a) => normalizeName(a.name)));
  const dismissed = s.hiddenSuggestions || {};
  const map = new Map();
  for (const ev of sortEvents(upcomingEvents().filter((e) => e.artistIds?.length && !isCancelled(e)))) {
    for (const a of ev.attractions || []) {
      if (!a.tmId || followed.has(a.tmId) || followedNames.has(normalizeName(a.name)) || dismissed[a.tmId]) continue;
      const host = s.artists.find((x) => ev.artistIds.includes(x.id));
      const prev = map.get(a.tmId);
      if (prev) { prev.score++; continue; }
      map.set(a.tmId, { ...a, score: 2, reason: `Playing with ${host?.name || 'an artist you follow'}`, next: ev });
    }
  }
  return [...map.values()];
}

function renderSuggestions() {
  const s = getState();
  if (!s.artists.length) return '<div class="card pad small muted">Follow a few artists and Encore will suggest similar ones playing near you.</div>';
  const items = mergeSuggestions();
  let note = '';
  if (!s.settings.tmKey) note = '';
  else if (!s.settings.home) note = '<p class="help">Set a home location in Settings to get genre-based suggestions near you.</p>';
  else if (more.suggestLoading) note = '<div class="loading-row"><span class="spinner"></span></div>';
  else if (more.suggestError) note = `<p class="help" style="color:var(--bad)">${esc(more.suggestError)}</p>`;
  if (!items.length) return `${note}${more.suggestLoading ? '' : '<div class="card pad small muted">No suggestions yet. They come from artists sharing bills with yours and from shows near you in your genres.</div>'}`;
  return `<div class="list">${items.slice(0, 12).map((a) => `
    <div class="row" data-suggest="${esc(a.tmId)}">
      ${avatar(a)}
      <div class="grow">
        <div class="title">${esc(a.name)}</div>
        <div class="subtitle">${esc(a.reason)}</div>
        ${a.next ? `<div class="subtitle">${esc(fmtDate(a.next.date, { month: 'short', day: 'numeric' }))} · ${esc(a.next.venue?.name || '')}${a.next.venue?.city ? `, ${esc(a.next.venue.city)}` : ''}</div>` : ''}
      </div>
      <button class="btn sm primary" data-follow="${esc(a.tmId)}">Follow</button>
      <button class="icon-btn ghost" data-dismiss="${esc(a.tmId)}" aria-label="Not interested" style="width:30px;height:30px">${icon('close')}</button>
    </div>`).join('')}</div>${note}`;
}

function mergeSuggestions() {
  const dismissed = getState().hiddenSuggestions || {};
  const followed = followedTmIds();
  const map = new Map();
  for (const a of [...coBillSuggestions(), ...(more.suggest?.items || [])]) {
    if (followed.has(a.tmId) || dismissed[a.tmId]) continue;
    const prev = map.get(a.tmId);
    if (prev) { prev.score += a.score; continue; }
    map.set(a.tmId, { ...a });
  }
  return [...map.values()].sort((x, y) => y.score - x.score || String(x.next?.date || '9').localeCompare(String(y.next?.date || '9')));
}

async function loadSuggestions(rerender, force = false) {
  const s = getState();
  if (!s.settings.tmKey || !s.settings.home || !s.artists.length || more.suggestLoading) return;
  if (!force && more.suggest && Date.now() - more.suggest.t < 6 * 3600000) return;
  const counts = new Map();
  const gCounts = new Map();
  const names = new Map();
  for (const a of s.artists) {
    for (const g of a.subGenreIds || []) counts.set(g, (counts.get(g) || 0) + 1);
    for (const g of a.genreIds || []) gCounts.set(g, (gCounts.get(g) || 0) + 1);
  }
  for (const ev of Object.values(s.events)) {
    for (const at of ev.attractions || []) {
      if (at.subGenreId) names.set(at.subGenreId, at.subGenre);
      if (at.genreId) names.set(at.genreId, at.genre);
    }
  }
  const subGenreIds = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 8);
  const genreIds = [...gCounts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 5);
  if (!subGenreIds.length && !genreIds.length) {
    more.suggest = { t: Date.now(), items: [] };
    return;
  }
  more.suggestLoading = true;
  more.suggestError = '';
  rerenderSuggestions(rerender);
  try {
    const evs = await tmGenreEventsNear({ lat: s.settings.home.lat, lon: s.settings.home.lon, radius: Math.max(50, s.settings.radius), subGenreIds, genreIds }, s.settings.tmKey);
    const followed = followedTmIds();
    const map = new Map();
    for (const ev of evs) {
      for (const [i, a] of (ev.attractions || []).entries()) {
        if (!a.tmId || followed.has(a.tmId)) continue;
        const matchSub = subGenreIds.includes(a.subGenreId);
        const matchGenre = genreIds.includes(a.genreId);
        if (!matchSub && !matchGenre) continue;
        const prev = map.get(a.tmId);
        if (prev) { prev.score += 0.5; continue; }
        map.set(a.tmId, {
          ...a,
          score: (matchSub ? 1.5 : 1) + (i === 0 ? 0.5 : 0),
          reason: `Because you like ${names.get(matchSub ? a.subGenreId : a.genreId) || a.subGenre || a.genre}`,
          next: ev,
        });
      }
    }
    more.suggest = { t: Date.now(), items: [...map.values()] };
  } catch (e) {
    more.suggestError = e.message;
    more.suggest = { t: Date.now(), items: [] };
  } finally {
    more.suggestLoading = false;
    rerenderSuggestions(rerender);
  }
}

function rerenderSuggestions(rerender) {
  const el = document.getElementById('suggestions');
  if (!el) return;
  el.innerHTML = renderSuggestions();
  wireSuggestions(el.parentElement, rerender);
}

function wireSuggestions(root, rerender) {
  const items = () => mergeSuggestions();
  root.querySelectorAll('[data-follow]').forEach((b) => b.addEventListener('click', () => {
    const a = items().find((x) => x.tmId === b.dataset.follow);
    if (!a) return;
    addArtist({ name: a.name, tmId: a.tmId, image: a.image, genre: [a.genre, a.subGenre].filter(Boolean).join(' · '), genreId: a.genreId, subGenreId: a.subGenreId });
  }));
  root.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', () => {
    update((st) => { st.hiddenSuggestions = { ...(st.hiddenSuggestions || {}), [b.dataset.dismiss]: Date.now() }; });
  }));
}

// ---------------- Follow a venue / area ----------------
export function openAddPlace(kind = 'venue') {
  const s = getState();
  let mode = kind;
  const draw = (body, close) => {
    body.innerHTML = `
      <div class="segmented" style="margin-bottom:12px">
        <button class="${mode === 'venue' ? 'active' : ''}" data-mode="venue">${icon('building')}Venue</button>
        <button class="${mode === 'area' ? 'active' : ''}" data-mode="area">${icon('pin')}Area</button>
      </div>
      ${mode === 'venue' ? `
        <div class="search">${icon('search')}<input id="pl-q" class="input" type="search" placeholder="Search venues (e.g. Red Rocks)" autocomplete="off"></div>
        ${s.settings.tmKey ? '' : '<p class="help">Needs a Ticketmaster key — add one in Settings.</p>'}
        <div id="pl-results" style="margin-top:12px"></div>` : `
        <p class="help" style="margin:0 4px 10px">Every concert within a radius of a city — great for discovering shows nearby.</p>
        ${s.settings.home ? `<button class="row card" data-home style="margin-bottom:10px">${icon('home', 'chev')}<div class="grow"><div class="title">Around ${esc(s.settings.home.label)}</div><div class="subtitle">Your home location</div></div></button>` : ''}
        <div class="search">${icon('search')}<input id="pl-city" class="input" type="search" placeholder="Search a city" autocomplete="off"></div>
        <div id="pl-cities" style="margin-top:8px"></div>
        <label class="field" style="margin-top:12px"><span>Radius: <b id="pl-r">25 mi</b></span><input type="range" class="range" id="pl-radius" min="5" max="150" step="5" value="25"></label>`}`;
    body.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; draw(body, close); }));
    const follow = (place) => {
      const dup = (getState().places || []).find((p) => (place.tmVenueId && p.tmVenueId === place.tmVenueId) || (p.kind === 'area' && place.kind === 'area' && distanceMi(p, place) < 3));
      if (dup) { toast(`Already following ${dup.name}`); return; }
      const rec = { id: uid('p'), addedAt: Date.now(), lastChecked: 0, ...place };
      update((st) => { st.places = [...(st.places || []), rec]; });
      toast(`Following ${rec.name}`);
      close();
      refreshEvt({ placeId: rec.id });
    };
    if (mode === 'venue') {
      const input = body.querySelector('#pl-q');
      const out = body.querySelector('#pl-results');
      setTimeout(() => input.focus(), 320);
      input.addEventListener('input', debounce(async () => {
        const q = input.value.trim();
        if (!q || !getState().settings.tmKey) { out.innerHTML = ''; return; }
        out.innerHTML = '<div class="loading-row"><span class="spinner"></span></div>';
        try {
          const r = await tmSearchVenues(q, getState().settings.tmKey, getState().settings.countryCode);
          out.innerHTML = r.length ? `<div class="list">${r.map((v, i) => `<button class="row" data-v="${i}"><div class="avatar">${icon('building')}</div><div class="grow"><div class="title">${esc(v.name)}</div><div class="subtitle">${esc([placeLine(v), v.upcoming ? `${v.upcoming} upcoming` : ''].filter(Boolean).join(' · '))}</div></div></button>`).join('')}</div>` : '<p class="help">No venues found.</p>';
          out.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
            const v = r[+b.dataset.v];
            follow({ kind: 'venue', name: v.name, tmVenueId: v.tmVenueId, city: v.city, region: v.region, lat: v.lat, lon: v.lon });
          }));
        } catch (e) {
          out.innerHTML = `<p class="help" style="color:var(--bad)">${esc(e.message)}</p>`;
        }
      }, 350));
    } else {
      const radius = body.querySelector('#pl-radius');
      radius.addEventListener('input', () => { body.querySelector('#pl-r').textContent = `${radius.value} mi`; });
      body.querySelector('[data-home]')?.addEventListener('click', () => {
        const h = getState().settings.home;
        follow({ kind: 'area', name: h.label.split(',')[0], lat: h.lat, lon: h.lon, radius: +radius.value });
      });
      const ci = body.querySelector('#pl-city');
      const co = body.querySelector('#pl-cities');
      ci.addEventListener('input', debounce(async () => {
        const q = ci.value.trim();
        if (q.length < 2) { co.innerHTML = ''; return; }
        try {
          const r = await geocodeCity(q);
          co.innerHTML = r.length ? `<div class="list">${r.map((c, i) => `<button class="row" data-c="${i}"><div class="grow">${esc(c.label)}</div></button>`).join('')}</div>` : '<p class="help">No matches.</p>';
          co.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => {
            const c = r[+b.dataset.c];
            follow({ kind: 'area', name: c.label.split(',')[0], lat: c.lat, lon: c.lon, radius: +radius.value });
          }));
        } catch (e) {
          co.innerHTML = `<p class="help" style="color:var(--bad)">${esc(e.message)}</p>`;
        }
      }, 350));
    }
  };
  openSheet({ title: 'Follow', body: '', onMount: draw });
}

// ---------------- Place detail ----------------
export function renderPlace(id) {
  const s = getState();
  const p = (s.places || []).find((x) => x.id === id);
  if (!p) return `${header({ title: '', small: true, left: backBtn() })}<div class="empty"><h2>Not found</h2></div>`;
  const evs = sortEvents(upcomingEvents().filter((e) => e.placeIds?.includes(p.id)));
  return `
    ${header({ title: p.name, small: true, left: backBtn(), right: refreshButton() })}
    ${progressBar()}
    <div class="center" style="margin-top:16px">
      <div class="avatar lg" style="margin:0 auto">${icon(p.kind === 'venue' ? 'building' : 'pin')}</div>
      <h2 style="margin:12px 0 2px;font-size:24px">${esc(p.name)}</h2>
      <div class="muted small">${esc(p.kind === 'venue' ? ['Venue', placeLine(p)].filter(Boolean).join(' · ') : `Area · within ${p.radius} mi`)}${p.lastChecked ? ` · checked ${esc(timeAgo(p.lastChecked))}` : ''}</div>
      ${p.lastError ? `<div class="small" style="color:var(--bad)">${esc(p.lastError)}</div>` : ''}
    </div>
    ${p.kind === 'area' ? `<div class="card pad" style="margin-top:16px"><label class="field"><span>Radius: <b id="pr-val">${p.radius} mi</b></span><input type="range" class="range" id="pr-radius" min="5" max="150" step="5" value="${p.radius}"></label></div>` : ''}
    <div class="section-title"><span>Upcoming (${evs.length})</span></div>
    ${evs.length ? `<div class="shows">${evs.map((e) => showCard(e)).join('')}</div>` : '<div class="card pad small muted">No upcoming concerts found yet.</div>'}
    <div class="section-title"><span>Manage</span></div>
    <div class="list"><button class="row danger" data-action="unfollow-place" data-id="${esc(p.id)}"><div class="grow">Unfollow</div></button></div>
  `;
}

export function wirePlace(root, id, go) {
  const r = root.querySelector('#pr-radius');
  r?.addEventListener('input', () => { root.querySelector('#pr-val').textContent = `${r.value} mi`; });
  r?.addEventListener('change', () => {
    update((st) => { const p = st.places.find((x) => x.id === id); if (p) p.radius = +r.value; });
    refreshEvt({ placeId: id });
  });
  root.querySelector('[data-action="unfollow-place"]')?.addEventListener('click', async () => {
    const p = getState().places.find((x) => x.id === id);
    if (!p || !(await confirmSheet({ title: `Unfollow ${p.name}?`, message: 'Its shows are removed unless you marked them.', confirm: 'Unfollow', danger: true }))) return;
    update((st) => {
      st.places = st.places.filter((x) => x.id !== id);
      st.deleted.places[id] = Date.now();
      for (const [eid, ev] of Object.entries(st.events)) {
        if (!ev.placeIds?.includes(id)) continue;
        ev.placeIds = ev.placeIds.filter((x) => x !== id);
        if (!ev.placeIds.length && !ev.artistIds?.length && !ev.mine?.status) delete st.events[eid];
      }
    });
    go('#/discover', true);
  });
}

// =====================================================================
// Import artists
// =====================================================================
export const importState = { candidates: [], selected: new Set(), source: '', handoff: false, busy: '' };

export function setImportCandidates(list, source, { handoff = false } = {}) {
  const followed = new Set(getState().artists.map((a) => normalizeName(a.name)));
  const seen = new Set();
  importState.candidates = list.filter((c) => {
    const k = normalizeName(c.name);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((c) => ({ ...c, following: followed.has(normalizeName(c.name)) }));
  importState.selected = new Set(importState.candidates.filter((c) => !c.following).map((c) => normalizeName(c.name)));
  importState.source = source;
  importState.handoff = handoff;
}

export function parseArtistText(text) {
  let lines = String(text || '').split(/\r?\n/).map((x) => x.replace(/^[\s•*\-\d.)]+/, '').trim()).filter(Boolean);
  if (lines.length === 1 && lines[0].includes(',')) lines = lines[0].split(',').map((x) => x.trim()).filter(Boolean);
  return lines.filter((x) => x.length < 120).map((name) => ({ name }));
}

export function renderImport() {
  const s = getState();
  const c = importState.candidates;
  const sel = importState.selected;
  return `
    ${header({ title: 'Import artists', small: true, left: backBtn() })}
    ${importState.handoff ? `<div class="banner warn">${icon('info')}<div class="grow"><b>Finish in the Encore app</b><p>iOS opened Spotify login in a separate browser, which can’t see your Encore data. Copy the list, open Encore from your Home Screen, then go to Artists → Import → Paste.</p>
      <button class="btn sm" style="margin-top:8px" data-action="copy-import">Copy ${c.length} artists</button></div></div>` : ''}
    ${c.length ? `
      <div class="section-title"><span>${c.length} found${importState.source ? ` · ${esc(importState.source)}` : ''}</span>
        <span class="hstack"><button class="btn sm" data-sel="all">All</button><button class="btn sm" data-sel="none">None</button></span></div>
      <div class="list">
        ${c.map((a) => {
          const k = normalizeName(a.name);
          return `<label class="row" style="cursor:pointer">
            <input type="checkbox" class="check" data-k="${esc(k)}" ${sel.has(k) ? 'checked' : ''} ${a.following ? 'disabled' : ''}>
            ${avatar(a)}
            <div class="grow"><div class="title">${esc(a.name)}</div>
            <div class="subtitle">${a.following ? 'Already following' : esc([a.why?.join(' · '), a.genre].filter(Boolean).join(' · '))}</div></div>
          </label>`;
        }).join('')}
      </div>
      <div class="sticky-cta"><button class="btn primary block" data-action="import-selected" ${sel.size && !importState.busy ? '' : 'disabled'}>${importState.busy ? esc(importState.busy) : `Follow ${sel.size} artist${sel.size === 1 ? '' : 's'}`}</button></div>
    ` : ''}

    <div class="section-title"><span>Spotify</span></div>
    <div class="card pad stack">
      <p class="small muted" style="margin:0">Pull in the artists you follow and your top artists.</p>
      <label class="field"><span>Spotify Client ID</span><input class="input" id="sp-client" value="${esc(s.settings.spotifyClientId)}" placeholder="From your Spotify developer app" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <button class="btn primary" data-action="spotify-connect">Connect Spotify</button>
      <details ${s.settings.spotifyClientId ? '' : 'open'}>
        <summary class="small" style="font-weight:650">One-time setup (free)</summary>
        <ol class="steps">
          <li>Open the <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Spotify developer dashboard</a> and tap <b>Create app</b>.</li>
          <li>Any name/description. For <b>Redirect URI</b> add exactly:<br><code style="word-break:break-all">${esc(redirectUri())}</code> <button class="btn sm" data-action="copy-redirect" style="margin-top:4px">Copy</button></li>
          <li>Tick <b>Web API</b>, save, then copy the <b>Client ID</b> into the box above.</li>
        </ol>
        <p class="help">Encore asks only to read who you follow and your top artists. Nothing is posted.</p>
      </details>
    </div>

    <div class="section-title"><span>Apple Music</span></div>
    <div class="card pad stack">
      <p class="small muted" style="margin:0">Apple doesn’t let web apps read your library directly, but a 30-second Shortcut can copy your most-played artists:</p>
      <ol class="steps">
        <li>In <b>Shortcuts</b>, create a new shortcut and add <b>Find Music</b> — sort by <i>Play Count</i>, <i>Biggest First</i>, limit <i>300</i>.</li>
        <li>Add <b>Get Details of Music</b> → <i>Artist</i>.</li>
        <li>Add <b>Combine Text</b> with <i>New Lines</i>, then <b>Copy to Clipboard</b>.</li>
        <li>Run it, then tap <b>Paste</b> below. Duplicates are removed automatically.</li>
      </ol>
      <button class="btn" data-action="paste-import">${icon('download')}Paste from clipboard</button>
    </div>

    <div class="section-title"><span>Paste a list</span></div>
    <div class="card pad stack">
      <textarea class="input" id="imp-text" rows="5" placeholder="One artist per line"></textarea>
      <button class="btn" data-action="review-import">Review list</button>
    </div>
  `;
}

export function wireImport(root, rerender) {
  root.querySelectorAll('.check').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) importState.selected.add(cb.dataset.k);
    else importState.selected.delete(cb.dataset.k);
    const btn = root.querySelector('[data-action="import-selected"]');
    const n = importState.selected.size;
    if (btn) { btn.textContent = `Follow ${n} artist${n === 1 ? '' : 's'}`; btn.disabled = !n; }
  }));
  root.querySelectorAll('[data-sel]').forEach((b) => b.addEventListener('click', () => {
    importState.selected = new Set(b.dataset.sel === 'all' ? importState.candidates.filter((c) => !c.following).map((c) => normalizeName(c.name)) : []);
    rerender();
  }));
  const spInput = root.querySelector('#sp-client');
  spInput?.addEventListener('change', () => update((st) => { st.settings.spotifyClientId = spInput.value.trim(); }, { silent: true }));
  root.querySelector('[data-action="spotify-connect"]')?.addEventListener('click', async () => {
    const id = spInput.value.trim();
    update((st) => { st.settings.spotifyClientId = id; }, { silent: true });
    try { await startSpotifyLogin(id); } catch (e) { toast(e.message, { error: true }); }
  });
  root.querySelector('[data-action="copy-redirect"]')?.addEventListener('click', () => copy(redirectUri(), 'Redirect URI copied'));
  root.querySelector('[data-action="copy-import"]')?.addEventListener('click', () => copy(importState.candidates.map((c) => c.name).join('\n'), 'List copied'));
  root.querySelector('[data-action="paste-import"]')?.addEventListener('click', async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* denied */ }
    if (!text) {
      toast('Couldn’t read the clipboard — paste into the box below instead.', { error: true });
      root.querySelector('#imp-text')?.focus();
      return;
    }
    setImportCandidates(parseArtistText(text), 'Clipboard');
    rerender();
    window.scrollTo(0, 0);
  });
  root.querySelector('[data-action="review-import"]')?.addEventListener('click', () => {
    const list = parseArtistText(root.querySelector('#imp-text').value);
    if (!list.length) { toast('Type or paste some artist names'); return; }
    setImportCandidates(list, 'Your list');
    rerender();
    window.scrollTo(0, 0);
  });
  root.querySelector('[data-action="import-selected"]')?.addEventListener('click', () => runImport(rerender));
}

async function runImport(rerender) {
  const picks = importState.candidates.filter((c) => importState.selected.has(normalizeName(c.name)) && !c.following);
  if (!picks.length) return;
  const key = getState().settings.tmKey;
  let added = 0;
  for (const [i, c] of picks.entries()) {
    importState.busy = `Adding ${i + 1} of ${picks.length}…`;
    const btn = document.querySelector('[data-action="import-selected"]');
    if (btn) { btn.textContent = importState.busy; btn.disabled = true; }
    let match = { name: c.name, image: c.image, genre: c.genre };
    if (key) {
      try {
        const found = await tmSearchArtists(c.name, key);
        const exact = found.find((f) => normalizeName(f.name) === normalizeName(c.name));
        if (exact) match = { ...exact, image: exact.image || c.image };
      } catch (e) {
        if (e.fatal) { toast(e.message, { error: true }); break; }
      }
      await new Promise((r) => setTimeout(r, 230));
    }
    if (addArtist(match, { silentRefresh: true, quiet: true })) added++;
  }
  importState.busy = '';
  importState.candidates = [];
  importState.selected = new Set();
  toast(`Following ${added} new artist${added === 1 ? '' : 's'}`);
  location.hash = '#/artists';
  if (added) refreshEvt();
}

// =====================================================================
// Stats & year in review
// =====================================================================
const statsUi = { year: null };

function attendedShows() {
  const today = todayStr();
  return Object.values(getState().events)
    .filter((e) => e.date && e.date < today && ['going', 'tickets'].includes(e.mine?.status) && !isCancelled(e));
}
const spendOf = (e) => (e.mine?.paid != null ? e.mine.paid * (e.mine.qty || 1) : 0);

function topCounts(list, keyFn, n = 5) {
  const m = new Map();
  for (const e of list) {
    for (const k of [].concat(keyFn(e)).filter(Boolean)) m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

function yearStats(list) {
  const home = getState().settings.home;
  const far = home ? list.map((e) => ({ e, d: distanceMi(home, e.venue) })).filter((x) => x.d != null && x.d >= 5).sort((a, b) => b.d - a.d)[0] : null;
  const paidOnes = list.filter((e) => e.mine?.paid != null);
  return {
    count: list.length,
    spent: list.reduce((t, e) => t + spendOf(e), 0),
    avgTicket: paidOnes.length ? paidOnes.reduce((t, e) => t + e.mine.paid, 0) / paidOnes.length : null,
    artists: topCounts(list, (e) => eventTitle(e)),
    venues: topCounts(list, (e) => e.venue?.name),
    cities: topCounts(list, (e) => e.venue?.city, 50),
    farthest: far,
  };
}

export function renderStats() {
  const s = getState();
  const units = s.settings.units;
  const attended = sortEvents(attendedShows()).reverse();
  const upcoming = upcomingEvents().filter((e) => ['going', 'tickets'].includes(e.mine?.status) && !isCancelled(e));
  const thisYear = String(new Date().getFullYear());
  const years = [...new Set(attended.map((e) => e.date.slice(0, 4)))].sort();
  if (!statsUi.year || !years.includes(statsUi.year)) statsUi.year = years.includes(thisYear) ? thisYear : years[years.length - 1] || thisYear;
  const all = yearStats(attended);
  const yr = yearStats(attended.filter((e) => e.date.startsWith(statsUi.year)));
  const cur = attended[0]?.currency || 'USD';

  const tile = (label, val, note = '') => `<div class="fact"><div class="label">${esc(label)}</div><div class="val">${esc(val)}</div>${note ? `<div class="note">${esc(note)}</div>` : ''}</div>`;
  const rank = (title, rows, unit = 'show') => rows.length ? `
    <div class="section-title"><span>${esc(title)}</span></div>
    <div class="list">${rows.map(([k, n], i) => `<div class="row static"><span class="rank">${i + 1}</span><div class="grow"><div class="title">${esc(k)}</div></div><span class="value">${n} ${unit}${n === 1 ? '' : 's'}</span></div>`).join('')}</div>` : '';

  if (!attended.length && !upcoming.length) {
    return `${header({ title: 'Stats', small: true, left: backBtn() })}
      <div class="empty"><div class="art">${icon('chart')}</div><h2>Your concert history</h2>
      <p>Mark shows as <b>Going</b> or <b>Got tickets</b>. After the date passes they count toward your stats and year in review.</p>
      <button class="btn primary" data-action="add-show">${icon('plus')}Add a past show</button></div>`;
  }

  return `
    ${header({ title: 'Stats', small: true, left: backBtn(), right: `<button class="icon-btn" data-action="add-show" aria-label="Add a past show">${icon('plus')}</button>` })}
    <div class="facts">
      ${tile('Shows seen', String(all.count), years.length ? `since ${years[0]}` : '')}
      ${tile(`In ${thisYear}`, String(attended.filter((e) => e.date.startsWith(thisYear)).length))}
      ${tile('Spent on tickets', all.spent ? fmtMoney(Math.round(all.spent), cur) : '—', all.avgTicket != null ? `avg ${fmtMoney(Math.round(all.avgTicket), cur)} a ticket` : 'Add “paid each” on a show')}
      ${(() => { const booked = upcoming.reduce((t, e) => t + spendOf(e), 0); return tile('Coming up', String(upcoming.length), booked ? `${fmtMoney(Math.round(booked), cur)} booked` : ''); })()}
      ${tile('Cities', String(all.cities.length))}
      ${all.farthest ? tile('Farthest trip', fmtDistance(all.farthest.d, units), all.farthest.e.venue?.city || '') : tile('Artists', String(all.artists.length))}
    </div>
    ${years.length ? `<div class="section-title"><span>Shows per year</span></div><div class="card pad">${yearBars(attended, years)}</div>` : ''}
    ${rank('Most-seen artists', all.artists)}
    ${rank('Favorite venues', all.venues, 'visit')}

    ${years.length ? `
    <div class="section-title"><span>Year in review</span></div>
    <div class="chips" style="padding-top:0">${years.map((y) => `<button class="chip ${y === statsUi.year ? 'active' : ''}" data-year="${y}">${y}</button>`).join('')}</div>
    <div class="card pad stack" style="margin-top:8px">
      <div class="hstack" style="justify-content:space-between"><b style="font-size:20px">${statsUi.year}</b><span class="muted small">${yr.count} show${yr.count === 1 ? '' : 's'} · ${esc(fmtMoney(Math.round(yr.spent), cur))}</span></div>
      ${yr.artists[0] ? `<div class="small">Top artist: <b>${esc(yr.artists[0][0])}</b>${yr.artists[0][1] > 1 ? ` (${yr.artists[0][1]}×)` : ''}</div>` : ''}
      ${yr.venues[0] ? `<div class="small">Top venue: <b>${esc(yr.venues[0][0])}</b></div>` : ''}
      <button class="btn primary" data-action="year-image">${icon('share')}Share ${statsUi.year} in review</button>
    </div>` : ''}

    ${attended.length ? `<div class="section-title"><span>Every show (${attended.length})</span></div><div class="shows">${attended.map((e) => showCard(e)).join('')}</div>` : ''}
  `;
}

function yearBars(list, years) {
  const counts = years.map((y) => [y, list.filter((e) => e.date.startsWith(y)).length]);
  const max = Math.max(...counts.map((c) => c[1]), 1);
  const W = 320;
  const H = 140;
  const padB = 22;
  const padT = 18;
  const n = counts.length;
  const slot = (W - 8) / n;
  const bw = Math.min(36, slot * 0.6);
  const bars = counts.map(([y, c], i) => {
    const h = Math.max(2, ((H - padB - padT) * c) / max);
    const x = 4 + slot * i + (slot - bw) / 2;
    const yy = H - padB - h;
    return `<g class="bar" data-tip="${esc(`${y}: ${c} show${c === 1 ? '' : 's'}`)}">
      <rect class="hitbar" x="${(4 + slot * i).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}"/>
      <path class="barfill" d="M${x.toFixed(1)},${H - padB} V${(yy + 4).toFixed(1)} q0,-4 4,-4 H${(x + bw - 4).toFixed(1)} q4,0 4,4 V${H - padB} Z"/>
      ${c === max ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(yy - 5).toFixed(1)}" text-anchor="middle" class="barval">${c}</text>` : ''}
      <text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${y.length > 4 ? y : `’${y.slice(2)}`}</text>
    </g>`;
  }).join('');
  return `<svg class="bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="Shows attended per year">
    <line class="grid" x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}"/>${bars}</svg>
    <div class="spark-tip" data-bar-tip>Tap a bar for the count.</div>`;
}

export function wireStats(root, rerender) {
  root.querySelectorAll('[data-year]').forEach((b) => b.addEventListener('click', () => { statsUi.year = b.dataset.year; rerender(); }));
  const tip = root.querySelector('[data-bar-tip]');
  root.querySelectorAll('.bar').forEach((g) => {
    const showTip = () => { if (tip) tip.textContent = g.dataset.tip; root.querySelectorAll('.bar').forEach((x) => x.classList.toggle('on', x === g)); };
    g.addEventListener('click', showTip);
    g.addEventListener('mouseenter', showTip);
  });
  root.querySelector('[data-action="year-image"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await shareYearImage(statsUi.year); } catch (err) { toast(err.message || 'Couldn’t make the image', { error: true }); }
    btn.disabled = false;
  });
}

async function shareYearImage(year) {
  const list = sortEvents(attendedShows().filter((e) => e.date.startsWith(year)));
  const st = yearStats(list);
  const cur = list[0]?.currency || 'USD';
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#ff4f93');
  grad.addColorStop(1, '#5b2bd6');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, 0, W, H);
  const font = (w, s) => `${w} ${s}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif`;
  g.fillStyle = '#fff';
  g.font = font(700, 44);
  g.fillText('MY YEAR IN CONCERTS', 80, 130);
  g.font = font(800, 200);
  g.fillText(year, 72, 320);
  const stat = (x, y, big, small) => {
    g.font = font(800, 96);
    g.fillText(big, x, y);
    g.font = font(600, 34);
    g.globalAlpha = 0.85;
    g.fillText(small, x, y + 50);
    g.globalAlpha = 1;
  };
  stat(80, 500, String(st.count), st.count === 1 ? 'show' : 'shows');
  stat(560, 500, String(st.cities.length), st.cities.length === 1 ? 'city' : 'cities');
  let y = 660;
  if (st.spent || st.farthest) {
    if (st.spent) stat(80, 680, fmtMoney(Math.round(st.spent), cur), 'on tickets');
    if (st.farthest) stat(st.spent ? 560 : 80, 680, fmtDistance(st.farthest.d, getState().settings.units), 'farthest trip');
    y = 840;
  }
  const line = (label, value) => {
    if (!value) return;
    g.font = font(600, 30);
    g.globalAlpha = 0.8;
    g.fillText(label.toUpperCase(), 80, y);
    g.globalAlpha = 1;
    g.font = font(750, 46);
    g.fillText(fit(g, value, W - 160), 80, y + 54);
    y += 120;
  };
  line('Top artist', st.artists[0]?.[0]);
  line('Top venue', st.venues[0]?.[0]);
  g.font = font(600, 30);
  const shows = list.slice(-4).reverse();
  for (const e of shows) {
    if (y > H - 120) break;
    g.globalAlpha = 0.9;
    g.fillText(fit(g, `${parseLocalDate(e.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${eventTitle(e)} · ${e.venue?.city || ''}`, W - 160), 80, y);
    y += 46;
  }
  g.globalAlpha = 0.7;
  g.font = font(600, 28);
  g.fillText('Tracked with Encore', 80, H - 70);
  g.globalAlpha = 1;
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], `encore-${year}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `My ${year} in concerts` }); } catch { /* cancelled */ }
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

function fit(g, text, max) {
  let t = String(text);
  while (g.measureText(t).width > max && t.length > 4) t = `${t.slice(0, -2)}…`;
  return t;
}

// =====================================================================
// Show-day view
// =====================================================================
export function tonightEvents() {
  const today = todayStr();
  const tomorrow = todayStr(1);
  const late = new Date().getHours() >= 18;
  return sortEvents(Object.values(getState().events).filter((e) =>
    ['going', 'tickets'].includes(e.mine?.status) && !isCancelled(e) && (e.date === today || (late && e.date === tomorrow))));
}

const CHECKLIST = [['tix', 'Tickets ready'], ['id', 'ID'], ['charge', 'Phone charged'], ['plugs', 'Earplugs'], ['ride', 'Ride / parking planned'], ['cash', 'Card or cash for merch']];
let tickTimer = null;
const weatherCache = new Map();

export function renderTonight(id) {
  const ev = getState().events[id];
  if (!ev) return `${header({ title: '', small: true, left: backBtn() })}<div class="empty"><h2>Show not found</h2></div>`;
  const m = ev.mine || {};
  const doors = m.doors || ev.doorsTime;
  const v = ev.venue || {};
  const dest = v.lat != null ? `${v.lat},${v.lon}` : encodeURIComponent([v.name, v.address || placeLine(v)].filter(Boolean).join(', '));
  const n = daysUntil(ev.date);
  const dayLabel = n === 0 ? 'Tonight' : n === 1 ? 'Tomorrow' : n === -1 ? 'Last night' : fmtDate(ev.date, { weekday: 'long', month: 'short', day: 'numeric' });
  const check = m.check || {};
  return `
    ${header({ title: 'Show day', small: true, left: backBtn(), right: `<a class="icon-btn" href="#/event/${encodeURIComponent(ev.id)}" aria-label="Show details">${icon('info')}</a>` })}
    <div class="tonight-card">
      <div class="tc-day">${esc(dayLabel)} · ${esc(fmtDate(ev.date, { weekday: 'short', month: 'short', day: 'numeric' }))}</div>
      <div class="tc-artist">${esc(eventTitle(ev))}</div>
      <div class="tc-venue">${esc(v.name || '')}${v.city ? ` · ${esc(v.city)}` : ''}</div>
      <div class="tc-times">
        ${doors ? `<div><span>Doors</span><b>${esc(fmtTime(doors))}</b></div>` : ''}
        ${ev.time ? `<div><span>Show</span><b>${esc(fmtTime(ev.time))}</b></div>` : ''}
        ${m.seats ? `<div><span>Seats</span><b>${esc(m.seats)}</b></div>` : ''}
        ${m.qty ? `<div><span>Tickets</span><b>${esc(String(m.qty))}</b></div>` : ''}
      </div>
      <div class="tc-countdown" id="tc-countdown"></div>
      <div id="tc-weather" class="tc-weather"></div>
    </div>
    <div class="btn-grid" style="margin-top:12px">
      <a class="btn primary" href="https://maps.apple.com/?daddr=${dest}" target="_blank" rel="noopener">${icon('pin')}Directions</a>
      ${m.files?.length ? `<button class="btn primary" data-action="open-tickets">${icon('ticket')}My tickets</button>` : ev.url ? `<a class="btn" href="${esc(ev.url)}" target="_blank" rel="noopener">${icon('ticket')}Tickets</a>` : '<span></span>'}
    </div>
    ${walletHtml(ev)}
    <div class="section-title"><span>Before you go</span></div>
    <div class="list">
      ${CHECKLIST.map(([k, label]) => `<label class="row" style="cursor:pointer"><input type="checkbox" class="check" data-check="${k}" ${check[k] ? 'checked' : ''}><div class="grow">${esc(label)}</div></label>`).join('')}
    </div>
    ${m.notes ? `<div class="section-title"><span>Notes</span></div><div class="card pad small" style="white-space:pre-line">${esc(m.notes)}</div>` : ''}
    ${ev.info ? `<div class="section-title"><span>Venue info</span></div><div class="card pad small muted" style="white-space:pre-line">${esc(ev.info)}</div>` : ''}
  `;
}

export function wireTonight(root, id) {
  const ev = getState().events[id];
  if (!ev) return;
  wireWallet(root, id);
  root.querySelector('[data-action="open-tickets"]')?.addEventListener('click', () => openViewer(id, 0));
  root.querySelectorAll('[data-check]').forEach((cb) => cb.addEventListener('change', () => {
    update((st) => {
      const mine = touchMine(st.events[id]);
      mine.check = { ...(mine.check || {}), [cb.dataset.check]: cb.checked };
    }, { silent: true });
  }));
  const cd = root.querySelector('#tc-countdown');
  const target = (hhmm) => {
    if (!hhmm || !ev.date) return null;
    const d = parseLocalDate(ev.date);
    const [h, mi] = hhmm.split(':').map(Number);
    d.setHours(h, mi || 0, 0, 0);
    return d;
  };
  const tick = () => {
    if (!document.body.contains(cd)) { clearInterval(tickTimer); return; }
    const now = new Date();
    const doors = target(ev.mine?.doors || ev.doorsTime);
    const show = target(ev.time);
    const fmt = (ms) => {
      const mins = Math.round(ms / 60000);
      if (mins < 60) return `${mins} min`;
      const h = Math.floor(mins / 60);
      return h < 48 ? `${h}h ${mins % 60}m` : `${Math.round(h / 24)} days`;
    };
    if (doors && now < doors) cd.textContent = `Doors open in ${fmt(doors - now)}`;
    else if (show && now < show) cd.textContent = `Show starts in ${fmt(show - now)}`;
    else if (show && now - show < 4 * 3600000) cd.textContent = 'Happening now — enjoy the show! 🎶';
    else cd.textContent = '';
  };
  clearInterval(tickTimer);
  tick();
  tickTimer = setInterval(tick, 30000);
  loadWeather(ev, root.querySelector('#tc-weather'));
}

async function loadWeather(ev, el) {
  const v = ev.venue || {};
  const n = daysUntil(ev.date);
  if (!el || v.lat == null || n == null || n < 0 || n > 7) return;
  const key = `${ev.id}`;
  try {
    let data = weatherCache.get(key);
    if (!data) {
      const unit = getState().settings.units === 'km' ? 'celsius' : 'fahrenheit';
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${v.lat}&longitude=${v.lon}&hourly=temperature_2m,precipitation_probability&temperature_unit=${unit}&timezone=auto&start_date=${ev.date}&end_date=${ev.date}`;
      const res = await fetch(url);
      if (!res.ok) return;
      data = await res.json();
      weatherCache.set(key, data);
    }
    const hour = parseInt((ev.time || '20:00').slice(0, 2), 10);
    const idx = (data.hourly?.time || []).findIndex((t) => parseInt(t.slice(11, 13), 10) === hour);
    if (idx < 0) return;
    const temp = Math.round(data.hourly.temperature_2m[idx]);
    const rain = data.hourly.precipitation_probability?.[idx];
    el.textContent = `Forecast at showtime: ${temp}°${getState().settings.units === 'km' ? 'C' : 'F'}${rain != null ? ` · ${rain}% chance of rain` : ''}`;
  } catch { /* offline — skip */ }
}

// =====================================================================
// Ticket wallet
// =====================================================================
export function walletHtml(ev) {
  const files = ev.mine?.files || [];
  return `
    <div class="section-title"><span>Ticket wallet</span></div>
    <div class="card pad">
      ${files.length ? `<div class="wallet">${files.map((f, i) => `
        <button class="wallet-tile" data-file="${esc(f.id)}" data-i="${i}" aria-label="Open ${esc(f.name)}">
          ${/^image\//.test(f.type) ? '<img alt="" data-thumb>' : `<div class="wallet-icon">${icon('file')}<span>${esc((f.name.split('.').pop() || 'file').toUpperCase())}</span></div>`}
          <span class="wallet-name">${esc(f.name)}</span>
        </button>`).join('')}</div>` : '<p class="small muted" style="margin:0 0 10px">Keep screenshots, PDFs or Wallet passes for this show here — handy if the venue has bad signal. Files stay on this device.</p>'}
      <label class="btn block" style="margin-top:${files.length ? 10 : 0}px">${icon('clip')}Add ticket file
        <input type="file" data-add-file accept="image/*,application/pdf,.pdf,.pkpass,application/vnd.apple.pkpass" multiple hidden>
      </label>
    </div>`;
}

export function wireWallet(root, id) {
  const input = root.querySelector('[data-add-file]');
  input?.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    if (!files.length) return;
    const metas = [];
    for (const raw of files) {
      try {
        const f = await shrinkImage(raw);
        const meta = { id: uid('f'), name: raw.name || 'ticket', type: f.type || raw.type || 'application/octet-stream', size: f.size };
        await putFile({ ...meta, eventId: id, blob: f, addedAt: Date.now() });
        metas.push(meta);
      } catch (e) {
        toast(`Couldn’t save ${raw.name}: ${e.message}`, { error: true });
      }
    }
    if (metas.length) {
      update((st) => {
        const mine = touchMine(st.events[id]);
        mine.files = [...(mine.files || []), ...metas];
      });
      toast(`Saved ${metas.length} file${metas.length > 1 ? 's' : ''}`);
    }
  });
  root.querySelectorAll('[data-file]').forEach(async (tile) => {
    tile.addEventListener('click', () => openViewer(id, +tile.dataset.i));
    const img = tile.querySelector('[data-thumb]');
    if (!img) return;
    const rec = await getFile(tile.dataset.file).catch(() => null);
    if (rec?.blob) img.src = URL.createObjectURL(rec.blob);
    else tile.classList.add('missing');
  });
}

async function openViewer(eventId, index) {
  const ev = getState().events[eventId];
  const files = ev?.mine?.files || [];
  if (!files.length) return;
  let i = Math.max(0, Math.min(index, files.length - 1));
  const el = document.createElement('div');
  el.className = 'viewer';
  el.setAttribute('role', 'dialog');
  document.body.appendChild(el);
  const urls = [];
  const close = () => { el.remove(); urls.forEach((u) => URL.revokeObjectURL(u)); };
  const draw = async () => {
    const meta = files[i];
    const rec = await getFile(meta.id).catch(() => null);
    let content;
    if (!rec?.blob) {
      content = '<div class="viewer-msg">This file was added on another device. Open Encore there, or re-add it here.</div>';
    } else if (/^image\//.test(meta.type)) {
      const u = URL.createObjectURL(rec.blob);
      urls.push(u);
      content = `<img src="${u}" alt="${esc(meta.name)}">`;
    } else {
      content = `<div class="viewer-msg">${icon('file')}<div><b>${esc(meta.name)}</b></div><div>${esc(fmtBytes(meta.size || rec.blob.size))}</div>
        <div class="stack" style="margin-top:16px;width:100%">
          <button class="btn primary block" data-open>${/pkpass/.test(meta.type) || /\.pkpass$/i.test(meta.name) ? 'Add to Apple Wallet' : 'Open'}</button>
        </div></div>`;
    }
    el.innerHTML = `
      <div class="viewer-bar">
        <button class="icon-btn" data-close aria-label="Close">${icon('close')}</button>
        <span>${files.length > 1 ? `${i + 1} / ${files.length}` : esc(meta.name)}</span>
        <span class="hstack">
          ${rec?.blob ? `<button class="icon-btn" data-share aria-label="Share or save">${icon('share')}</button>` : ''}
          <button class="icon-btn" data-del aria-label="Delete file">${icon('trash')}</button>
        </span>
      </div>
      <div class="viewer-body">${content}</div>
      ${files.length > 1 ? `<button class="viewer-nav prev" data-prev aria-label="Previous">${icon('back')}</button><button class="viewer-nav next" data-next aria-label="Next">${icon('chev')}</button>` : ''}
      <div class="viewer-hint">Turn your screen brightness up for scanning.</div>`;
    el.querySelector('[data-close]').onclick = close;
    el.querySelector('[data-prev]')?.addEventListener('click', () => { i = (i - 1 + files.length) % files.length; draw(); });
    el.querySelector('[data-next]')?.addEventListener('click', () => { i = (i + 1) % files.length; draw(); });
    el.querySelector('[data-share]')?.addEventListener('click', async () => {
      const file = new File([rec.blob], meta.name, { type: meta.type });
      if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch { /* cancelled */ } }
      else await shareOrDownload(meta.name, rec.blob, meta.type);
    });
    el.querySelector('[data-open]')?.addEventListener('click', () => {
      const u = URL.createObjectURL(new Blob([rec.blob], { type: meta.type }));
      urls.push(u);
      window.open(u, '_blank');
    });
    el.querySelector('[data-del]').onclick = async () => {
      if (!(await confirmSheet({ title: 'Delete this file?', message: meta.name, confirm: 'Delete', danger: true }))) return;
      await deleteFile(meta.id).catch(() => {});
      update((st) => {
        const mine = touchMine(st.events[eventId]);
        mine.files = (mine.files || []).filter((f) => f.id !== meta.id);
      });
      close();
    };
  };
  let sx = null;
  el.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (sx == null || files.length < 2) return;
    const dx = e.changedTouches[0].clientX - sx;
    sx = null;
    if (Math.abs(dx) > 60) { i = (i + (dx < 0 ? 1 : -1) + files.length) % files.length; draw(); }
  });
  await draw();
}

// =====================================================================
// Settings: Sync & background alerts
// =====================================================================
export function syncSettingsHtml() {
  const s = getState();
  const sy = s.settings.sync || {};
  const on = syncEnabled();
  const repo = hostingRepo();
  const secretsUrl = repo ? `https://github.com/${repo}/settings/secrets/actions` : 'https://docs.github.com/actions/security-guides/using-secrets-in-github-actions';
  const actionsUrl = repo ? `https://github.com/${repo}/actions/workflows/alerts.yml` : '';
  const serverStale = sy.serverRun && Date.now() - sy.serverRun > 26 * 3600000;
  return `
    <div class="section-title"><span>Sync & background alerts</span>${on ? '<span class="badge good">On</span>' : ''}</div>
    <div class="card pad stack">
      ${!on ? `
        <p class="small muted" style="margin:0">Optional. Keeps a private copy of your data in a secret GitHub Gist so you can restore it on a new phone — and lets a scheduled GitHub Action <b>notify you even when Encore is closed</b>: show-day reminders, plus new shows and price drops if you add the optional lookup keys.</p>
        <ol class="steps">
          <li><a href="https://github.com/settings/tokens/new?scopes=gist&description=Encore%20sync" target="_blank" rel="noopener">Create a GitHub token</a> with only the <b>gist</b> box ticked. Set expiration to “No expiration” (or remember to renew it).</li>
          <li>Paste it here and tap Connect. On a second device, use the same token — Encore finds your existing gist.</li>
        </ol>
        <input class="input" id="sync-token" type="password" placeholder="ghp_…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn primary" data-action="sync-connect">${icon('cloud')}Connect</button>
        <p class="help" style="margin:0">The token is stored only on this device. The gist is secret (not listed publicly) and contains your data and API keys — don’t share its link.</p>
      ` : `
        <div class="hstack" style="justify-content:space-between">
          <div><b>Synced ${esc(timeAgo(sy.lastSync))}</b><div class="small muted">Gist ${esc(sy.gistId.slice(0, 8))}…</div></div>
          <button class="btn sm" data-action="sync-now">${icon('refresh')}Sync now</button>
        </div>
        ${sy.lastError ? `<p class="help" style="margin:0;color:var(--bad)">${esc(sy.lastError)}</p>` : ''}
        <hr class="sep">
        <b>Background alerts</b>
        <ol class="steps">
          <li>In your repo’s <a href="${esc(secretsUrl)}" target="_blank" rel="noopener">Actions secrets</a>, add:<br>
            <code>ENCORE_GIST_ID</code> = <code style="word-break:break-all">${esc(sy.gistId)}</code> <button class="btn sm" data-action="copy-gist" style="margin-top:4px">Copy</button><br>
            <code>ENCORE_GIST_TOKEN</code> = the same token you pasted above.</li>
          <li>Turn on alerts for this device below${isStandalone() ? '' : ' (open Encore from your Home Screen first)'}.</li>
          <li>${actionsUrl ? `Optional: <a href="${esc(actionsUrl)}" target="_blank" rel="noopener">run the “Background alerts” workflow</a> once to test.` : 'Optional: run the “Background alerts” workflow once from the Actions tab to test.'} After that it runs every 2 hours.</li>
        </ol>
        <div class="hstack" style="justify-content:space-between">
          <div><div>Alerts on this device</div><div class="small muted">New shows, price drops, price targets, status changes, on-sale reminders, show-day reminders</div></div>
          <label class="switch"><input type="checkbox" id="push-toggle" ${s.settings.push?.enabled ? 'checked' : ''} ${pushSupported() ? '' : 'disabled'}><span class="track"></span></label>
        </div>
        <p class="help" style="margin:0">${sy.serverRun ? `Last background check: ${esc(timeAgo(sy.serverRun))}.${serverStale ? ' That’s over a day ago — check the Actions tab (GitHub pauses scheduled workflows after 60 days without repo activity).' : ''}` : 'The background check hasn’t run yet (or the secrets aren’t set).'}${sy.serverError ? ` Last error: ${esc(sy.serverError)}` : ''}</p>
        <button class="btn sm danger" data-action="sync-disconnect" style="align-self:flex-start">Disconnect sync</button>
      `}
    </div>`;
}

export function wireSyncSettings(root, rerender) {
  root.querySelector('[data-action="sync-connect"]')?.addEventListener('click', async (e) => {
    const token = root.querySelector('#sync-token').value.trim();
    if (!token) { toast('Paste a token first', { error: true }); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Connecting…';
    try {
      const r = await connect(token);
      toast(r.created ? `Connected as ${r.login} — sync gist created` : `Connected as ${r.login} — restored from your gist`, { ms: 3500 });
    } catch (err) {
      toast(err.message, { error: true, ms: 4500 });
      rerender();
    }
  });
  root.querySelector('[data-action="sync-now"]')?.addEventListener('click', async (e) => {
    e.currentTarget.classList.add('spinning');
    try {
      const r = await syncNow();
      toast({ pulled: 'Pulled latest from your gist', pushed: 'Saved to your gist', merged: 'Merged changes from another device', 'up-to-date': 'Already in sync' }[r] || 'Synced');
    } catch (err) {
      toast(err.message, { error: true });
    }
    rerender();
  });
  root.querySelector('[data-action="copy-gist"]')?.addEventListener('click', () => copy(getState().settings.sync.gistId, 'Gist ID copied'));
  root.querySelector('[data-action="sync-disconnect"]')?.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: 'Disconnect sync?', message: 'Your data stays on this phone and in the gist. Background alerts stop for this device.', confirm: 'Disconnect', danger: true }))) return;
    if (getState().settings.push?.enabled) await disablePush().catch(() => {});
    disconnect();
  });
  root.querySelector('#push-toggle')?.addEventListener('change', async (e) => {
    const cb = e.target;
    cb.disabled = true;
    try {
      if (cb.checked) {
        await enablePush();
        toast('Background alerts on 🔔');
      } else {
        await disablePush();
        toast('Background alerts off');
      }
    } catch (err) {
      cb.checked = !cb.checked;
      toast(err.message, { error: true, ms: 4500 });
    }
    cb.disabled = false;
  });
  if (!getToken()) return;
}

export { openShowForm };

// =====================================================================
// Check for shows — the no-setup way to see if your artists are touring.
// One tap opens a lookup; anything you find can be saved in a few taps.
// =====================================================================
export function checkLinks(artist) {
  const s = getState();
  const city = s.settings.home?.label?.split(',')[0] || '';
  const q = encodeURIComponent(artist.name);
  return [
    { id: 'google', label: 'Google', primary: true, url: `https://www.google.com/search?q=${encodeURIComponent(`${artist.name} tour dates${city ? ` ${city}` : ''}`)}` },
    { id: 'bit', label: 'Bandsintown', url: `https://www.bandsintown.com/search?search_term=${q}` },
    { id: 'sk', label: 'Songkick', url: `https://www.songkick.com/search?query=${q}&type=artists` },
    { id: 'tm', label: 'Ticketmaster', url: artist.url || `https://www.ticketmaster.com/search?q=${q}` },
  ];
}

export function markChecked(artistId) {
  update((st) => {
    const a = st.artists.find((x) => x.id === artistId);
    if (a) a.checkedAt = Date.now();
  }, { silent: true });
}

const checkedLabel = (a) => {
  const t = Math.max(a.checkedAt || 0, a.lastChecked || 0);
  return t ? `Checked ${timeAgo(t)}` : 'Not checked yet';
};

export function renderCheck() {
  const s = getState();
  const today = todayStr();
  const artists = [...s.artists].sort((x, y) => Math.max(x.checkedAt || 0, x.lastChecked || 0) - Math.max(y.checkedAt || 0, y.lastChecked || 0) || x.name.localeCompare(y.name));
  const due = artists.filter((a) => Date.now() - Math.max(a.checkedAt || 0, a.lastChecked || 0) > 7 * 86400000).length;
  if (!artists.length) {
    return `${header({ title: 'Check for shows', small: true, left: backBtn() })}
      <div class="empty"><div class="art">${icon('search')}</div><h2>Add an artist first</h2>
      <p>Then come back here to look up their tour dates in one tap.</p>
      <button class="btn primary" data-action="add-artist">${icon('plus')}Add an artist</button></div>`;
  }
  return `
    ${header({ title: 'Check for shows', small: true, left: backBtn() })}
    <p class="help" style="margin:12px 4px 0">Tap <b>Google</b> to see an artist’s upcoming dates${s.settings.home ? ` (near ${esc(s.settings.home.label.split(',')[0])} first)` : ''}. Found one you like? Tap <b>Save a show</b> to track it here.${due ? ` <b>${due}</b> not checked this week.` : ''}</p>
    <div class="check-list">
      ${artists.map((a) => {
        const saved = Object.values(s.events).filter((e) => e.artistIds?.includes(a.id) && (!e.date || e.date >= today)).length;
        return `<div class="card check-card" data-artist="${esc(a.id)}">
          <div class="check-head">
            ${avatar(a)}
            <div class="grow">
              <a class="title" href="#/artist/${encodeURIComponent(a.id)}">${esc(a.name)}</a>
              <div class="subtitle"><span data-checked>${esc(checkedLabel(a))}</span>${saved ? ` · ${saved} saved show${saved === 1 ? '' : 's'}` : ''}</div>
            </div>
          </div>
          <div class="check-actions">
            ${checkLinks(a).map((l) => `<a class="btn sm ${l.primary ? 'primary' : ''}" href="${esc(l.url)}" target="_blank" rel="noopener" data-check-link>${esc(l.label)}</a>`).join('')}
          </div>
          <button class="btn sm block" data-action="add-show" data-artist="${esc(a.id)}">${icon('plus')}Save a show</button>
        </div>`;
      }).join('')}
    </div>`;
}

export function wireCheck(root) {
  root.querySelectorAll('[data-check-link]').forEach((link) => link.addEventListener('click', () => {
    const card = link.closest('[data-artist]');
    markChecked(card.dataset.artist);
    const label = card.querySelector('[data-checked]');
    if (label) label.textContent = 'Checked just now';
  }));
}
