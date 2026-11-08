// Offline self-test for check.mjs: stubs GitHub, Ticketmaster and SeatGeek, and verifies
// browser-generated VAPID keys work with web-push. Run: node server/selftest.mjs
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { webcrypto } from 'node:crypto';

process.env.ENCORE_GIST_ID = 'gist123';
process.env.ENCORE_GIST_TOKEN = 'tok';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// VAPID keys exactly as the app makes them (sync.js generateVapid)
const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
const vapid = { publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])), privateKey: jwk.d };
// A fake browser subscription
const ua = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const p256dh = b64u(await webcrypto.subtle.exportKey('raw', ua.publicKey));
const sub = { endpoint: 'https://web.push.apple.com/QAbc', keys: { p256dh, auth: b64u(webcrypto.getRandomValues(new Uint8Array(16))) } };
webpush.setVapidDetails('https://example.github.io/concert-tracker/', vapid.publicKey, vapid.privateKey);
const details = webpush.generateRequestDetails(sub, '{"title":"x"}');
assert.match(details.headers.Authorization, /^vapid t=/);
console.log('✓ browser-format VAPID keys accepted by web-push');

const tmEv = (id, n, city, min, extra = {}) => ({
  id, name: 'Tour', url: 'u', dates: { start: { localDate: day(n), localTime: '20:00:00' }, timezone: 'America/Chicago', status: { code: extra.status || 'onsale' } },
  sales: { public: { startDateTime: extra.onsale || '2026-01-01T00:00:00Z' }, presales: extra.presales || [] },
  priceRanges: min != null ? [{ min, max: min * 2, currency: 'USD' }] : undefined,
  _embedded: { venues: [{ name: `${city} Arena`, city: { name: city }, location: { latitude: '30', longitude: '-97' } }], attractions: [{ id: 'K1', name: 'Band' }] },
});
// Pick a time zone where it's currently between 9:00 and 23:59, for the show-day reminder.
const zoneNow = (tz) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((p) => [p.type, p.value]));
const dayTz = ['Pacific/Kiritimati', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Pago_Pago'].find((tz) => +zoneNow(tz).hour >= 9);
const dz = zoneNow(dayTz);
const soon = new Date(Date.now() + 90 * 60000).toISOString();
const gistFiles = {
  'encore.json': JSON.stringify({
    settings: { tmKey: 'k', sgClientId: 'sg' },
    artists: [{ id: 'a1', name: 'Band', tmId: 'K1', lastChecked: 1 }],
    places: [{ id: 'p1', kind: 'venue', name: 'Club', tmVenueId: 'V1', lastChecked: 1 }],
    events: {
      tm_E1: { id: 'tm_E1', artistIds: ['a1'], date: day(10), status: 'onsale', priceMin: 80, mine: { status: 'interested', targetPrice: 60 } },
      tm_E2: { id: 'tm_E2', artistIds: ['a1'], date: day(20), status: 'onsale', priceMin: 50, mine: {} },
      tm_E9: { id: 'tm_E9', artistIds: ['a1'], date: `${dz.year}-${dz.month}-${dz.day}`, status: 'onsale', time: '20:00:00', timezone: dayTz, venue: { name: 'Hall' }, mine: { status: 'tickets', doors: '19:00' } },
    },
  }),
  'encore-push.json': JSON.stringify({ vapid, subscriptions: [sub, { ...sub, endpoint: 'https://gone.example/x' }] }),
};
let patched = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'api.github.com') {
    if (opts.method === 'PATCH') { patched = JSON.parse(opts.body); return json({}); }
    return json({ files: Object.fromEntries(Object.entries(gistFiles).map(([k, v]) => [k, { content: v }])) });
  }
  if (u.hostname === 'app.ticketmaster.com') {
    if (u.searchParams.get('venueId')) return json({ _embedded: { events: [tmEv('V9', 30, 'Austin', 20)] }, page: { totalPages: 1 } });
    return json({ _embedded: { events: [
      tmEv('E1', 10, 'Austin', 70),                                       // drop 80→70 (SG resale 55 → under target 60)
      tmEv('E2', 20, 'Dallas', 50, { status: 'cancelled' }),             // status change
      tmEv('E3', 40, 'Houston', 90, { presales: [{ name: 'Fan presale', startDateTime: soon }] }), // new + presale soon
    ] }, page: { totalPages: 1 } });
  }
  if (u.hostname === 'api.seatgeek.com') {
    if (u.pathname.endsWith('/performers')) return json({ performers: [{ id: 7, name: 'Band' }] });
    return json({ events: [{ id: 1, datetime_local: `${day(10)}T20:00:00`, venue: { city: 'Austin', name: 'Austin Arena', location: { lat: 30, lon: -97 } }, stats: { lowest_price: 55, listing_count: 12 }, url: 'sg' }] });
  }
  return json({}, 404);
};

const { run } = await import('./check.mjs');
const sent = [];
const res = await run({
  sendPush: async (s, payload) => {
    if (s.endpoint.includes('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    sent.push(JSON.parse(payload));
  },
});
const kinds = res.notes.map((n) => n.kind).sort();
console.log(res.notes.map((n) => n.text).join('\n'));
assert.deepEqual(kinds, ['day', 'drop', 'new', 'onsale', 'status', 'target', 'venue'].sort());
assert.equal(sent.length, 1);
assert.equal(res.removed, 1);
assert.ok(patched.files['encore-server.json']);
assert.ok(patched.files['encore-push.json']);
console.log('✓ first run: all alert kinds produced, push sent, expired subscription removed');

// Second run with the saved server state: nothing should repeat.
gistFiles['encore-server.json'] = patched.files['encore-server.json'].content;
gistFiles['encore-push.json'] = patched.files['encore-push.json'].content;
const res2 = await run({ sendPush: async () => {} });
assert.equal(res2.notes.length, 0, `expected no repeats, got: ${res2.notes.map((n) => n.text)}`);
console.log('✓ second run: no duplicate alerts');
