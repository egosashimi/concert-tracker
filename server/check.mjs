// Encore background alerts — runs on a schedule in GitHub Actions.
//
// Reads your synced data from your private Gist, checks Ticketmaster (and SeatGeek if configured)
// for your artists and venues, and sends a Web Push notification to your phone about:
//   new shows · price drops · prices at/under your target · cancellations/reschedules ·
//   presales/on-sales starting soon · show-day reminders.
// What it already notified is remembered in encore-server.json in the same Gist.
//
// Env: ENCORE_GIST_ID, ENCORE_GIST_TOKEN (a GitHub token with the "gist" scope).

import webpush from 'web-push';
import {
  tmArtistEvents, tmPlaceEvents, sgFindPerformer, sgPerformerEvents, sameShow,
} from '../js/api.js';
import { sleep, fmtMoney } from '../js/util.js';

const GIST_ID = process.env.ENCORE_GIST_ID;
const TOKEN = process.env.ENCORE_GIST_TOKEN;
const DRY_RUN = process.env.ENCORE_DRY_RUN === '1';
const API = process.env.ENCORE_GITHUB_API || 'https://api.github.com';
const DAY = 86400000;

const log = (...a) => console.log(...a);

async function gh(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'encore-background-alerts',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function readFile(gist, name) {
  const f = gist.files?.[name];
  if (!f) return null;
  let text = f.content;
  if (f.truncated && f.raw_url) text = await (await fetch(f.raw_url, { headers: { Authorization: `Bearer ${TOKEN}` } })).text();
  try { return JSON.parse(text); } catch { return null; }
}

/** Today's date (YYYY-MM-DD) and hour in a given IANA time zone. */
function localNow(tz) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: +parts.hour };
  } catch {
    return { date: new Date().toISOString().slice(0, 10), hour: new Date().getUTCHours() };
  }
}

const fmtShort = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'TBA');
const place = (ev) => ev.venue?.city || ev.venue?.name || '';
const low = (ev) => {
  const v = [ev.priceMin, ev.resale?.min].filter((x) => x != null);
  return v.length ? Math.min(...v) : null;
};

export async function run({ sendPush = defaultSend } = {}) {
  if (!GIST_ID || !TOKEN) {
    log('ENCORE_GIST_ID / ENCORE_GIST_TOKEN secrets are not set — nothing to do. See the Sync section in Encore’s Settings.');
    return { skipped: true };
  }
  const gist = await gh(`/gists/${GIST_ID}`);
  const data = await readFile(gist, 'encore.json');
  const push = await readFile(gist, 'encore-push.json');
  const server = (await readFile(gist, 'encore-server.json')) || {};
  server.seen ||= {};
  server.prices ||= {};
  server.status ||= {};
  server.notified ||= {};

  if (!data) throw new Error('encore.json missing from the gist — open Encore and tap Sync now.');
  const subs = push?.subscriptions || [];
  if (!subs.length || !push?.vapid?.privateKey) {
    log('No devices have background alerts turned on yet.');
  }
  const { tmKey, sgClientId, countryCode } = data.settings || {};
  if (!tmKey && !sgClientId) {
    log('No Ticketmaster key or SeatGeek client ID in your Encore settings.');
  }

  const notes = [];
  const note = (n) => notes.push(n);
  const now = Date.now();
  const tzGuess = Object.values(data.events || {}).find((e) => e.timezone)?.timezone || 'America/New_York';
  const today = localNow(tzGuess).date;
  const known = data.events || {};
  let errors = 0;

  // ---------- Artists ----------
  for (const artist of data.artists || []) {
    let events = [];
    if (tmKey && artist.tmId) {
      try {
        events = await tmArtistEvents(artist.tmId, tmKey, countryCode);
      } catch (e) {
        errors++;
        log(`TM ${artist.name}: ${e.message}`);
        if (e.fatal) break;
      }
      await sleep(250);
    }
    let resale = [];
    if (sgClientId) {
      try {
        let id = artist.sgId;
        if (!id) id = String((await sgFindPerformer(artist.name, sgClientId))?.id || '');
        if (id) resale = await sgPerformerEvents(id, sgClientId);
      } catch (e) {
        log(`SG ${artist.name}: ${e.message}`);
      }
    }
    // Attach resale to matching TM shows; SeatGeek-only shows stand alone.
    for (const r of resale) {
      const match = events.find((e) => sameShow(e, r));
      if (match) match.resale = r.resale;
      else events.push(r);
    }
    for (const ev of events) {
      if (!ev.date || ev.date < today) continue;
      const k = known[ev.id] || Object.values(known).find((x) => x.artistIds?.includes(artist.id) && sameShow(x, ev));
      const id = k?.id || ev.id;
      const name = artist.name;

      // New show (only once the phone has checked this artist at least once).
      if (!k && !server.seen[ev.id] && artist.lastChecked) {
        note({ kind: 'new', id, text: `🆕 ${name} — ${fmtShort(ev.date)}, ${place(ev)}` });
      }
      server.seen[ev.id] = now;

      // Status change
      const prevStatus = server.status[id] ?? k?.status;
      if (prevStatus && ev.status && prevStatus !== ev.status && ['cancelled', 'canceled', 'postponed', 'rescheduled'].includes(ev.status)) {
        note({ kind: 'status', id, text: `⚠️ ${name} ${fmtShort(ev.date)} is ${ev.status}` });
      }
      server.status[id] = ev.status;

      // Price drop vs. what we (or the phone) last saw
      const price = low(ev);
      const prev = server.prices[id] ?? (k ? low(k) : null);
      if (price != null && prev != null && price < prev - 0.5 && (k?.mine?.status || k?.mine?.targetPrice != null || prev - price >= 10)) {
        note({ kind: 'drop', id, text: `⬇️ ${name} ${fmtShort(ev.date)}: now ${fmtMoney(price, ev.currency)} (was ${fmtMoney(prev, ev.currency)})` });
      }
      if (price != null) server.prices[id] = price;

      // Target price
      const target = k?.mine?.targetPrice;
      const tKey = `target:${id}`;
      if (target != null && price != null) {
        if (price <= target && !server.notified[tKey]) {
          note({ kind: 'target', id, text: `🎯 ${name} ${fmtShort(ev.date)} hit your target: ${fmtMoney(price, ev.currency)}` });
          server.notified[tKey] = now;
        } else if (price > target) {
          delete server.notified[tKey];
        }
      }

      // Presale / general on-sale starting within the next 3 hours
      const starts = [...(ev.presales || []).map((p) => [p.name, p.start]), ['General on-sale', ev.onSale]]
        .filter(([, t]) => t && Date.parse(t) > now && Date.parse(t) - now < 3 * 3600000);
      for (const [label, t] of starts) {
        const oKey = `onsale:${id}:${t}`;
        if (server.notified[oKey]) continue;
        server.notified[oKey] = now;
        const when = new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ev.timezone || tzGuess });
        note({ kind: 'onsale', id, text: `⏰ ${name} ${fmtShort(ev.date)}: ${label} starts ${when}` });
      }
    }
  }

  // ---------- Followed venues (new shows only; areas are too noisy for pushes) ----------
  if (tmKey) {
    for (const p of (data.places || []).filter((x) => x.kind === 'venue' && x.lastChecked)) {
      try {
        const evs = await tmPlaceEvents(p, tmKey, { pages: 1 });
        for (const ev of evs) {
          if (!ev.date || ev.date < today) continue;
          if (!known[ev.id] && !server.seen[ev.id]) {
            note({ kind: 'venue', id: ev.id, text: `📍 ${p.name}: ${ev.lineup?.[0] || ev.name} — ${fmtShort(ev.date)}` });
          }
          server.seen[ev.id] = now;
        }
      } catch (e) {
        errors++;
        log(`Venue ${p.name}: ${e.message}`);
      }
      await sleep(250);
    }
  }

  // ---------- Show-day reminders ----------
  for (const ev of Object.values(known)) {
    if (!['going', 'tickets'].includes(ev.mine?.status) || !ev.date) continue;
    const local = localNow(ev.timezone || tzGuess);
    const dKey = `day:${ev.id}`;
    if (ev.date === local.date && local.hour >= 9 && !server.notified[dKey]) {
      server.notified[dKey] = now;
      const names = (ev.artistIds || []).map((i) => data.artists.find((a) => a.id === i)?.name).filter(Boolean).join(' & ') || ev.lineup?.[0] || ev.name;
      const doors = ev.mine?.doors || ev.doorsTime;
      const t = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
      note({ kind: 'day', id: ev.id, text: `🎶 Tonight: ${names} at ${ev.venue?.name || place(ev)}${doors ? ` · doors ${t(doors)}` : ev.time ? ` · ${t(ev.time)}` : ''}` });
    }
  }

  // ---------- Prune memory ----------
  for (const [k, t] of Object.entries(server.seen)) if (now - t > 150 * DAY) delete server.seen[k];
  for (const [k, t] of Object.entries(server.notified)) if (now - t > 120 * DAY) delete server.notified[k];
  for (const k of Object.keys(server.prices)) if (!server.seen[k] && !known[k]) delete server.prices[k];
  for (const k of Object.keys(server.status)) if (!server.seen[k] && !known[k]) delete server.status[k];

  // ---------- Send ----------
  let sent = 0;
  let removed = 0;
  if (notes.length && subs.length && push?.vapid?.privateKey) {
    const order = ['target', 'status', 'day', 'onsale', 'drop', 'new', 'venue'];
    notes.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const title = notes.length === 1
      ? { target: 'Price alert', status: 'Show update', day: 'Show day', onsale: 'On sale soon', drop: 'Price drop', new: 'New show', venue: 'New at a venue you follow' }[notes[0].kind]
      : `${notes.length} concert updates`;
    const body = notes.slice(0, 5).map((n) => n.text).join('\n') + (notes.length > 5 ? `\n…and ${notes.length - 5} more` : '');
    const payload = JSON.stringify({
      title,
      body,
      url: notes.length === 1 ? `./#/event/${encodeURIComponent(notes[0].id)}` : './#/shows',
      tag: `encore-${now}`,
    });
    const site = process.env.GITHUB_REPOSITORY
      ? `https://${process.env.GITHUB_REPOSITORY.split('/')[0].toLowerCase()}.github.io/${process.env.GITHUB_REPOSITORY.split('/')[1]}/`
      : 'https://github.com/';
    webpush.setVapidDetails(site, push.vapid.publicKey, push.vapid.privateKey);
    const keep = [];
    for (const sub of subs) {
      try {
        if (!DRY_RUN) await sendPush(sub, payload);
        sent++;
        keep.push(sub);
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { removed++; log('Removing expired subscription'); }
        else { keep.push(sub); errors++; log(`Push failed (${e.statusCode || ''}): ${e.body || e.message}`); }
      }
    }
    push.subscriptions = keep;
  }
  log(`${notes.length} update(s); pushed to ${sent} device(s)${removed ? `, removed ${removed} expired` : ''}.`);
  notes.forEach((n) => log('  ', n.text));

  server.lastRun = now;
  server.lastError = errors ? `${errors} request(s) failed — see the Actions log.` : '';
  server.lastNotes = notes.slice(0, 20).map((n) => n.text);
  const files = { 'encore-server.json': { content: JSON.stringify(server) } };
  if (removed) files['encore-push.json'] = { content: JSON.stringify(push, null, 1) };
  if (!DRY_RUN) await gh(`/gists/${GIST_ID}`, { method: 'PATCH', body: JSON.stringify({ files }) });
  return { notes, sent, removed, server };
}

function defaultSend(sub, payload) {
  return webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 6 * 3600, urgency: 'high' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
