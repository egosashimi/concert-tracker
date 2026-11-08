// All app data lives on this device in localStorage. No accounts, no server.

const KEY = 'encore:data:v1';
export const SCHEMA_VERSION = 1;

export function defaultState() {
  return {
    version: SCHEMA_VERSION,
    settings: {
      tmKey: '',          // Ticketmaster Discovery API key (free)
      bitAppId: '',       // Bandsintown app_id (optional)
      countryCode: '',    // limit Ticketmaster results to a country, e.g. "US"
      home: null,         // { label, lat, lon }
      radius: 100,        // "near me" radius
      units: 'mi',
      autoRefreshHours: 6,
      notify: false,
      theme: 'auto',      // auto | light | dark
      hideFarAway: false,
    },
    artists: [],          // { id, name, tmId, image, genre, addedAt, lastChecked, lastError }
    events: {},           // id -> event (see refresh.js for shape)
    lastRefresh: 0,
    installHintDismissed: false,
  };
}

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    return migrate(JSON.parse(raw));
  } catch (e) {
    console.warn('Could not load saved data', e);
    return defaultState();
  }
}

function migrate(data) {
  const base = defaultState();
  if (!data || typeof data !== 'object') return base;
  return {
    ...base,
    ...data,
    settings: { ...base.settings, ...(data.settings || {}) },
    artists: Array.isArray(data.artists) ? data.artists : [],
    events: data.events && typeof data.events === 'object' ? data.events : {},
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
 * Mutate state inside fn, then persist. Pass { silent: true } to skip re-rendering
 * (used for text fields so typing isn't interrupted).
 */
export function update(fn, { silent = false } = {}) {
  fn(state);
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

export function exportJSON() {
  return JSON.stringify({ app: 'encore', exportedAt: new Date().toISOString(), ...state }, null, 2);
}

export function importJSON(text, { keepKeys = true } = {}) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.artists) || typeof data.events !== 'object') {
    throw new Error('That file is not an Encore backup.');
  }
  const next = migrate(data);
  delete next.app;
  delete next.exportedAt;
  if (keepKeys) {
    // Don't wipe API keys already set on this phone if the backup has none.
    if (!next.settings.tmKey) next.settings.tmKey = state.settings.tmKey;
    if (!next.settings.bitAppId) next.settings.bitAppId = state.settings.bitAppId;
  }
  state = next;
  save();
  emit();
}

export function resetAll() {
  state = defaultState();
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
