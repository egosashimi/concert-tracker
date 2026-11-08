// Data sources. Everything is called directly from the phone; keys are stored only on the device.
//  - Ticketmaster Discovery API v2: artist search, events, price ranges, on-sale dates. Free key.
//  - Bandsintown (optional): extra tour dates, no prices. Requires an app_id.
//  - Open-Meteo geocoding: turn a city name into coordinates. No key.

import { sleep } from './util.js';

const TM = 'https://app.ticketmaster.com/discovery/v2';

export class ApiError extends Error {
  constructor(message, { fatal = false, status = 0 } = {}) {
    super(message);
    this.fatal = fatal; // stop the whole refresh (e.g. bad key)
    this.status = status;
  }
}

async function getJSON(url, { retries = 2 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError(navigator.onLine === false ? 'You are offline.' : 'Network error — could not reach the server.');
  }
  if (res.status === 429 && retries > 0) {
    await sleep(1200);
    return getJSON(url, { retries: retries - 1 });
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.fault?.faultstring || body?.errors?.[0]?.detail || body?.message || body?.error || '';
    } catch { /* ignore */ }
    throw new ApiError(detail || `Request failed (${res.status})`, { status: res.status });
  }
  return res.json();
}

// ---------------- Ticketmaster ----------------
async function tm(path, params, key) {
  if (!key) throw new ApiError('Add a Ticketmaster API key in Settings to search automatically.', { fatal: true });
  const url = new URL(TM + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  url.searchParams.set('apikey', key);
  try {
    return await getJSON(url.toString());
  } catch (e) {
    if (e.status === 401 || /invalid apikey|api key/i.test(e.message)) {
      throw new ApiError('Ticketmaster rejected the API key. Check it in Settings.', { fatal: true, status: 401 });
    }
    if (e.status === 429) throw new ApiError('Ticketmaster rate limit hit — try again in a minute.', { fatal: true, status: 429 });
    throw e;
  }
}

function pickImage(images, { ratio = '16_9', minWidth = 500 } = {}) {
  if (!Array.isArray(images) || !images.length) return '';
  const good = images
    .filter((i) => i.ratio === ratio && i.width >= minWidth && !i.fallback)
    .sort((a, b) => a.width - b.width);
  return (good[0] || images.find((i) => i.ratio === ratio) || images[0]).url || '';
}

export async function tmSearchArtists(query, key) {
  const data = await tm('/attractions.json', {
    keyword: query,
    classificationName: 'music',
    size: 20,
    sort: 'relevance,desc',
  }, key);
  return (data?._embedded?.attractions || []).map((a) => ({
    tmId: a.id,
    name: a.name,
    image: pickImage(a.images, { ratio: '1_1', minWidth: 100 }) || pickImage(a.images, { minWidth: 200 }),
    genre: [a.classifications?.[0]?.genre?.name, a.classifications?.[0]?.subGenre?.name]
      .filter((g) => g && g !== 'Undefined' && g !== 'Other')
      .filter((g, i, arr) => arr.indexOf(g) === i)
      .join(' · '),
    upcoming: a.upcomingEvents?._total ?? a.upcomingEvents?.ticketmaster ?? 0,
    url: a.url || '',
    links: a.externalLinks || {},
  }));
}

export async function tmArtistEvents(tmId, key, countryCode) {
  const all = [];
  let page = 0;
  let totalPages = 1;
  while (page < totalPages && page < 5) {
    const data = await tm('/events.json', {
      attractionId: tmId,
      size: 100,
      page,
      sort: 'date,asc',
      countryCode: countryCode || undefined,
      includeTBA: 'yes',
      includeTBD: 'yes',
    }, key);
    all.push(...(data?._embedded?.events || []));
    totalPages = data?.page?.totalPages || 0;
    page++;
    if (page < totalPages) await sleep(220); // stay under 5 req/sec
  }
  return all.map(normalizeTmEvent);
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeTmEvent(e) {
  const v = e._embedded?.venues?.[0] || {};
  const start = e.dates?.start || {};
  const ranges = Array.isArray(e.priceRanges) ? e.priceRanges : [];
  const mins = ranges.map((r) => num(r.min)).filter((n) => n != null && n > 0);
  const maxs = ranges.map((r) => num(r.max)).filter((n) => n != null && n > 0);
  const presales = (e.sales?.presales || []).map((p) => ({
    name: p.name || 'Presale',
    start: p.startDateTime || '',
    end: p.endDateTime || '',
  }));
  return {
    id: `tm_${e.id}`,
    source: 'tm',
    name: e.name || '',
    date: start.dateTBA || start.dateTBD ? null : start.localDate || null,
    time: start.noSpecificTime || start.timeTBA ? null : (start.localTime || null),
    dateTime: start.dateTime || null,
    timezone: e.dates?.timezone || '',
    status: (e.dates?.status?.code || 'onsale').toLowerCase(),
    venue: {
      name: v.name || '',
      city: v.city?.name || '',
      region: v.state?.stateCode || v.state?.name || '',
      country: v.country?.countryCode || '',
      address: [v.address?.line1, v.city?.name, v.state?.stateCode, v.postalCode].filter(Boolean).join(', '),
      lat: num(v.location?.latitude),
      lon: num(v.location?.longitude),
    },
    url: e.url || '',
    onSale: e.sales?.public?.startTBD ? '' : (e.sales?.public?.startDateTime || ''),
    offSale: e.sales?.public?.endDateTime || '',
    presales,
    priceMin: mins.length ? Math.min(...mins) : null,
    priceMax: maxs.length ? Math.max(...maxs) : null,
    currency: ranges[0]?.currency || 'USD',
    image: pickImage(e.images, { minWidth: 600 }),
    lineup: (e._embedded?.attractions || []).map((a) => a.name).filter(Boolean),
    info: [e.info, e.pleaseNote].filter(Boolean).join('\n\n'),
    ticketLimit: e.ticketLimit?.info || '',
    ageRestricted: !!e.ageRestrictions?.legalAgeEnforced,
  };
}

// ---------------- Bandsintown ----------------
export async function bitArtistEvents(name, appId) {
  // Bandsintown needs "/" "?" "*" and '"' double-encoded in artist names.
  const safe = encodeURIComponent(name)
    .replace(/%2F/g, '%252F')
    .replace(/%3F/g, '%253F')
    .replace(/\*/g, '%252A')
    .replace(/%22/g, '%27C');
  const url = `https://rest.bandsintown.com/artists/${safe}/events?app_id=${encodeURIComponent(appId)}&date=upcoming`;
  let data;
  try {
    data = await getJSON(url);
  } catch (e) {
    if (e.status === 403 || e.status === 401) throw new ApiError('Bandsintown rejected the app ID.', { fatal: false, status: e.status });
    if (e.status === 404) return [];
    throw e;
  }
  if (!Array.isArray(data)) return [];
  return data.map(normalizeBitEvent);
}

export function normalizeBitEvent(e) {
  const dt = String(e.datetime || '');
  const v = e.venue || {};
  const ticket = (e.offers || []).find((o) => /ticket/i.test(o.type || '')) || (e.offers || [])[0];
  const soldOut = (e.offers || []).some((o) => /sold ?out/i.test(o.status || ''));
  return {
    id: `bit_${e.id}`,
    source: 'bit',
    name: e.title || (e.lineup || []).join(', '),
    date: dt.slice(0, 10) || null,
    time: dt.length >= 16 ? dt.slice(11, 19) : null,
    dateTime: null,
    timezone: '',
    status: soldOut ? 'soldout' : 'onsale',
    venue: {
      name: v.name || '',
      city: v.city || '',
      region: v.region || '',
      country: countryToCode(v.country),
      address: [v.street_address, v.city, v.region, v.postal_code].filter(Boolean).join(', '),
      lat: num(v.latitude),
      lon: num(v.longitude),
    },
    url: ticket?.url || e.url || '',
    onSale: e.on_sale_datetime || '',
    offSale: '',
    presales: [],
    priceMin: null,
    priceMax: null,
    currency: 'USD',
    image: '',
    lineup: e.lineup || [],
    info: e.description || '',
    ticketLimit: '',
    ageRestricted: false,
  };
}

const COUNTRY_CODES = {
  'united states': 'US', 'usa': 'US', 'canada': 'CA', 'united kingdom': 'GB', 'uk': 'GB',
  'australia': 'AU', 'mexico': 'MX', 'germany': 'DE', 'france': 'FR', 'spain': 'ES', 'ireland': 'IE',
  'netherlands': 'NL', 'italy': 'IT', 'new zealand': 'NZ', 'japan': 'JP', 'brazil': 'BR', 'sweden': 'SE',
  'norway': 'NO', 'denmark': 'DK', 'belgium': 'BE', 'switzerland': 'CH', 'austria': 'AT', 'poland': 'PL',
};
function countryToCode(c) {
  if (!c) return '';
  if (/^[A-Z]{2}$/.test(c)) return c;
  return COUNTRY_CODES[c.toLowerCase()] || c;
}

// ---------------- Geocoding ----------------
export async function geocodeCity(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=en&format=json`;
  const data = await getJSON(url);
  return (data?.results || []).map((r) => ({
    label: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available on this device.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (err) => reject(new Error(err.code === 1 ? 'Location permission denied.' : 'Could not get your location.')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
    );
  });
}

export async function reverseLabel(lat, lon) {
  // Open-Meteo has no reverse geocoder; show rounded coordinates instead.
  return `Near ${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}
