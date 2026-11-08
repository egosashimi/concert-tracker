// All app data lives on this device in localStorage. No accounts, no server.
// Optional: a private GitHub Gist mirror for sync and background alerts (see sync.js).

const KEY = 'encore:data:v1';
export const SCHEMA_VERSION = 2;

// Settings that belong to this device only and are never synced.
export const DEVICE_SETTINGS = ['notify', 'sync', 'push'];

export function defaultState() {
  return {
    version: SCHEMA_VERSION,
    settings: {
      tmKey: '',          // Ticketmaster Discovery API key (free)
      bitAppId: '',       // Bandsintown app_id (optional)
      sgClientId: '',     // SeatGeek client_id (optional, resale prices)
      spotifyClientId: '',
      countryCode: '',    // limit Ticketmaster results to a country, e.g. "US"
      home: null,         // { label, lat, lon }
      radius: 100,        // "near me" radius
      units: 'mi',
      autoRefreshHours: 6,
      notify: false,
      theme: 'auto',      // auto | light | dark
      hideFarAway: false,
      sync: { gistId: '', base: 0, lastSync: 0, lastError: '', serverRun: 0, serverError: '' },
      push: { enabled: false, endpoint: '' },
    },
    artists: [],          // { id, name, tmId, sgId, image, genre, genreIds, addedAt, lastChecked, lastError }
    places: [],           // { id, kind: 'venue'|'area', name, tmVenueId, lat, lon, radius, addedAt, lastChecked }
    events: {},           // id -> event (see refresh.js for shape)
    deleted: { artists: {}, places: {}, events: {} }, // tombstones so sync doesn't resurrect deletions
    lastRefresh: 0,
    installHintDismissed: false,
    updatedAt: 0,
    deviceId: '',
  };
}

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? migrate(JSON.parse(raw)) : defaultState();
    if (!s.deviceId) s.deviceId = Math.random().toString(36).slice(2, 10);
    return s;
  } catch (e) {
    console.warn('Could not load saved data', e);
    return defaultState();
  }
}

export function migrate(data) {
  const base = defaultState();
  if (!data || typeof data !== 'object') return base;
  const settings = { ...base.settings, ...(data.settings || {}) };
  settings.sync = { ...base.settings.sync, ...(settings.sync || {}) };
  settings.push = { ...base.settings.push, ...(settings.push || {}) };
  return {
    ...base,
    ...data,
    settings,
    artists: Array.isArray(data.artists) ? data.artists : [],
    places: Array.isArray(data.places) ? data.places : [],
    events: data.events && typeof data.events === 'object' ? data.events : {},
    deleted: { artists: {}, places: {}, events: {}, ...(data.deleted || {}) },
    version: SCHEMA_VERSION,
  };
}

let saveError = null;
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    saveError = null;
  } catch (e) {
    saveError = e;
    console.error('Save failed', e);
  }
}

export const getState = () => state;
export const lastSaveError = () => saveError;

/**
 * Mutate state inside fn, then persist.
 *  silent: skip re-rendering (text fields, so typing isn't interrupted)
 *  touch:  false for bookkeeping that shouldn't count as a user change for sync
 */
export function update(fn, { silent = false, touch = true } = {}) {
  fn(state);
  if (touch) state.updatedAt = Date.now();
  save();
  if (!silent) emit();
}

/** Replace the whole state (used by sync). */
export function replaceState(next, { silent = false } = {}) {
  state = migrate(next);
  save();
  if (!silent) emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.error(e); }
  }
}

export function exportJSON(extra = {}) {
  return JSON.stringify({ app: 'encore', exportedAt: new Date().toISOString(), ...state, ...extra }, null, 2);
}

export function importJSON(text, { keepKeys = true } = {}) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  if (!data || !Array.isArray(data.artists) || typeof data.events !== 'object') {
    throw new Error('That file is not an Encore backup.');
  }
  const next = migrate(data);
  delete next.app;
  delete next.exportedAt;
  delete next.files;
  if (keepKeys) {
    for (const k of ['tmKey', 'bitAppId', 'sgClientId', 'spotifyClientId']) {
      if (!next.settings[k]) next.settings[k] = state.settings[k];
    }
  }
  for (const k of DEVICE_SETTINGS) next.settings[k] = state.settings[k];
  next.deviceId = state.deviceId;
  next.updatedAt = Date.now();
  state = next;
  save();
  emit();
}

export function resetAll() {
  const deviceId = state.deviceId;
  state = defaultState();
  state.deviceId = deviceId;
  save();
  emit();
}

// Ask the browser not to evict our storage (honored by installed home-screen apps).
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* ignore */ }
}

export function storageBytes() {
  try {
    return (localStorage.getItem(KEY) || '').length * 2;
  } catch {
    return 0;
  }
}
