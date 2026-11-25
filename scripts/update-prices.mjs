import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LAT = 35.77959;
const LON = -78.63818;
const RADIUS = 32.1868;
const TOKEN_URL = 'https://www.7-eleven.com/api/v5/rewards-token';
const SEARCH_URL = 'https://www.7-eleven.com/api/v5/stores/search';
const NY = 'America/New_York';
const RETENTION_MS = 120 * 24 * 60 * 60 * 1000;
const GRADES = ['regular', 'midgrade', 'premium', 'diesel', 'kerosene'];
const GRADE_MATCH = {
  regular: ['RUL', 'Regular'],
  midgrade: ['NMB', 'Mid-Grade', 'Midgrade', 'Mid Grade'],
  premium: ['PUL', 'Premium'],
  diesel: ['DSL', 'Diesel'],
  kerosene: ['KER', 'Kerosene'],
};
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Origin: 'https://www.7-eleven.com',
  Referer: 'https://www.7-eleven.com/locator',
};

const dataFile = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.resolve('data/prices.json');

function emptyStore() {
  return {
    generatedAt: null,
    lastError: null,
    intervalMinutes: 5,
    stations: {},
    readings: [],
    changes: [],
  };
}

function loadStore() {
  if (!fs.existsSync(dataFile)) return emptyStore();
  const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  return {
    generatedAt: parsed.generatedAt || null,
    lastError: parsed.lastError || null,
    intervalMinutes: 5,
    stations: parsed.stations || {},
    readings: Array.isArray(parsed.readings) ? parsed.readings : [],
    changes: Array.isArray(parsed.changes) ? parsed.changes : [],
  };
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const stable = {
    generatedAt: store.generatedAt,
    lastError: store.lastError,
    intervalMinutes: 5,
    stations: Object.fromEntries(Object.keys(store.stations).sort().map((id) => [id, store.stations[id]])),
    readings: store.readings,
    changes: store.changes,
  };
  fs.writeFileSync(dataFile, `${JSON.stringify(stable, null, 2)}\n`);
}

function nyParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of fmt.formatToParts(date)) parts[part.type] = part.value;
  if (parts.hour === '24') parts.hour = '00';
  return parts;
}

function hourKey(date) {
  const parts = nyParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

function dollars(thousandths) {
  if (thousandths == null || Number.isNaN(Number(thousandths))) return null;
  return Math.round(Number(thousandths)) / 1000;
}

function gradePrice(fuel, grade) {
  const aliases = GRADE_MATCH[grade];
  const found = (fuel?.grades || []).find((item) => aliases.includes(item.abbr) || aliases.includes(item.name));
  if (!found || found.price == null || Number.isNaN(Number(found.price))) return null;
  return Math.round(Number(found.price));
}

function parseUpdated(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}:?\d{2}))?/);
  if (!match) return null;
  const offset = match[3] ? match[3].replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : '';
  return `${match[1]}T${match[2]}${offset}`;
}

function formatPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length !== 10) return raw || '';
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
}

function isRaleighFuel(store) {
  const city = String(store.city || '').trim().toLowerCase();
  const state = String(store.state || '').trim().toUpperCase();
  return city === 'raleigh' && state === 'NC' && Array.isArray(store.fuel_data?.grades) && store.fuel_data.grades.length > 0;
}

async function fetchRaleighStores() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ forceRefresh: false }),
      signal: controller.signal,
    });
    if (!tokenRes.ok) throw new Error(`7-Eleven token request failed (${tokenRes.status})`);
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) throw new Error('7-Eleven token response had no access token');

    const searchRes = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        token: tokenJson.access_token,
        lat: LAT,
        lon: LON,
        radius: RADIUS,
        limit: 50,
        currentLat: LAT,
        currentLon: LON,
        selectedFeatures: [],
      }),
      signal: controller.signal,
    });
    if (!searchRes.ok) throw new Error(`7-Eleven store search failed (${searchRes.status})`);
    const data = await searchRes.json();
    if (!Array.isArray(data.results)) throw new Error('7-Eleven store search returned an unexpected payload');
    return data.results.filter(isRaleighFuel);
  } finally {
    clearTimeout(timeout);
  }
}

function signatureOf(prices, updated) {
  return [updated || '', ...GRADES.map((grade) => prices[grade] ?? '')].join('|');
}

function latestReading(readings, storeId) {
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    if (readings[index].storeId === storeId) return readings[index];
  }
  return null;
}

function prune(store, nowMs) {
  const cutoff = nowMs - RETENTION_MS;
  store.readings = store.readings.filter((reading) => new Date(reading.observedAt).getTime() >= cutoff);
  store.changes = store.changes.filter((change) => new Date(change.detectedAt).getTime() >= cutoff);
}

export async function updatePrices() {
  const store = loadStore();
  const observedAt = new Date().toISOString();
  let stores;
  try {
    stores = await fetchRaleighStores();
  } catch (error) {
    const message = error.name === 'AbortError' ? '7-Eleven request timed out' : error.message;
    if (store.lastError !== message || !store.generatedAt) {
      store.lastError = message;
      store.generatedAt = observedAt;
      writeStore(store);
      console.error(`Saved error: ${message}`);
      return { changed: true, error: message };
    }
    console.error(`Poll failed: ${message}`);
    return { changed: false, error: message };
  }

  let inserted = 0;
  let changeCount = 0;
  for (const station of stores) {
    const id = station.id != null ? String(station.id) : `${station.brand?.slug || 'store'}:${station.address}`;
    const brand = typeof station.brand === 'string' ? station.brand : station.brand?.slug || '';
    const thousandths = {};
    const prices = {};
    for (const grade of GRADES) {
      thousandths[grade] = gradePrice(station.fuel_data, grade);
      prices[grade] = dollars(thousandths[grade]);
    }
    const priceUpdatedAt = parseUpdated(station.fuel_data?.last_updated);
    const signature = signatureOf(thousandths, priceUpdatedAt);
    const mapQuery = station.lat != null && station.lon != null
      ? `${station.lat},${station.lon}`
      : `${station.address}, Raleigh, NC ${station.zip || station.postal_code || ''}`;

    store.stations[id] = {
      id,
      brand,
      name: station.name || '',
      address: station.address || '',
      city: station.city || '',
      zip: station.zip != null ? String(station.zip) : station.postal_code != null ? String(station.postal_code) : '',
      phone: formatPhone(station.phone),
      lat: station.lat == null ? null : Number(station.lat),
      lon: station.lon == null ? null : Number(station.lon),
      url: station.seo_web_url || '',
      distanceLabel: station.distance_label || '',
      mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`,
      lastSeenAt: observedAt,
    };

    const previous = latestReading(store.readings, id);
    const sameSignature = previous && previous.signature === signature;
    const sameHour = previous && hourKey(new Date(previous.observedAt)) === hourKey(new Date(observedAt));
    if (sameSignature && sameHour) continue;

    store.readings.push({
      storeId: id,
      observedAt,
      priceUpdatedAt,
      signature,
      ...prices,
    });
    inserted += 1;

    if (!previous) continue;
    for (const grade of GRADES) {
      if (Object.is(previous[grade], prices[grade])) continue;
      changeCount += 1;
      store.changes.push({
        id: store.changes.length + 1,
        storeId: id,
        detectedAt: observedAt,
        priceUpdatedAt,
        grade,
        oldPrice: previous[grade],
        newPrice: prices[grade],
      });
      console.log(`${station.address} ${grade} ${previous[grade] ?? 'none'} -> ${prices[grade] ?? 'none'}`);
    }
  }

  if (inserted === 0 && store.lastError == null) {
    console.log(`Checked ${stores.length} Raleigh stations, no new snapshot.`);
    return { changed: false, stations: stores.length, inserted: 0, changeCount: 0 };
  }

  store.lastError = null;
  store.generatedAt = observedAt;
  prune(store, Date.now());
  writeStore(store);
  console.log(`Saved ${inserted} reading${inserted === 1 ? '' : 's'} across ${stores.length} stations, ${changeCount} price change${changeCount === 1 ? '' : 's'}.`);
  return { changed: true, stations: stores.length, inserted, changeCount };
}

const ranDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (ranDirectly) {
  updatePrices().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
