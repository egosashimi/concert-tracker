// Screens: Shows, Calendar, Artists, Artist detail, Event detail, Settings.

import { getState, update, exportJSON, importJSON, resetAll, storageBytes } from './store.js';
import { tmSearchArtists, geocodeCity, currentPosition, reverseLabel } from './api.js';
import { isRefreshing, emptyMine, checkTarget, lowestKnownPrice, artistNames } from './refresh.js';
import { putFile, allFiles, blobToDataURL, dataURLToBlob } from './files.js';
import { mountPriceChart, priceInsights, hasChartData } from './chart.js';
import { walletHtml, wireWallet, syncSettingsHtml, wireSyncSettings, tonightEvents } from './views-more.js';
import {
  esc, uid, debounce, fmtDate, fmtTime, fmtDateTimeISO, fmtMoney, fmtPriceRange, countdown, timeAgo,
  placeLine, fmtDistance, todayStr, toDateStr, parseLocalDate, daysUntil, isIOS, isStandalone, shareOrDownload, normalizeName, haptic,
} from './util.js';
import {
  icon, toast, openSheet, closeSheet, confirmSheet, showCard, avatar, groupByMonth, sortEvents, eventTitle,
  eventBadges, eventDistance, buildICS, lowSource, statusLabel, isCancelled, onSaleSoon,
} from './ui.js';

// In-memory UI state (not persisted).
export const ui = {
  showsFilter: 'all',
  showsQuery: '',
  showPast: false,
  artistSort: 'name',
  calMonth: null, // Date of first of month
  calSelected: null,
  refreshProgress: null, // { done, total, name }
};

export const header = ({ title, sub = '', left = '', right = '', small = false }) => `
  <header class="header">
    <div class="header-row">
      ${left}
      <h1 class="${small ? 'small' : ''}">${esc(title)}</h1>
      ${right}
    </div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </header>`;

export const backBtn = () => `<button class="icon-btn ghost" data-action="back" aria-label="Back">${icon('back')}</button>`;

export function refreshButton() {
  return `<button class="icon-btn ${isRefreshing() ? 'spinning' : ''}" data-action="refresh" aria-label="Refresh shows">${icon('refresh')}</button>`;
}

export function progressBar() {
  const p = ui.refreshProgress;
  if (!p) return '';
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 5;
  return `<div class="progress" role="progressbar" aria-valuenow="${pct}"><div style="width:${Math.max(5, pct)}%"></div></div>
    <div class="status-line"><span>Checking ${esc(p.name || '…')}</span><span>${p.done}/${p.total}</span></div>`;
}

export function upcomingEvents() {
  const today = todayStr();
  return Object.values(getState().events).filter((e) => !e.date || e.date >= today);
}

/** Shows that belong in "my" feed: by followed artists, or ones you've marked. */
export const isMyShow = (e) => (e.artistIds?.length > 0) || !!e.mine?.status;
export const myUpcoming = () => upcomingEvents().filter(isMyShow);

/** Stamp "my plans" edits so sync can tell which copy is newer. */
export function touchMine(e) {
  e.mine = { ...emptyMine(), ...(e.mine || {}), t: Date.now() };
  return e.mine;
}

// =====================================================================
// Shows
// =====================================================================
export function renderShows() {
  const s = getState();
  const all = myUpcoming();
  const home = s.settings.home;
  const radius = s.settings.radius;
  const q = normalizeName(ui.showsQuery);

  const near = (e) => {
    const d = eventDistance(e);
    return d != null && d <= radius;
  };
  const filters = [
    { id: 'all', label: 'All', test: (e) => !e.mine?.hidden },
    ...(home ? [{ id: 'near', label: 'Near me', test: (e) => !e.mine?.hidden && near(e) }] : []),
    { id: 'mine', label: 'My shows', test: (e) => ['interested', 'going', 'tickets'].includes(e.mine?.status) },
    { id: 'new', label: 'New', test: (e) => e.isNew && !e.mine?.hidden },
    { id: 'deals', label: 'Price drops', test: (e) => !e.mine?.hidden && (e.alertedAt || (e.priceChange?.dir === 'down' && Date.now() - e.priceChange.t < 14 * 86400000)) },
    { id: 'onsale', label: 'On sale soon', test: (e) => !e.mine?.hidden && !!onSaleSoon(e) },
    { id: 'hidden', label: 'Hidden', test: (e) => !!e.mine?.hidden },
  ];
  if (!filters.find((f) => f.id === ui.showsFilter)) ui.showsFilter = 'all';
  const f = filters.find((x) => x.id === ui.showsFilter);
  const baseFar = (e) => !(s.settings.hideFarAway && home && ui.showsFilter === 'all' && eventDistance(e) != null && !near(e));
  const matchesQuery = (e) => !q || normalizeName([eventTitle(e), e.name, e.venue?.name, e.venue?.city, e.venue?.region].join(' ')).includes(q);
  const list = sortEvents(all.filter((e) => f.test(e) && baseFar(e) && matchesQuery(e)));
  const counts = Object.fromEntries(filters.map((x) => [x.id, all.filter((e) => x.test(e) && baseFar(e)).length]));

  const newCount = all.filter((e) => e.isNew).length;
  const sub = s.artists.length
    ? `${all.filter((e) => !e.mine?.hidden).length} upcoming · ${s.artists.length} artist${s.artists.length === 1 ? '' : 's'} · updated ${timeAgo(s.lastRefresh)}`
    : '';

  let banners = '';
  for (const ev of tonightEvents()) {
    banners += `<a class="banner tonight" href="#/tonight/${encodeURIComponent(ev.id)}">${icon('moon')}<div class="grow"><b>${ev.date === todayStr() ? 'Tonight' : 'Tomorrow'}: ${esc(eventTitle(ev))}</b>
      <p>${esc([ev.venue?.name, (ev.mine?.doors || ev.doorsTime) ? `doors ${fmtTime(ev.mine?.doors || ev.doorsTime)}` : '', ev.time ? `show ${fmtTime(ev.time)}` : ''].filter(Boolean).join(' · '))} — open show-day view</p></div>${icon('chev', 'chev')}</a>`;
  }
  if (isIOS && !isStandalone() && !s.installHintDismissed) {
    banners += `<div class="banner info">${icon('share')}<div class="grow"><b>Install on your Home Screen</b>
      <p>Tap the Share button in Safari, then <b style="display:inline">Add to Home Screen</b>. Your data stays on this phone.</p></div>
      <button class="x" data-action="dismiss-install" aria-label="Dismiss">${icon('close')}</button></div>`;
  }
  if (!s.settings.tmKey && !s.settings.bitAppId && s.artists.length) {
    banners += `<a class="banner" href="#/settings">${icon('key')}<div class="grow"><b>Turn on automatic show lookup</b>
      <p>Add a free Ticketmaster API key in Settings to fetch tour dates and prices. You can still add shows by hand.</p></div></a>`;
  }

  let body;
  if (!s.artists.length && !all.length) {
    body = `<div class="empty">
      <div class="art">${icon('music')}</div>
      <h2>No artists yet</h2>
      <p>Add the artists you love and Encore will track their upcoming shows and ticket prices.</p>
      <a class="btn primary" href="#/artists?add=1">${icon('plus')}Add an artist</a>
    </div>`;
  } else if (!list.length) {
    const msg = ui.showsQuery ? `Nothing matches “${esc(ui.showsQuery)}”.`
      : ui.showsFilter === 'near' ? `No shows within ${radius} ${s.settings.units} of ${esc(home?.label || 'home')}.`
      : ui.showsFilter === 'mine' ? 'Mark shows as Interested, Going or Got tickets to see them here.'
      : ui.showsFilter === 'all' && !s.lastRefresh && (s.settings.tmKey || s.settings.bitAppId) ? 'Pull down or tap refresh to look for shows.'
      : 'No shows here right now.';
    body = `<div class="empty"><p>${msg}</p></div>`;
  } else {
    body = groupByMonth(list).map((g) => `
      <div class="month-title">${esc(g.label)}</div>
      <div class="shows">${g.events.map((e) => showCard(e)).join('')}</div>`).join('');
  }

  const pastCount = Object.values(s.events).filter((e) => e.date && e.date < todayStr() && isMyShow(e)).length;

  return `
    ${header({
      title: 'Shows',
      sub,
      right: `<button class="icon-btn" data-action="add-show" aria-label="Add a show manually">${icon('plus')}</button>${refreshButton()}`,
    })}
    ${progressBar()}
    ${banners}
    ${s.artists.length || all.length ? `
    <div class="search" style="margin-top:10px">${icon('search')}<input id="shows-q" class="input" type="search" placeholder="Search artists, venues, cities" value="${esc(ui.showsQuery)}" autocomplete="off" enterkeyhint="search"></div>
    <div class="chips" role="tablist">
      ${filters.map((x) => `<button class="chip ${x.id === ui.showsFilter ? 'active' : ''}" data-filter="${x.id}" role="tab" aria-selected="${x.id === ui.showsFilter}">${esc(x.label)}<span class="count">${counts[x.id]}</span></button>`).join('')}
    </div>` : ''}
    ${newCount && ui.showsFilter !== 'hidden' ? `<div class="status-line"><span>${newCount} new since you last looked</span><button class="btn sm" data-action="mark-seen">Mark all seen</button></div>` : ''}
    <div id="shows-list">${body}</div>
    ${pastCount ? `<div class="section-title" style="margin-top:32px"><span>Past shows</span><button class="btn sm" data-action="toggle-past">${ui.showPast ? 'Hide' : `Show ${pastCount}`}</button></div>
      ${ui.showPast ? `<div class="shows">${sortEvents(Object.values(s.events).filter((e) => e.date && e.date < todayStr() && isMyShow(e))).reverse().map((e) => showCard(e)).join('')}</div>` : ''}` : ''}
  `;
}

export function wireShows(root, rerender) {
  const input = root.querySelector('#shows-q');
  input?.addEventListener('input', debounce(() => { ui.showsQuery = input.value; rerender(); }, 150));
  root.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    ui.showsFilter = b.dataset.filter;
    haptic();
    rerender();
  }));
}

// =====================================================================
// Calendar
// =====================================================================
export function renderCalendar() {
  const s = getState();
  const now = new Date();
  if (!ui.calMonth) ui.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const m = ui.calMonth;
  const year = m.getFullYear();
  const month = m.getMonth();
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const gridStart = new Date(year, month, 1 - startDow);
  const byDate = {};
  for (const e of Object.values(s.events)) {
    if (!e.date || e.mine?.hidden || !isMyShow(e)) continue;
    (byDate[e.date] ||= []).push(e);
  }
  const today = todayStr();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const ds = toDateStr(d);
    const evs = byDate[ds] || [];
    const dots = evs.slice(0, 4).map((e) => `<i class="${['going', 'tickets'].includes(e.mine?.status) ? 'mine' : 'has'}"></i>`).join('');
    cells.push(`<button class="cal-day ${d.getMonth() !== month ? 'other' : ''} ${ds === today ? 'today' : ''} ${ds === ui.calSelected ? 'selected' : ''}" data-day="${ds}" aria-label="${esc(fmtDate(ds))}${evs.length ? `, ${evs.length} show${evs.length > 1 ? 's' : ''}` : ''}">
      ${d.getDate()}<span class="cal-dots">${dots}</span></button>`);
    if (i >= 34 && d.getMonth() !== month && d.getDay() === 6) break;
  }
  const dows = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));
  const monthEvents = sortEvents(Object.values(s.events).filter((e) => e.date && !e.mine?.hidden && isMyShow(e) && parseLocalDate(e.date).getMonth() === month && parseLocalDate(e.date).getFullYear() === year));
  const listEvents = ui.calSelected ? (byDate[ui.calSelected] || []) : monthEvents;
  const mineUpcoming = sortEvents(upcomingEvents().filter((e) => ['going', 'tickets'].includes(e.mine?.status)));

  return `
    ${header({
      title: 'Calendar',
      right: `<a class="icon-btn" href="#/stats" aria-label="Your concert stats">${icon('chart')}</a>${mineUpcoming.length ? `<button class="icon-btn" data-action="export-mine-ics" aria-label="Add my shows to Calendar">${icon('download')}</button>` : ''}`,
    })}
    <div class="cal-head">
      <button class="icon-btn" data-action="cal-prev" aria-label="Previous month">${icon('back')}</button>
      <h2>${esc(first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</h2>
      <button class="icon-btn" data-action="cal-next" aria-label="Next month">${icon('chev')}</button>
    </div>
    <div class="cal-grid">
      ${dows.map((d) => `<div class="cal-dow">${esc(d)}</div>`).join('')}
      ${cells.join('')}
    </div>
    <div class="legend" style="margin:10px 4px 0"><span><i class="api"></i>Show</span><span><i style="background:var(--good)"></i>Going / tickets</span></div>
    <div class="section-title"><span>${ui.calSelected ? esc(fmtDate(ui.calSelected, { weekday: 'long', month: 'long', day: 'numeric' })) : 'This month'}</span>
      ${ui.calSelected ? '<button class="btn sm" data-action="cal-clear">Whole month</button>' : `<button class="btn sm" data-action="cal-today">Today</button>`}</div>
    ${listEvents.length ? `<div class="shows">${listEvents.map((e) => showCard(e)).join('')}</div>` : '<div class="empty" style="padding:24px"><p>No shows.</p></div>'}
  `;
}

export function wireCalendar(root, rerender) {
  root.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
    ui.calSelected = ui.calSelected === b.dataset.day ? null : b.dataset.day;
    const d = parseLocalDate(b.dataset.day);
    if (d.getMonth() !== ui.calMonth.getMonth()) ui.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    rerender();
  }));
  // Swipe left/right to change month.
  const grid = root.querySelector('.cal-grid');
  let sx = null;
  grid?.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  grid?.addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx;
    sx = null;
    if (Math.abs(dx) > 60) shiftMonth(dx < 0 ? 1 : -1, rerender);
  });
}

export function shiftMonth(n, rerender) {
  const m = ui.calMonth;
  ui.calMonth = new Date(m.getFullYear(), m.getMonth() + n, 1);
  ui.calSelected = null;
  rerender();
}

// =====================================================================
// Artists
// =====================================================================
function nextShow(artistId) {
  return sortEvents(upcomingEvents().filter((e) => e.artistIds?.includes(artistId) && !isCancelled(e) && e.date))[0];
}

export function renderArtists() {
  const s = getState();
  const rows = s.artists.map((a) => {
    const evs = upcomingEvents().filter((e) => e.artistIds?.includes(a.id) && !e.mine?.hidden);
    return { a, count: evs.length, next: nextShow(a.id), newCount: evs.filter((e) => e.isNew).length };
  });
  if (ui.artistSort === 'next') {
    rows.sort((x, y) => (x.next?.date || '9999').localeCompare(y.next?.date || '9999') || x.a.name.localeCompare(y.a.name));
  } else if (ui.artistSort === 'recent') {
    rows.sort((x, y) => (y.a.addedAt || 0) - (x.a.addedAt || 0));
  } else {
    rows.sort((x, y) => x.a.name.replace(/^the\s+/i, '').localeCompare(y.a.name.replace(/^the\s+/i, '')));
  }
  const sortLabel = { name: 'A–Z', next: 'Next show', recent: 'Recently added' }[ui.artistSort];
  return `
    ${header({
      title: 'Artists',
      sub: s.artists.length ? `${s.artists.length} tracked` : '',
      right: `<a class="icon-btn" href="#/import" aria-label="Import artists">${icon('download')}</a><button class="icon-btn accent" data-action="add-artist" aria-label="Add artist">${icon('plus')}</button>`,
    })}
    ${s.artists.length ? `
      <div class="section-title"><span>Following</span><button class="btn sm" data-action="artist-sort">${icon('sort')}${sortLabel}</button></div>
      <div class="list">
        ${rows.map(({ a, count, next, newCount }) => `
          <a class="row" href="#/artist/${encodeURIComponent(a.id)}">
            ${avatar(a)}
            <div class="grow">
              <div class="title">${esc(a.name)}</div>
              <div class="subtitle">${count ? `${count} show${count === 1 ? '' : 's'}` : 'No upcoming shows'}${next ? ` · next ${esc(fmtDate(next.date, { month: 'short', day: 'numeric' }))}${next.venue?.city ? ` in ${esc(next.venue.city)}` : ''}` : ''}</div>
              ${a.lastError ? `<div class="subtitle" style="color:var(--bad)">${esc(a.lastError)}</div>` : ''}
            </div>
            ${newCount ? `<span class="badge new">${newCount} new</span>` : ''}
            ${icon('chev', 'chev')}
          </a>`).join('')}
      </div>` : `
      <div class="empty">
        <div class="art">${icon('music')}</div>
        <h2>Follow your first artist</h2>
        <p>${getState().settings.tmKey ? 'Search Ticketmaster to add an artist and pull in their tour dates.' : 'Add artists by name. Connect Ticketmaster in Settings to find their shows automatically.'}</p>
        <div class="stack" style="max-width:280px;margin:0 auto">
          <button class="btn primary block" data-action="add-artist">${icon('plus')}Add an artist</button>
          <a class="btn block" href="#/import">Import from Spotify, Apple Music or a list</a>
        </div>
      </div>`}
  `;
}

export function openAddArtist() {
  const hasKey = !!getState().settings.tmKey;
  openSheet({
    title: 'Add artist',
    body: `
      <div class="search">${icon('search')}<input id="artist-q" class="input" type="search" placeholder="${hasKey ? 'Search Ticketmaster…' : 'Artist name'}" autocomplete="off" autocapitalize="words" enterkeyhint="search"></div>
      ${hasKey ? '' : '<p class="help">No Ticketmaster key yet — artists are added by name. <a href="#/settings" data-close-sheet>Add a key</a> to search and fetch shows.</p>'}
      <div id="artist-results" style="margin-top:12px"></div>
      <a class="row card" href="#/import" style="margin-top:16px">${icon('download', 'chev')}<div class="grow"><div class="title">Import many artists</div><div class="subtitle">From Spotify, Apple Music, or a pasted list</div></div>${icon('chev', 'chev')}</a>`,
    onMount: (body, close) => {
      const input = body.querySelector('#artist-q');
      const results = body.querySelector('#artist-results');
      body.querySelector('[data-close-sheet]')?.addEventListener('click', () => close());
      setTimeout(() => input.focus(), 320);
      let seq = 0;
      const renderManual = (q) => (q ? `<button class="row" data-manual="${esc(q)}">
          <div class="avatar">${icon('plus')}</div>
          <div class="grow"><div class="title">Add “${esc(q)}”</div><div class="subtitle">${hasKey ? 'Without Ticketmaster — add shows yourself' : 'Track this artist'}</div></div></button>` : '');
      const search = debounce(async () => {
        const q = input.value.trim();
        const my = ++seq;
        if (!q) { results.innerHTML = ''; return; }
        if (!hasKey) { results.innerHTML = `<div class="list">${renderManual(q)}</div>`; return; }
        results.innerHTML = '<div class="loading-row"><span class="spinner"></span></div>';
        try {
          const found = await tmSearchArtists(q, getState().settings.tmKey);
          if (my !== seq) return;
          const tracked = new Set(getState().artists.map((a) => a.tmId).filter(Boolean));
          results.innerHTML = `<div class="list">
            ${found.map((r, i) => `<button class="row result-row" data-i="${i}" ${tracked.has(r.tmId) ? 'disabled' : ''}>
              ${avatar(r)}
              <div class="grow"><div class="title">${esc(r.name)}</div>
              <div class="subtitle">${[r.genre, r.upcoming ? `${r.upcoming} upcoming` : 'No upcoming events'].filter(Boolean).map(esc).join(' · ')}</div></div>
              <span class="badge ${tracked.has(r.tmId) ? 'good' : 'accent'} add-pill">${tracked.has(r.tmId) ? 'Following' : 'Add'}</span>
            </button>`).join('')}
            ${renderManual(q)}
          </div>`;
          results.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
            addArtist(found[+b.dataset.i]);
            close();
          }));
        } catch (e) {
          if (my !== seq) return;
          results.innerHTML = `<p class="help" style="color:var(--bad)">${esc(e.message)}</p><div class="list">${renderManual(q)}</div>`;
        }
        results.querySelector('[data-manual]')?.addEventListener('click', (ev) => {
          addArtist({ name: ev.currentTarget.dataset.manual });
          close();
        });
      }, 350);
      input.addEventListener('input', search);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });

    },
  });
}

export function addArtist(r, { silentRefresh = false, quiet = false } = {}) {
  const s = getState();
  const dup = s.artists.find((a) => (r.tmId && a.tmId === r.tmId) || normalizeName(a.name) === normalizeName(r.name));
  if (dup) {
    if (!quiet) toast(`Already following ${dup.name}`);
    return false;
  }
  const artist = {
    id: uid('a'),
    name: r.name,
    tmId: r.tmId || '',
    image: r.image || '',
    genre: r.genre || '',
    genreIds: [r.genreId].filter(Boolean),
    subGenreIds: [r.subGenreId].filter(Boolean),
    url: r.url || '',
    addedAt: Date.now(),
    lastChecked: 0,
    lastError: '',
  };
  update((st) => { st.artists.push(artist); });
  if (!quiet) toast(`Following ${artist.name}`);
  if (!silentRefresh && (s.settings.tmKey && artist.tmId || s.settings.bitAppId)) {
    window.dispatchEvent(new CustomEvent('encore:refresh', { detail: { artistId: artist.id } }));
  }
  return true;
}

// =====================================================================
// Artist detail
// =====================================================================
export function renderArtist(id) {
  const s = getState();
  const a = s.artists.find((x) => x.id === id);
  if (!a) return notFound('Artist not found');
  const evs = sortEvents(upcomingEvents().filter((e) => e.artistIds?.includes(a.id)));
  const visible = evs.filter((e) => !e.mine?.hidden);
  const hiddenCount = evs.length - visible.length;
  const q = encodeURIComponent(a.name);
  const links = [
    a.url || a.tmId ? ['Ticketmaster', a.url || `https://www.ticketmaster.com/search?q=${q}`] : ['Ticketmaster', `https://www.ticketmaster.com/search?q=${q}`],
    ['Bandsintown', `https://www.bandsintown.com/search?search_term=${q}`],
    ['Songkick', `https://www.songkick.com/search?query=${q}&type=artists`],
    ['SeatGeek', `https://seatgeek.com/search?search=${q}`],
    ['StubHub', `https://www.stubhub.com/secure/search?q=${q}`],
    ['Spotify', `https://open.spotify.com/search/${q}`],
  ];
  return `
    ${header({ title: a.name, small: true, left: backBtn(), right: refreshButton() })}
    ${progressBar()}
    <div class="center" style="margin-top:16px">
      <div style="display:flex;justify-content:center">${avatar(a, 'lg')}</div>
      <h2 style="margin:12px 0 2px;font-size:26px;letter-spacing:-0.02em">${esc(a.name)}</h2>
      <div class="muted small">${[a.genre, a.tmId ? 'Ticketmaster' : 'Added by name', a.lastChecked ? `checked ${timeAgo(a.lastChecked)}` : ''].filter(Boolean).map(esc).join(' · ')}</div>
      ${a.lastError ? `<div class="small" style="color:var(--bad);margin-top:4px">${esc(a.lastError)}</div>` : ''}
    </div>
    <div class="section-title"><span>Upcoming (${visible.length})</span><button class="btn sm" data-action="add-show" data-artist="${esc(a.id)}">${icon('plus')}Add show</button></div>
    ${visible.length ? `<div class="shows">${visible.map((e) => showCard(e, { showArtist: false })).join('')}</div>`
      : `<div class="card pad muted small">${a.tmId || s.settings.bitAppId ? 'No upcoming shows found. Encore will keep checking.' : 'No shows yet. Add one by hand, or link this artist to Ticketmaster below.'}</div>`}
    ${hiddenCount ? `<p class="help">${hiddenCount} hidden show${hiddenCount > 1 ? 's' : ''} — see the Hidden filter on Shows.</p>` : ''}
    <div class="section-title"><span>Find tickets & tour dates</span></div>
    <div class="list">
      ${links.map(([label, url]) => `<a class="row" href="${esc(url)}" target="_blank" rel="noopener"><div class="grow">${esc(label)}</div>${icon('ext', 'chev')}</a>`).join('')}
    </div>
    <div class="section-title"><span>Manage</span></div>
    <div class="list">
      ${s.settings.tmKey ? `<button class="row" data-action="relink-artist" data-id="${esc(a.id)}"><div class="grow">${a.tmId ? 'Change Ticketmaster match' : 'Link to Ticketmaster'}</div>${icon('chev', 'chev')}</button>` : ''}
      <button class="row" data-action="rename-artist" data-id="${esc(a.id)}"><div class="grow">Rename</div>${icon('chev', 'chev')}</button>
      <button class="row danger" data-action="remove-artist" data-id="${esc(a.id)}"><div class="grow">Stop following</div></button>
    </div>
  `;
}

export function relinkArtist(id) {
  const a = getState().artists.find((x) => x.id === id);
  if (!a) return;
  openSheet({
    title: 'Link to Ticketmaster',
    body: `<div class="search">${icon('search')}<input id="relink-q" class="input" type="search" value="${esc(a.name)}" autocomplete="off"></div><div id="relink-results" style="margin-top:12px"></div>`,
    onMount: (body, close) => {
      const input = body.querySelector('#relink-q');
      const out = body.querySelector('#relink-results');
      const run = debounce(async () => {
        out.innerHTML = '<div class="loading-row"><span class="spinner"></span></div>';
        try {
          const found = await tmSearchArtists(input.value.trim(), getState().settings.tmKey);
          out.innerHTML = found.length ? `<div class="list">${found.map((r, i) => `<button class="row" data-i="${i}">${avatar(r)}<div class="grow"><div class="title">${esc(r.name)}</div><div class="subtitle">${esc([r.genre, `${r.upcoming} upcoming`].filter(Boolean).join(' · '))}</div></div>${r.tmId === a.tmId ? '<span class="badge good">Current</span>' : ''}</button>`).join('')}</div>` : '<p class="help">No matches.</p>';
          out.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
            const r = found[+b.dataset.i];
            update((st) => {
              const art = st.artists.find((x) => x.id === id);
              if (!art) return;
              if (art.tmId !== r.tmId) {
                // Drop shows that came from the old match (keep ones you marked).
                for (const [eid, ev] of Object.entries(st.events)) {
                  if (ev.source === 'tm' && ev.artistIds?.includes(id) && !ev.mine?.status && !ev.mine?.notes) {
                    ev.artistIds = ev.artistIds.filter((x) => x !== id);
                    if (!ev.artistIds.length) delete st.events[eid];
                  }
                }
                art.lastChecked = 0;
              }
              Object.assign(art, { tmId: r.tmId, image: r.image || art.image, genre: r.genre || art.genre, url: r.url || art.url });
            });
            close();
            window.dispatchEvent(new CustomEvent('encore:refresh', { detail: { artistId: id } }));
          }));
        } catch (e) {
          out.innerHTML = `<p class="help" style="color:var(--bad)">${esc(e.message)}</p>`;
        }
      }, 300);
      input.addEventListener('input', run);
      run();
    },
  });
}

export function renameArtist(id) {
  const a = getState().artists.find((x) => x.id === id);
  if (!a) return;
  openSheet({
    title: 'Rename artist',
    body: `<input class="input" id="rename" value="${esc(a.name)}" autocapitalize="words"><button class="btn primary block" style="margin-top:12px" data-save>Save</button>`,
    onMount: (body, close) => {
      const input = body.querySelector('#rename');
      setTimeout(() => input.focus(), 320);
      body.querySelector('[data-save]').onclick = () => {
        const v = input.value.trim();
        if (!v) return;
        update((st) => { const x = st.artists.find((y) => y.id === id); if (x) x.name = v; });
        close();
      };
    },
  });
}

export async function removeArtist(id, go) {
  const a = getState().artists.find((x) => x.id === id);
  if (!a) return;
  const ok = await confirmSheet({
    title: `Stop following ${a.name}?`,
    message: 'Their shows will be removed, except ones you marked Interested, Going or Got tickets.',
    confirm: 'Stop following',
    danger: true,
  });
  if (!ok) return;
  update((st) => {
    st.artists = st.artists.filter((x) => x.id !== id);
    st.deleted.artists[id] = Date.now();
    for (const [eid, ev] of Object.entries(st.events)) {
      if (!ev.artistIds?.includes(id)) continue;
      const keep = ev.mine?.status || ev.mine?.notes;
      if (ev.artistIds.length > 1) {
        if (!keep) ev.artistIds = ev.artistIds.filter((x) => x !== id);
      } else if (!keep) {
        delete st.events[eid];
      }
    }
  });
  toast(`Unfollowed ${a.name}`);
  go('#/artists');
}

// =====================================================================
// Event detail
// =====================================================================
const MY_STATUSES = [
  { id: '', label: 'None', icon: 'close' },
  { id: 'interested', label: 'Interested', icon: 'star' },
  { id: 'going', label: 'Going', icon: 'check' },
  { id: 'tickets', label: 'Tickets', icon: 'ticket' },
];

export function renderEvent(id) {
  const s = getState();
  const ev = s.events[id];
  if (!ev) return notFound('This show is no longer available');
  const m = { ...emptyMine(), ...(ev.mine || {}) };
  const title = eventTitle(ev);
  const dist = eventDistance(ev);
  const low = lowestKnownPrice(ev);
  const v = ev.venue || {};
  const mapQ = encodeURIComponent([v.name, v.address || placeLine(v)].filter(Boolean).join(', '));
  const mapUrl = v.lat != null && v.lon != null ? `https://maps.apple.com/?q=${encodeURIComponent(v.name || 'Venue')}&ll=${v.lat},${v.lon}` : `https://maps.apple.com/?q=${mapQ}`;
  const resaleQ = encodeURIComponent(`${title} ${v.city || ''}`.trim());
  const presales = (ev.presales || []).filter((p) => p.start);
  const history = [...(ev.priceHistory || [])].sort((a, b) => b.t - a.t);
  const sameTour = sortEvents(upcomingEvents().filter((x) => x.id !== ev.id && x.artistIds?.some((a) => ev.artistIds?.includes(a)) && !x.mine?.hidden)).slice(0, 4);
  const others = (ev.lineup || []).filter((n) => !artistNames(ev).some((a) => normalizeName(a) === normalizeName(n)));

  return `
    ${header({ title, small: true, left: backBtn(), right: `<button class="icon-btn" data-action="share-event" aria-label="Share">${icon('share')}</button>` })}
    ${ev.image ? `<div class="hero"><img src="${esc(ev.image)}" alt="" referrerpolicy="no-referrer"></div>` : ''}
    <div class="detail-head ${ev.image ? '' : 'no-hero'}">
      <h2>${esc(title)}</h2>
      ${ev.name && normalizeName(ev.name) !== normalizeName(title) ? `<p class="tour">${esc(ev.name)}</p>` : ''}
      <div class="badges">${eventBadges(ev)}</div>
    </div>

    ${ev.statusChange && Date.now() - ev.statusChange.t < 30 * 86400000 ? `<div class="banner warn">${icon('warn')}<div class="grow"><b>Status changed to ${esc(statusLabel(ev.statusChange.to))}</b><p>Was ${esc(statusLabel(ev.statusChange.from))} · ${esc(timeAgo(ev.statusChange.t))}</p></div></div>` : ''}
    ${ev.delisted ? `<div class="banner warn">${icon('warn')}<div class="grow"><b>No longer listed</b><p>This show disappeared from ${ev.source === 'bit' ? 'Bandsintown' : 'Ticketmaster'} on the last refresh. It may be cancelled, moved, or sold through another seller.</p></div></div>` : ''}

    <div class="facts">
      <div class="fact"><div class="label">Date</div><div class="val sm">${esc(fmtDate(ev.date))}</div><div class="note">${esc(countdown(ev.date))}</div></div>
      <div class="fact"><div class="label">Time</div><div class="val sm">${esc(fmtTime(ev.time) || 'TBA')}</div>${ev.timezone ? `<div class="note">${esc(ev.timezone.replace(/_/g, ' '))}</div>` : ''}</div>
      <a class="fact wide" href="${esc(mapUrl)}" target="_blank" rel="noopener" style="color:inherit">
        <div class="label">Venue</div>
        <div class="val sm">${esc(v.name || 'Venue TBA')}</div>
        <div class="note">${esc(v.address || placeLine(v))}${dist != null ? ` · ${esc(fmtDistance(dist, s.settings.units))} away` : ''} · Open in Maps</div>
      </a>
    </div>

    <div class="section-title"><span>My plans</span></div>
    <div class="segmented" role="radiogroup" aria-label="My plans">
      ${MY_STATUSES.map((x) => `<button class="${x.id} ${m.status === x.id ? 'active' : ''}" data-mystatus="${x.id}" role="radio" aria-checked="${m.status === x.id}">${icon(x.icon)}${x.label}</button>`).join('')}
    </div>
    ${m.status === 'tickets' ? `
      <div class="card pad stack" style="margin-top:10px">
        <div class="field-row">
          <label class="field"><span>Tickets</span><input class="input" type="number" inputmode="numeric" min="1" id="mine-qty" data-mine="qty" value="${m.qty ?? ''}" placeholder="2"></label>
          <label class="field"><span>Paid each</span><input class="input" type="number" inputmode="decimal" min="0" step="0.01" id="mine-paid" data-mine="paid" value="${m.paid ?? ''}" placeholder="0.00"></label>
        </div>
        <label class="field"><span>Section / row / seats</span><input class="input" id="mine-seats" data-mine="seats" value="${esc(m.seats)}" placeholder="GA floor, Sec 104 Row F…"></label>
        <label class="field"><span>Doors open${ev.doorsTime ? ` (listed ${esc(fmtTime(ev.doorsTime))})` : ''}</span><input class="input" type="time" id="mine-doors" data-mine="doors" value="${esc((m.doors || '').slice(0, 5))}"></label>
        ${m.qty && m.paid ? `<div class="small muted">Total ${esc(fmtMoney(m.qty * m.paid, ev.currency))}${low != null && m.paid > low ? ` · now listed from ${esc(fmtMoney(low, ev.currency))}` : ''}</div>` : ''}
      </div>` : ''}
    ${m.status === 'tickets' || m.status === 'going' || m.files?.length ? walletHtml(ev) : ''}

    <div class="section-title"><span>Tickets & prices</span></div>
    <div class="card pad">
      ${low != null
        ? `<div class="price-big">${esc(fmtMoney(low, ev.currency))} <small>${ev.priceMax != null && ev.priceMax > low ? `– ${esc(fmtMoney(ev.priceMax, ev.currency))}` : 'lowest'}</small></div>
           <div class="small muted">${{ face: 'Face value on Ticketmaster', resale: `Resale on ${esc(ev.resale?.src || 'SeatGeek')}`, manual: 'Last price you logged' }[lowSource(ev)]}${ev.priceChange ? ` · ${ev.priceChange.dir === 'down' ? '▼' : '▲'} ${esc(fmtMoney(Math.abs(ev.priceChange.to - ev.priceChange.from), ev.currency))} ${esc(timeAgo(ev.priceChange.t))}` : ''}</div>`
        : `<div class="small muted">${ev.source === 'tm' ? 'Ticketmaster hasn’t published prices for this show. Log prices you see (including resale) to track them here.' : 'No price data yet. Log prices you see to track them.'}</div>`}
      ${ev.resale && !ev.resale.gone && ev.priceMin != null ? `<div class="resale-line"><span><i class="sw s1"></i>Face value from <b>${esc(fmtMoney(ev.priceMin, ev.currency))}</b></span><span><i class="sw s2"></i>Resale from <b>${esc(fmtMoney(ev.resale.min, ev.currency))}</b></span></div>` : ''}
      ${hasChartData(ev) ? '<div id="price-chart" class="chart"></div>' : ''}
      ${priceInsights(ev).length ? `<ul class="insights">${priceInsights(ev).map((i) => `<li class="${i.tone}">${esc(i.text)}</li>`).join('')}</ul>` : ''}
      <div class="field-row" style="margin-top:14px">
        <label class="field"><span>Alert me at or under</span><input class="input" type="number" inputmode="decimal" min="0" step="1" id="target-price" data-target value="${m.targetPrice ?? ''}" placeholder="${low != null ? Math.floor(low * 0.85) : 'e.g. 60'}"></label>
        <div class="field"><span>&nbsp;</span><button class="btn block" data-action="log-price">${icon('edit')}Log a price</button></div>
      </div>
      ${m.targetPrice != null ? `<p class="help">${ev.alertedAt ? '🎯 Price is at or under your target.' : `Encore will flag this show when the lowest price hits ${esc(fmtMoney(m.targetPrice, ev.currency))}.`}</p>` : ''}
      <div class="stack" style="margin-top:14px">
        ${ev.url ? `<a class="btn primary block" href="${esc(ev.url)}" target="_blank" rel="noopener">${icon('ticket')}${isCancelled(ev) ? 'View listing' : 'Get tickets'}</a>` : ''}
        ${ev.altUrls?.bit ? `<a class="btn block" href="${esc(ev.altUrls.bit)}" target="_blank" rel="noopener">${icon('ext')}Bandsintown</a>` : ''}
        ${ev.resale?.url || ev.altUrls?.sg ? `<a class="btn block" href="${esc(ev.resale?.url || ev.altUrls.sg)}" target="_blank" rel="noopener">${icon('ext')}SeatGeek listings${ev.resale?.count ? ` (${ev.resale.count})` : ''}</a>` : ''}
        <div class="btn-grid">
          <a class="btn sm" href="https://www.stubhub.com/secure/search?q=${resaleQ}" target="_blank" rel="noopener">StubHub</a>
          <a class="btn sm" href="https://seatgeek.com/search?search=${resaleQ}" target="_blank" rel="noopener">SeatGeek</a>
          <a class="btn sm" href="https://www.vividseats.com/search?searchTerm=${resaleQ}" target="_blank" rel="noopener">Vivid Seats</a>
          <a class="btn sm" href="https://www.google.com/search?q=${encodeURIComponent(`${title} ${v.name || ''} ${ev.date || ''} tickets`)}" target="_blank" rel="noopener">Google</a>
        </div>
      </div>
    </div>

    ${ev.onSale || presales.length ? `
      <div class="section-title"><span>On-sale dates</span></div>
      <div class="card pad">
        ${presales.map((p) => `<div class="presale"><span>${esc(p.name)}${Date.parse(p.end) < Date.now() ? ' <span class="badge">Ended</span>' : ''}</span><span class="muted">${esc(fmtDateTimeISO(p.start))}</span></div>`).join('')}
        ${ev.onSale ? `<div class="presale"><span><b>${Date.parse(ev.onSale) < Date.now() ? 'On sale since' : 'General on-sale'}</b></span><span class="muted">${esc(fmtDateTimeISO(ev.onSale))}</span></div>` : ''}
      </div>` : ''}

    ${history.length ? `
      <div class="section-title"><span>Price history</span></div>
      <div class="list">
        ${history.map((h) => `<div class="row static">
          <div class="grow"><div class="title">${esc(fmtPriceRange(h.min, h.max, ev.currency))}</div>
          <div class="subtitle">${esc(new Date(h.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} · ${h.src === 'manual' ? `You${h.note ? ` — ${esc(h.note)}` : ''}` : h.src === 'resale' ? `Resale (${esc(h.note || 'SeatGeek')})` : 'Ticketmaster face value'}</div></div>
          ${h.src === 'manual' ? `<button class="icon-btn ghost" data-del-price="${h.t}" aria-label="Delete entry">${icon('trash')}</button>` : ''}
        </div>`).join('')}
      </div>` : ''}

    ${others.length ? `<div class="section-title"><span>Also on the bill</span></div><div class="lineup">${others.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</div>` : ''}

    <div class="section-title"><span>Notes</span></div>
    <textarea class="input" id="mine-notes" data-mine="notes" placeholder="Who's going, parking, setlist hopes…">${esc(m.notes)}</textarea>

    ${ev.info || ev.ticketLimit || ev.ageRestricted ? `
      <div class="section-title"><span>Event info</span></div>
      <div class="card pad small" style="white-space:pre-line;color:var(--text-2)">${[ev.ageRestricted ? 'Age restrictions apply.' : '', ev.ticketLimit, ev.info].filter(Boolean).map(esc).join('\n\n')}</div>` : ''}

    ${sameTour.length ? `<div class="section-title"><span>More dates</span></div><div class="shows">${sameTour.map((x) => showCard(x)).join('')}</div>` : ''}

    <div class="section-title"><span>More</span></div>
    <div class="list">
      ${daysUntil(ev.date) != null && daysUntil(ev.date) >= -1 && daysUntil(ev.date) <= 2 ? `<a class="row" href="#/tonight/${encodeURIComponent(ev.id)}"><div class="grow">Show-day view</div>${icon('moon', 'chev')}</a>` : ''}
      <button class="row" data-action="ics"><div class="grow">Add to Calendar</div>${icon('cal', 'chev')}</button>
      <button class="row" data-action="toggle-hide"><div class="grow">${m.hidden ? 'Unhide this show' : 'Hide this show'}</div>${icon(m.hidden ? 'eye' : 'eyeoff', 'chev')}</button>
      ${ev.source === 'manual' ? `<button class="row" data-action="edit-show"><div class="grow">Edit show</div>${icon('edit', 'chev')}</button>
        <button class="row danger" data-action="delete-show"><div class="grow">Delete show</div></button>` : ''}
    </div>
    <p class="help center" style="margin-top:14px">${ev.source === 'manual' ? 'Added by you' : `From ${{ bit: 'Bandsintown', sg: 'SeatGeek', tm: 'Ticketmaster' }[ev.source] || 'Ticketmaster'}`} · first seen ${esc(timeAgo(ev.firstSeen))}${ev.lastSeen ? ` · checked ${esc(timeAgo(ev.lastSeen))}` : ''}</p>
  `;
}

export function wireEvent(root, id, rerender, go) {
  const ev = getState().events[id];
  if (!ev) return;
  // Opening a show clears its "new" flag.
  if (ev.isNew) update((st) => { if (st.events[id]) st.events[id].isNew = false; }, { silent: true });

  mountPriceChart(root.querySelector('#price-chart'), ev);
  wireWallet(root, id);

  root.querySelectorAll('[data-mystatus]').forEach((b) => b.addEventListener('click', () => {
    haptic();
    update((st) => {
      touchMine(st.events[id]).status = b.dataset.mystatus;
    });
  }));

  root.querySelectorAll('[data-mine]').forEach((input) => {
    const key = input.dataset.mine;
    const save = (silent) => update((st) => {
      const e = st.events[id];
      touchMine(e);
      if (key === 'qty' || key === 'paid') {
        const n = parseFloat(input.value);
        e.mine[key] = Number.isFinite(n) && n >= 0 ? n : null;
      } else {
        e.mine[key] = input.value;
      }
    }, { silent });
    input.addEventListener('input', debounce(() => save(true), 400));
    input.addEventListener('change', () => save(true));
  });

  const target = root.querySelector('[data-target]');
  target?.addEventListener('change', () => {
    const n = parseFloat(target.value);
    update((st) => {
      const e = st.events[id];
      touchMine(e).targetPrice = Number.isFinite(n) && n > 0 ? n : null;
      e.alertedAt = null;
      checkTarget(e);
    });
    if (Number.isFinite(n) && n > 0) maybeAskNotifications();
  });

  root.querySelectorAll('[data-del-price]').forEach((b) => b.addEventListener('click', () => {
    const t = +b.dataset.delPrice;
    update((st) => {
      const e = st.events[id];
      e.priceHistory = (e.priceHistory || []).filter((h) => !(h.src === 'manual' && h.t === t));
      checkTarget(e);
    });
  }));
}

function maybeAskNotifications() {
  const s = getState();
  if (s.settings.notify || typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  toast('Tip: turn on notifications in Settings to get alerted on refresh.', { ms: 3800 });
}

export function logPrice(id) {
  const ev = getState().events[id];
  if (!ev) return;
  openSheet({
    title: 'Log a price',
    body: `<p class="help" style="margin:0 4px 12px">Saw a price somewhere (resale, box office, a friend)? Log it to track it over time.</p>
      <div class="field-row">
        <label class="field"><span>Lowest price</span><input class="input" id="lp-min" type="number" inputmode="decimal" min="0" step="0.01" placeholder="85"></label>
        <label class="field"><span>Highest (optional)</span><input class="input" id="lp-max" type="number" inputmode="decimal" min="0" step="0.01"></label>
      </div>
      <label class="field" style="margin-top:12px"><span>Where / note</span><input class="input" id="lp-note" placeholder="StubHub, all-in per ticket" list="lp-sources"></label>
      <datalist id="lp-sources"><option value="StubHub"><option value="SeatGeek"><option value="Vivid Seats"><option value="Ticketmaster resale"><option value="AXS"><option value="Box office"></datalist>
      <button class="btn primary block" style="margin-top:16px" data-save>Save price</button>`,
    onMount: (body, close) => {
      const min = body.querySelector('#lp-min');
      setTimeout(() => min.focus(), 320);
      body.querySelector('[data-save]').onclick = () => {
        const lo = parseFloat(min.value);
        const hi = parseFloat(body.querySelector('#lp-max').value);
        if (!Number.isFinite(lo) || lo < 0) { toast('Enter a price', { error: true }); return; }
        update((st) => {
          const e = st.events[id];
          const prev = lowestKnownPrice(e);
          e.priceHistory = e.priceHistory || [];
          e.priceHistory.push({ t: Date.now(), min: lo, max: Number.isFinite(hi) && hi >= lo ? hi : null, src: 'manual', note: body.querySelector('#lp-note').value.trim() });
          if (prev != null && lo !== prev) e.priceChange = { dir: lo < prev ? 'down' : 'up', from: prev, to: lo, t: Date.now() };
          e.alertedAt = null;
          checkTarget(e);
        });
        close();
        toast('Price logged');
      };
    },
  });
}

export async function shareEvent(id) {
  const ev = getState().events[id];
  if (!ev) return;
  const text = `${eventTitle(ev)} — ${fmtDate(ev.date)}${ev.time ? ` ${fmtTime(ev.time)}` : ''} at ${ev.venue?.name || ''}${ev.venue?.city ? `, ${ev.venue.city}` : ''}`;
  try {
    if (navigator.share) await navigator.share({ title: eventTitle(ev), text, url: ev.url || undefined });
    else { await navigator.clipboard.writeText(`${text}${ev.url ? `\n${ev.url}` : ''}`); toast('Copied to clipboard'); }
  } catch { /* cancelled */ }
}

export async function exportICS(events, filename) {
  if (!events.length) { toast('No dated shows to export'); return; }
  const res = await shareOrDownload(filename, buildICS(events), 'text/calendar');
  if (res === 'downloaded') toast('Calendar file downloaded — open it to add');
}

export async function deleteShow(id, go) {
  const ok = await confirmSheet({ title: 'Delete this show?', message: 'This removes the show and your notes for it.', confirm: 'Delete', danger: true });
  if (!ok) return;
  update((st) => { delete st.events[id]; st.deleted.events[id] = Date.now(); });
  go('#/shows', true);
}

// Manual show entry (also used for editing).
export function openShowForm({ artistId = null, eventId = null, status = '' } = {}) {
  const s = getState();
  const ev = eventId ? s.events[eventId] : null;
  if (!s.artists.length && !ev) {
    toast('Add an artist first');
    location.hash = '#/artists?add=1';
    return;
  }
  const sel = ev?.artistIds?.[0] || artistId || s.artists[0]?.id;
  const v = ev?.venue || {};
  openSheet({
    title: ev ? 'Edit show' : 'Add a show',
    body: `
      <div class="stack">
        <label class="field"><span>Artist</span>
          <select class="input" id="sf-artist">${[...s.artists].sort((a, b) => a.name.localeCompare(b.name)).map((a) => `<option value="${esc(a.id)}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
        </label>
        <div class="field-row">
          <label class="field"><span>Date</span><input class="input" id="sf-date" type="date" value="${esc(ev?.date || '')}" required></label>
          <label class="field"><span>Time</span><input class="input" id="sf-time" type="time" value="${esc(ev?.time?.slice(0, 5) || '')}"></label>
        </div>
        <label class="field"><span>Venue</span><input class="input" id="sf-venue" value="${esc(v.name || '')}" placeholder="Red Rocks Amphitheatre"></label>
        <div class="field-row">
          <label class="field"><span>City</span><input class="input" id="sf-city" value="${esc(v.city || '')}" placeholder="Morrison"></label>
          <label class="field"><span>State / region</span><input class="input" id="sf-region" value="${esc(v.region || '')}" placeholder="CO"></label>
        </div>
        <label class="field"><span>My plans</span>
          <select class="input" id="sf-status">${[['', 'None'], ['interested', 'Interested'], ['going', 'Going / went'], ['tickets', 'Got tickets']].map(([k, l]) => `<option value="${k}" ${(ev ? ev.mine?.status || '' : status) === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Tour / event name (optional)</span><input class="input" id="sf-name" value="${esc(ev?.name || '')}"></label>
        <label class="field"><span>Ticket link (optional)</span><input class="input" id="sf-url" type="url" inputmode="url" value="${esc(ev?.url || '')}" placeholder="https://"></label>
        ${ev ? '' : `<div class="field-row">
          <label class="field"><span>Price from (optional)</span><input class="input" id="sf-min" type="number" inputmode="decimal" min="0" step="0.01"></label>
          <label class="field"><span>Price to</span><input class="input" id="sf-max" type="number" inputmode="decimal" min="0" step="0.01"></label>
        </div>`}
        <button class="btn primary block" data-save>${ev ? 'Save changes' : 'Add show'}</button>
      </div>`,
    onMount: (body, close) => {
      body.querySelector('[data-save]').onclick = async () => {
        const g = (x) => body.querySelector(x)?.value.trim() || '';
        const date = g('#sf-date');
        if (!date) { toast('Pick a date', { error: true }); return; }
        const city = g('#sf-city');
        const region = g('#sf-region');
        let coords = { lat: v.lat ?? null, lon: v.lon ?? null };
        if (city && (!ev || city !== v.city || region !== v.region)) {
          try {
            const r = await geocodeCity(city);
            const best = r.find((x) => !region || x.label.toLowerCase().includes(region.toLowerCase())) || r[0];
            if (best) coords = { lat: best.lat, lon: best.lon };
          } catch { /* distance just won't show */ }
        }
        const time = g('#sf-time');
        const lo = parseFloat(g('#sf-min'));
        const hi = parseFloat(g('#sf-max'));
        const id = ev?.id || uid('m');
        update((st) => {
          const existing = st.events[id];
          const base = existing || {
            id, source: 'manual', firstSeen: Date.now(), isNew: false, delisted: false, priceHistory: [], priceChange: null,
            statusChange: null, altUrls: {}, mine: emptyMine(), presales: [], lineup: [], status: 'onsale', currency: 'USD',
            priceMin: null, priceMax: null, image: '', info: '', onSale: '', timezone: '', dateTime: null,
          };
          Object.assign(base, {
            artistIds: [g('#sf-artist')],
            date,
            time: time ? `${time}:00` : null,
            name: g('#sf-name'),
            url: g('#sf-url'),
            venue: { name: g('#sf-venue'), city, region, country: '', address: '', ...coords },
            lastSeen: Date.now(),
          });
          const newStatus = body.querySelector('#sf-status').value;
          if ((base.mine?.status || '') !== newStatus) touchMine(base).status = newStatus;
          if (!existing && Number.isFinite(lo)) {
            base.priceHistory.push({ t: Date.now(), min: lo, max: Number.isFinite(hi) && hi >= lo ? hi : null, src: 'manual', note: 'Added with show' });
          }
          st.events[id] = base;
        });
        close();
        toast(ev ? 'Show updated' : 'Show added');
        if (!ev) location.hash = `#/event/${encodeURIComponent(id)}`;
      };
    },
  });
}

// =====================================================================
// Settings
// =====================================================================
export function renderSettings() {
  const s = getState();
  const st = s.settings;
  const notifSupported = typeof Notification !== 'undefined';
  const kb = Math.max(1, Math.round(storageBytes() / 1024));
  return `
    ${header({ title: 'Settings' })}

    <div class="section-title"><span>Ticketmaster</span>${st.tmKey ? '<span class="badge good">Connected</span>' : ''}</div>
    <div class="card pad stack">
      <label class="field"><span>API key (Consumer Key)</span>
        <input class="input" id="set-tm" value="${esc(st.tmKey)}" placeholder="Paste your key" autocomplete="off" autocapitalize="off" spellcheck="false">
      </label>
      <div class="hstack"><button class="btn sm primary" data-action="save-tm">Save & test</button>${st.tmKey ? '<button class="btn sm" data-action="clear-tm">Remove</button>' : ''}</div>
      <details ${st.tmKey ? '' : 'open'}>
        <summary class="small" style="font-weight:650">How to get a free key (2 minutes)</summary>
        <ol class="steps">
          <li>Open <a href="https://developer-acct.ticketmaster.com/user/register" target="_blank" rel="noopener">developer.ticketmaster.com</a> and sign up (free).</li>
          <li>Go to <b>My Apps</b> — a default app is created for you.</li>
          <li>Copy the <b>Consumer Key</b> and paste it above.</li>
        </ol>
        <p class="help">The key is stored only on this phone and sent only to Ticketmaster. Free keys allow 5,000 requests a day — plenty for hundreds of artists.</p>
      </details>
      <label class="field"><span>Only search in country (optional)</span>
        <select class="input" id="set-country">
          ${[['', 'All countries'], ['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['IE', 'Ireland'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['MX', 'Mexico'], ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'], ['NL', 'Netherlands'], ['BE', 'Belgium'], ['SE', 'Sweden'], ['NO', 'Norway'], ['DK', 'Denmark'], ['PL', 'Poland']]
            .map(([c, n]) => `<option value="${c}" ${st.countryCode === c ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </label>
    </div>

    <div class="section-title"><span>Bandsintown (optional)</span>${st.bitAppId ? '<span class="badge good">On</span>' : ''}</div>
    <div class="card pad stack">
      <label class="field"><span>App ID</span><input class="input" id="set-bit" value="${esc(st.bitAppId)}" placeholder="Your Bandsintown app_id" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <button class="btn sm" data-action="save-bit" style="align-self:flex-start">Save</button>
      <p class="help" style="margin:0">Adds tour dates that aren't sold through Ticketmaster (no prices). Bandsintown issues app IDs to artists and partners via their <a href="https://help.artists.bandsintown.com/en/articles/9186477-api-documentation" target="_blank" rel="noopener">API program</a>.</p>
    </div>

    <div class="section-title"><span>SeatGeek resale prices (optional)</span>${st.sgClientId ? '<span class="badge good">On</span>' : ''}</div>
    <div class="card pad stack">
      <label class="field"><span>Client ID</span><input class="input" id="set-sg" value="${esc(st.sgClientId)}" placeholder="Your SeatGeek client_id" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="hstack"><button class="btn sm" data-action="save-sg">Save</button>${st.sgClientId ? '<button class="btn sm" data-action="clear-sg">Remove</button>' : ''}</div>
      <p class="help" style="margin:0">Adds live resale prices (lowest, average, number of listings) to each show and tracks them over time. Register an app at <a href="https://seatgeek.com/account/develop" target="_blank" rel="noopener">seatgeek.com/account/develop</a> to get a client ID.</p>
    </div>

    ${syncSettingsHtml()}

    <div class="section-title"><span>Home location</span></div>
    <div class="card pad stack">
      ${st.home ? `<div class="hstack" style="justify-content:space-between"><div><b>${esc(st.home.label)}</b><div class="small muted">Used for “Near me” and distances</div></div><button class="btn sm" data-action="clear-home">Clear</button></div>` : '<p class="small muted" style="margin:0">Set a home city to see distances and filter shows near you.</p>'}
      <div class="search">${icon('search')}<input class="input" id="set-city" type="search" placeholder="Search a city" autocomplete="off"></div>
      <div id="city-results"></div>
      <button class="btn sm" data-action="use-location" style="align-self:flex-start">${icon('pin')}Use my current location</button>
      <label class="field"><span>“Near me” radius: <b id="radius-val">${st.radius} ${st.units}</b></span>
        <input type="range" class="range" id="set-radius" min="10" max="500" step="10" value="${st.radius}">
      </label>
      <div class="hstack" style="justify-content:space-between">
        <span>Units</span>
        <div class="segmented" style="width:140px">${['mi', 'km'].map((u) => `<button class="${st.units === u ? 'active' : ''}" data-units="${u}">${u}</button>`).join('')}</div>
      </div>
      <div class="hstack" style="justify-content:space-between">
        <div><div>Hide far-away shows</div><div class="small muted">In the “All” list, only show shows inside your radius</div></div>
        <label class="switch"><input type="checkbox" id="set-hidefar" ${st.hideFarAway ? 'checked' : ''} ${st.home ? '' : 'disabled'}><span class="track"></span></label>
      </div>
    </div>

    <div class="section-title"><span>Updates</span></div>
    <div class="card pad stack">
      <label class="field"><span>Check for new shows & prices when opened, if older than</span>
        <select class="input" id="set-auto">
          ${[[0, 'Never (manual only)'], [1, '1 hour'], [3, '3 hours'], [6, '6 hours'], [12, '12 hours'], [24, '1 day']]
            .map(([h, l]) => `<option value="${h}" ${+st.autoRefreshHours === h ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <div class="hstack" style="justify-content:space-between">
        <div><div>Notifications</div><div class="small muted">${notifSupported ? 'Alerts when Encore refreshes while open. For alerts while closed, turn on background alerts under Sync.' : 'Install Encore to your Home Screen (iOS 16.4+) to enable'}</div></div>
        <label class="switch"><input type="checkbox" id="set-notify" ${st.notify && notifSupported && Notification.permission === 'granted' ? 'checked' : ''} ${notifSupported ? '' : 'disabled'}><span class="track"></span></label>
      </div>
      <p class="help" style="margin:0">Encore checks for updates whenever you open it. Last full check: ${esc(timeAgo(s.lastRefresh))}.</p>
    </div>

    <div class="section-title"><span>Appearance</span></div>
    <div class="segmented">${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button class="${st.theme === k ? 'active' : ''}" data-theme-set="${k}">${l}</button>`).join('')}</div>

    <div class="section-title"><span>Your data</span><span class="small muted" style="text-transform:none;letter-spacing:0">${kb} KB on this device</span></div>
    <div class="list">
      <button class="row" data-action="export"><div class="grow"><div class="title">Back up</div><div class="subtitle">Save a file with artists, shows, notes & ticket files</div></div>${icon('upload', 'chev')}</button>
      <label class="row" style="cursor:pointer"><div class="grow"><div class="title">Restore from backup</div><div class="subtitle">Replaces what's on this device</div></div>${icon('download', 'chev')}<input type="file" id="import-file" accept="application/json,.json" hidden></label>
      <button class="row" data-action="export-all-ics"><div class="grow"><div class="title">Export my shows to Calendar</div><div class="subtitle">Interested, Going & Got tickets</div></div>${icon('cal', 'chev')}</button>
      <button class="row danger" data-action="reset"><div class="grow">Erase everything</div></button>
    </div>

    <div class="section-title"><span>About</span></div>
    <div class="card pad small muted stack">
      <p style="margin:0"><b style="color:var(--text)">Encore</b> keeps everything on this phone — no account, no tracking. Show data comes from the Ticketmaster Discovery API and, optionally, Bandsintown. Ticketmaster prices are face-value ranges and may not include fees or resale.</p>
      ${isIOS && !isStandalone() ? '<p style="margin:0">To install: tap <b>Share</b> → <b>Add to Home Screen</b>. Installed apps keep their data and can send notifications.</p>' : ''}
    </div>
  `;
}

export function wireSettings(root, rerender) {
  const set = (fn, opts) => update((st) => fn(st.settings), opts);

  root.querySelector('[data-action="save-tm"]')?.addEventListener('click', async (e) => {
    const key = root.querySelector('#set-tm').value.trim();
    if (!key) { toast('Paste a key first', { error: true }); return; }
    e.currentTarget.disabled = true;
    e.currentTarget.innerHTML = '<span class="spinner"></span>';
    try {
      await tmSearchArtists('Taylor Swift', key);
      set((x) => { x.tmKey = key; });
      toast('Ticketmaster connected ✓');
      const s = getState();
      if (s.artists.some((a) => !a.tmId)) toast('Tip: open an artist added by name and tap “Link to Ticketmaster”.', { ms: 4200 });
      window.dispatchEvent(new CustomEvent('encore:refresh'));
    } catch (err) {
      toast(err.message || 'That key did not work', { error: true, ms: 4000 });
      rerender();
    }
  });
  root.querySelector('[data-action="clear-tm"]')?.addEventListener('click', () => set((x) => { x.tmKey = ''; }));
  root.querySelector('[data-action="save-bit"]')?.addEventListener('click', () => {
    set((x) => { x.bitAppId = root.querySelector('#set-bit').value.trim(); });
    toast('Saved');
  });
  root.querySelector('[data-action="save-sg"]')?.addEventListener('click', () => {
    set((x) => { x.sgClientId = root.querySelector('#set-sg').value.trim(); });
    toast('Saved — resale prices load on the next refresh');
  });
  root.querySelector('[data-action="clear-sg"]')?.addEventListener('click', () => set((x) => { x.sgClientId = ''; }));
  wireSyncSettings(root, rerender);
  root.querySelector('#set-country')?.addEventListener('change', (e) => set((x) => { x.countryCode = e.target.value; }));

  // City search
  const cityInput = root.querySelector('#set-city');
  const cityOut = root.querySelector('#city-results');
  cityInput?.addEventListener('input', debounce(async () => {
    const q = cityInput.value.trim();
    if (q.length < 2) { cityOut.innerHTML = ''; return; }
    cityOut.innerHTML = '<div class="loading-row"><span class="spinner"></span></div>';
    try {
      const r = await geocodeCity(q);
      cityOut.innerHTML = r.length ? `<div class="list" style="box-shadow:none;background:var(--surface-2)">${r.map((c, i) => `<button class="row" data-city="${i}"><div class="grow">${esc(c.label)}</div></button>`).join('')}</div>` : '<p class="help">No matches.</p>';
      cityOut.querySelectorAll('[data-city]').forEach((b) => b.addEventListener('click', () => {
        set((x) => { x.home = r[+b.dataset.city]; });
        toast(`Home set to ${r[+b.dataset.city].label}`);
      }));
    } catch (e) {
      cityOut.innerHTML = `<p class="help" style="color:var(--bad)">${esc(e.message)}</p>`;
    }
  }, 350));
  root.querySelector('[data-action="use-location"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.innerHTML = '<span class="spinner"></span> Locating…';
    try {
      const p = await currentPosition();
      const label = await reverseLabel(p.lat, p.lon);
      set((x) => { x.home = { label, ...p }; });
      toast('Home location set');
    } catch (err) {
      toast(err.message, { error: true });
      rerender();
    }
  });
  root.querySelector('[data-action="clear-home"]')?.addEventListener('click', () => set((x) => { x.home = null; x.hideFarAway = false; }));
  const radius = root.querySelector('#set-radius');
  radius?.addEventListener('input', () => {
    root.querySelector('#radius-val').textContent = `${radius.value} ${getState().settings.units}`;
    set((x) => { x.radius = +radius.value; }, { silent: true });
  });
  radius?.addEventListener('change', () => set((x) => { x.radius = +radius.value; }));
  root.querySelectorAll('[data-units]').forEach((b) => b.addEventListener('click', () => set((x) => { x.units = b.dataset.units; })));
  root.querySelector('#set-hidefar')?.addEventListener('change', (e) => set((x) => { x.hideFarAway = e.target.checked; }));
  root.querySelector('#set-auto')?.addEventListener('change', (e) => set((x) => { x.autoRefreshHours = +e.target.value; }));

  root.querySelector('#set-notify')?.addEventListener('change', async (e) => {
    if (e.target.checked) {
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toast(perm === 'denied' ? 'Notifications are blocked — enable them in iOS Settings → Notifications → Encore.' : 'Notifications not enabled', { error: true, ms: 4500 });
        e.target.checked = false;
        set((x) => { x.notify = false; });
        return;
      }
      set((x) => { x.notify = true; });
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.showNotification('Notifications on', { body: 'Encore will alert you about new shows and price drops.', icon: 'icons/icon-192.png' });
      } catch { /* ignore */ }
    } else {
      set((x) => { x.notify = false; });
    }
  });

  root.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => set((x) => { x.theme = b.dataset.themeSet; })));

  root.querySelector('#import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ok = await confirmSheet({ title: 'Restore backup?', message: 'This replaces all artists, shows and notes on this device with the backup.', confirm: 'Restore', danger: true });
    if (!ok) { e.target.value = ''; return; }
    try {
      const data = JSON.parse(await file.text());
      importJSON(data);
      let restored = 0;
      for (const f of data.files || []) {
        try {
          await putFile({ ...f, blob: await dataURLToBlob(f.dataURL), dataURL: undefined });
          restored++;
        } catch { /* skip */ }
      }
      toast(`Backup restored${restored ? ` with ${restored} ticket file${restored > 1 ? 's' : ''}` : ''}`);
    } catch (err) {
      toast(err.message || 'Could not read that file', { error: true });
    }
  });
}

export async function exportBackup() {
  const name = `encore-backup-${todayStr()}.json`;
  let files = [];
  try {
    const all = await allFiles();
    let total = 0;
    for (const f of all) {
      total += f.blob?.size || 0;
      if (total > 40e6) { toast('Ticket files are large — some were left out of the backup.'); break; }
      files.push({ id: f.id, eventId: f.eventId, name: f.name, type: f.type, size: f.size, addedAt: f.addedAt, dataURL: await blobToDataURL(f.blob) });
    }
  } catch { files = []; }
  const json = exportJSON({ files });
  const res = await shareOrDownload(name, json, 'application/json');
  if (res === 'downloaded') toast('Backup saved');
}

export async function resetData() {
  const ok = await confirmSheet({ title: 'Erase everything?', message: 'All artists, shows, notes, price history and keys on this device will be deleted. Make a backup first if you might want them.', confirm: 'Erase', danger: true });
  if (!ok) return;
  resetAll();
  toast('All data erased');
}

function notFound(msg) {
  return `${header({ title: '', small: true, left: backBtn() })}<div class="empty"><h2>${esc(msg)}</h2><p><a href="#/shows">Back to shows</a></p></div>`;
}

export { closeSheet };
