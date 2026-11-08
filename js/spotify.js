// Import artists from Spotify using the PKCE flow (no server, no client secret).
// You create a free Spotify developer app, paste its Client ID in Settings, and register this
// page's URL as the Redirect URI.

import { b64urlFromBytes, isStandalone } from './util.js';

const AUTH = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const KEY = 'encore:spotify-pkce';
const SCOPES = 'user-follow-read user-top-read';

export const redirectUri = () => `${location.origin}${location.pathname}`;

function randomString(n = 64) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return b64urlFromBytes(bytes).slice(0, n);
}

export async function startSpotifyLogin(clientId) {
  if (!clientId) throw new Error('Add your Spotify Client ID first.');
  const verifier = randomString(64);
  const challenge = b64urlFromBytes(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const nonce = randomString(16);
  // If iOS opens the login in a separate browser context, localStorage won't be shared;
  // the state then carries what's needed to finish there and hand the list back by copy/paste.
  const state = b64urlFromBytes(new TextEncoder().encode(JSON.stringify({ n: nonce, v: verifier, c: clientId, s: isStandalone() ? 1 : 0 })));
  try { localStorage.setItem(KEY, JSON.stringify({ verifier, nonce, clientId })); } catch { /* ignore */ }
  const url = new URL(AUTH);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state,
  }).toString();
  location.assign(url.toString());
}

/** Detect a Spotify redirect on load. Returns null, or { artists, handoff } / throws. */
export async function handleSpotifyRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return null;
  if (!params.has('state')) return null;
  const clean = () => history.replaceState(null, '', `${location.pathname}#/import`);
  if (params.get('error')) {
    clean();
    throw new Error(params.get('error') === 'access_denied' ? 'Spotify access was cancelled.' : `Spotify error: ${params.get('error')}`);
  }
  let st = {};
  try { st = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(params.get('state').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))); } catch { /* ignore */ }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* ignore */ }
  const verifier = saved?.nonce === st.n ? saved.verifier : st.v;
  const clientId = saved?.clientId || st.c;
  const code = params.get('code');
  clean();
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  if (!verifier || !clientId) throw new Error('Spotify login expired — try again.');

  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: clientId, code_verifier: verifier }),
  });
  if (!res.ok) {
    let msg = 'Spotify login failed.';
    try { const j = await res.json(); msg = j.error_description || j.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const { access_token: token } = await res.json();
  const artists = await fetchSpotifyArtists(token);
  // Started in the installed app but finished in a browser tab with separate storage?
  const handoff = st.s === 1 && !isStandalone() && !saved;
  return { artists, handoff };
}

async function sp(path, token) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    return sp(path, token);
  }
  if (!res.ok) throw new Error(`Spotify API error ${res.status}`);
  return res.json();
}

export async function fetchSpotifyArtists(token) {
  const map = new Map();
  const add = (a, why) => {
    if (!a?.name) return;
    const key = a.id;
    const prev = map.get(key);
    if (prev) { if (!prev.why.includes(why)) prev.why.push(why); return; }
    map.set(key, { name: a.name, image: a.images?.[a.images.length > 1 ? a.images.length - 2 : 0]?.url || '', genre: (a.genres || []).slice(0, 2).join(' · '), why: [why] });
  };
  // Followed artists (cursor paging)
  let after = '';
  for (let i = 0; i < 20; i++) {
    const data = await sp(`/me/following?type=artist&limit=50${after ? `&after=${after}` : ''}`, token);
    (data.artists?.items || []).forEach((a) => add(a, 'Following'));
    after = data.artists?.cursors?.after;
    if (!after) break;
  }
  // Top artists across time ranges
  for (const [range, label] of [['short_term', 'Top lately'], ['medium_term', 'Top 6 months'], ['long_term', 'Top all-time']]) {
    try {
      const data = await sp(`/me/top/artists?time_range=${range}&limit=50`, token);
      (data.items || []).forEach((a) => add(a, label));
    } catch { /* scope may be missing */ }
  }
  return [...map.values()];
}
