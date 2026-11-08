// Optional sync + background alerts via a private (secret) GitHub Gist.
//
//  encore.json         — your data (artists, shows, notes, settings incl. API keys). Written by the app.
//  encore-push.json    — Web Push subscriptions + the VAPID key pair. Written by the app.
//  encore-server.json  — state of the scheduled GitHub Action (what it already notified). Written by the Action.
//
// The GitHub token lives only in this device's localStorage (never in the gist, backups or exports).

import { getState, update, replaceState, migrate, DEVICE_SETTINGS } from './store.js';
import { b64urlFromBytes, bytesFromB64url, isStandalone } from './util.js';

const TOKEN_KEY = 'encore:gh-token';
const API = 'https://api.github.com';
const DATA_FILE = 'encore.json';
const PUSH_FILE = 'encore-push.json';
const SERVER_FILE = 'encore-server.json';
const DESCRIPTION = 'Encore concert tracker sync (private — do not share)';

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
export const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };
export const syncEnabled = () => !!(getToken() && getState().settings.sync?.gistId);

async function gh(path, { method = 'GET', body, token = getToken() } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401) throw new Error('GitHub rejected the token. Create a new one with the “gist” scope.');
  if (res.status === 404) throw new Error('Sync gist not found (deleted, or the token can’t see it).');
  if (!res.ok) {
    let msg = `GitHub error ${res.status}`;
    try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function fileContent(gist, name) {
  const f = gist.files?.[name];
  if (!f) return null;
  let text = f.content;
  if (f.truncated && f.raw_url) text = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
  try { return JSON.parse(text); } catch { return null; }
}

function snapshot() {
  const s = getState();
  const settings = { ...s.settings };
  for (const k of DEVICE_SETTINGS) delete settings[k];
  return { app: 'encore', ...s, settings };
}

// ---------------- Setup ----------------
export async function verifyToken(token) {
  const res = await fetch(`${API}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error('That token didn’t work. Make sure you copied all of it.');
  const scopes = res.headers.get('x-oauth-scopes');
  if (scopes != null && scopes !== '' && !scopes.split(',').map((x) => x.trim()).includes('gist')) {
    throw new Error('The token is missing the “gist” scope.');
  }
  return (await res.json()).login;
}

/** Find an existing Encore gist for this account (used when setting up a second device). */
export async function findExistingGist(token) {
  for (let page = 1; page <= 5; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`, { token });
    const hit = list.find((g) => g.files?.[DATA_FILE] && /encore/i.test(g.description || ''));
    if (hit) return hit;
    if (list.length < 100) break;
  }
  return null;
}

export async function connect(token) {
  const login = await verifyToken(token);
  setToken(token);
  const existing = await findExistingGist(token);
  if (existing) {
    update((s) => { s.settings.sync = { ...s.settings.sync, gistId: existing.id, base: 0, lastError: '' }; }, { touch: false });
    await syncNow({ preferRemote: true });
    return { login, gistId: existing.id, created: false };
  }
  const gist = await gh('/gists', {
    method: 'POST',
    body: { description: DESCRIPTION, public: false, files: { [DATA_FILE]: { content: JSON.stringify(snapshot()) } } },
  });
  update((s) => { s.settings.sync = { ...s.settings.sync, gistId: gist.id, base: s.updatedAt, lastSync: Date.now(), lastError: '' }; }, { touch: false });
  return { login, gistId: gist.id, created: true };
}

export function disconnect() {
  setToken('');
  update((s) => { s.settings.sync = { gistId: '', base: 0, lastSync: 0, lastError: '', serverRun: 0, serverError: '' }; s.settings.push = { enabled: false, endpoint: '' }; }, { touch: false });
}

// ---------------- Sync ----------------
let syncing = null;
let pushTimer = null;

export function scheduleSync(delay = 4000) {
  if (!syncEnabled()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow().catch(() => {}), delay);
}

export function syncNow(opts = {}) {
  if (!syncEnabled()) return Promise.resolve(null);
  if (syncing) return syncing;
  syncing = doSync(opts).finally(() => { syncing = null; });
  return syncing;
}

async function doSync({ preferRemote = false } = {}) {
  const s = getState();
  const { gistId, base } = s.settings.sync;
  try {
    const gist = await gh(`/gists/${gistId}`);
    const remote = await fileContent(gist, DATA_FILE);
    const server = await fileContent(gist, SERVER_FILE);
    const localDirty = s.updatedAt > base;
    const remoteChanged = remote && remote.updatedAt > base && remote.updatedAt !== s.updatedAt;
    let result = 'up-to-date';

    if (!remote) {
      await pushData();
      result = 'pushed';
    } else if (preferRemote || (remoteChanged && localDirty)) {
      const hasLocal = s.artists.length || Object.keys(s.events).length;
      if (hasLocal) {
        adopt(mergeStates(getState(), remote));
        await pushData();
        result = 'merged';
      } else {
        adopt(remote);
        result = 'pulled';
      }
    } else if (remoteChanged) {
      adopt(remote);
      result = 'pulled';
    } else if (localDirty) {
      await pushData();
      result = 'pushed';
    }
    update((st) => {
      st.settings.sync.lastSync = Date.now();
      st.settings.sync.lastError = '';
      st.settings.sync.serverRun = server?.lastRun || 0;
      st.settings.sync.serverError = server?.lastError || '';
      if (result !== 'pushed') st.settings.sync.base = st.updatedAt;
    }, { touch: false, silent: result === 'up-to-date' || result === 'pushed' });
    return result;
  } catch (e) {
    update((st) => { st.settings.sync.lastError = e.message; }, { touch: false, silent: true });
    throw e;
  }
}

async function pushData() {
  const s = getState();
  const snap = snapshot();
  await gh(`/gists/${s.settings.sync.gistId}`, { method: 'PATCH', body: { files: { [DATA_FILE]: { content: JSON.stringify(snap) } } } });
  update((st) => { st.settings.sync.base = snap.updatedAt; }, { touch: false, silent: true });
}

function adopt(remote) {
  const local = getState();
  const next = migrate(remote);
  delete next.app;
  for (const k of DEVICE_SETTINGS) next.settings[k] = local.settings[k];
  next.deviceId = local.deviceId;
  next.installHintDismissed = local.installHintDismissed;
  // Ticket files are per-device: keep this device's file list on events that exist in both.
  for (const [id, ev] of Object.entries(next.events)) {
    const mineFiles = local.events[id]?.mine?.files;
    if (mineFiles?.length && ev.mine) {
      const ids = new Set((ev.mine.files || []).map((f) => f.id));
      ev.mine.files = [...(ev.mine.files || []), ...mineFiles.filter((f) => !ids.has(f.id))];
    }
  }
  replaceState(next);
}

/** Merge two diverged copies. Deletions win; for each show, the newer "my plans" edit wins. */
export function mergeStates(a, b) {
  const out = migrate(JSON.parse(JSON.stringify(a)));
  const del = {
    artists: { ...(a.deleted?.artists || {}), ...(b.deleted?.artists || {}) },
    places: { ...(a.deleted?.places || {}), ...(b.deleted?.places || {}) },
    events: { ...(a.deleted?.events || {}), ...(b.deleted?.events || {}) },
  };
  out.deleted = del;
  const unionBy = (x = [], y = [], gone = {}) => {
    const map = new Map();
    for (const it of [...x, ...y]) {
      if (gone[it.id]) continue;
      const prev = map.get(it.id);
      map.set(it.id, prev ? ((it.lastChecked || 0) > (prev.lastChecked || 0) ? { ...prev, ...it } : { ...it, ...prev }) : it);
    }
    return [...map.values()];
  };
  out.artists = unionBy(a.artists, b.artists, del.artists);
  out.places = unionBy(a.places, b.places, del.places);
  const events = {};
  for (const id of new Set([...Object.keys(a.events || {}), ...Object.keys(b.events || {})])) {
    if (del.events[id]) continue;
    const x = a.events?.[id];
    const y = b.events?.[id];
    if (!x || !y) { events[id] = JSON.parse(JSON.stringify(x || y)); continue; }
    const fresher = (y.lastSeen || 0) > (x.lastSeen || 0) ? y : x;
    const mine = (y.mine?.t || 0) > (x.mine?.t || 0) ? y.mine : x.mine;
    const hist = new Map();
    for (const h of [...(x.priceHistory || []), ...(y.priceHistory || [])]) hist.set(`${h.t}|${h.src}`, h);
    events[id] = {
      ...JSON.parse(JSON.stringify(fresher)),
      mine: JSON.parse(JSON.stringify(mine || {})),
      artistIds: [...new Set([...(x.artistIds || []), ...(y.artistIds || [])])].filter((i) => !del.artists[i]),
      placeIds: [...new Set([...(x.placeIds || []), ...(y.placeIds || [])])].filter((i) => !del.places[i]),
      priceHistory: [...hist.values()].sort((p, q) => p.t - q.t),
      isNew: x.isNew && y.isNew,
    };
  }
  out.events = events;
  out.settings = { ...a.settings, ...b.settings };
  for (const k of DEVICE_SETTINGS) out.settings[k] = a.settings[k];
  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0) + 1;
  out.lastRefresh = Math.max(a.lastRefresh || 0, b.lastRefresh || 0);
  return out;
}

// ---------------- Web Push (background alerts) ----------------
export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

async function generateVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = new Uint8Array(65);
  pub[0] = 4;
  pub.set(bytesFromB64url(jwk.x), 1);
  pub.set(bytesFromB64url(jwk.y), 33);
  return { publicKey: b64urlFromBytes(pub), privateKey: jwk.d };
}

export async function enablePush() {
  if (!syncEnabled()) throw new Error('Set up sync first.');
  if (!pushSupported()) {
    throw new Error(isStandalone() ? 'This device doesn’t support web push.' : 'Open Encore from your Home Screen to turn on background alerts (iOS 16.4+).');
  }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked — allow them in iOS Settings → Notifications → Encore.');

  const s = getState();
  const gist = await gh(`/gists/${s.settings.sync.gistId}`);
  const push = (await fileContent(gist, PUSH_FILE)) || { subscriptions: [] };
  if (!push.vapid?.publicKey) push.vapid = await generateVapid();

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const key = sub.options?.applicationServerKey;
    const same = key && b64urlFromBytes(key) === push.vapid.publicKey;
    if (!same) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesFromB64url(push.vapid.publicKey) });
  }
  const json = sub.toJSON();
  push.subscriptions = (push.subscriptions || []).filter((x) => x.endpoint !== json.endpoint && x.deviceId !== s.deviceId);
  push.subscriptions.push({ endpoint: json.endpoint, keys: json.keys, deviceId: s.deviceId, addedAt: Date.now(), ua: navigator.userAgent.slice(0, 120) });
  await gh(`/gists/${s.settings.sync.gistId}`, { method: 'PATCH', body: { files: { [PUSH_FILE]: { content: JSON.stringify(push, null, 1) } } } });
  update((st) => { st.settings.push = { enabled: true, endpoint: json.endpoint }; st.settings.notify = true; }, { touch: false });
  await syncNow();
}

export async function disablePush() {
  const s = getState();
  try {
    const reg = await navigator.serviceWorker?.ready;
    const sub = await reg?.pushManager?.getSubscription();
    await sub?.unsubscribe();
    if (syncEnabled()) {
      const gist = await gh(`/gists/${s.settings.sync.gistId}`);
      const push = await fileContent(gist, PUSH_FILE);
      if (push) {
        push.subscriptions = (push.subscriptions || []).filter((x) => x.deviceId !== s.deviceId);
        await gh(`/gists/${s.settings.sync.gistId}`, { method: 'PATCH', body: { files: { [PUSH_FILE]: { content: JSON.stringify(push, null, 1) } } } });
      }
    }
  } finally {
    update((st) => { st.settings.push = { enabled: false, endpoint: '' }; }, { touch: false });
  }
}

/** The repo hosting this app, when served from GitHub Pages (owner.github.io/repo/). */
export function hostingRepo() {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/i);
  if (!m) return null;
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return repo ? `${m[1]}/${repo}` : `${m[1]}/${m[1]}.github.io`;
}
