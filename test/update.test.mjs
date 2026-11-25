import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

function station({ id = '100', city = 'Raleigh', state = 'NC', price = 2789, updated = '2026-11-25 01:10:00 -05:00' } = {}) {
  return {
    id,
    city,
    state,
    address: `${id} Test Road`,
    name: 'Test',
    zip: '27601',
    phone: '9195550100',
    lat: 35.78,
    lon: -78.64,
    seo_web_url: 'https://www.7-eleven.com/locations/nc/raleigh/test',
    distance_label: '1.0 mi',
    brand: { slug: '7-eleven' },
    fuel_data: {
      last_updated: updated,
      grades: [
        { abbr: 'RUL', name: 'Regular', price },
        { abbr: 'NMB', name: 'Mid-Grade', price: price + 450 },
        { abbr: 'PUL', name: 'Premium', price: price + 850 },
        { abbr: 'DSL', name: 'Diesel', price: price + 2200 },
      ],
    },
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeApi(stores) {
  return async (url) => {
    const target = String(url);
    if (target.includes('rewards-token')) return jsonResponse({ access_token: 'token' });
    if (target.includes('stores/search')) return jsonResponse({ results: stores });
    throw new Error(`unexpected request ${target}`);
  };
}

async function loadUpdater(file) {
  process.env.DATA_FILE = file;
  const href = pathToFileURL(path.resolve('scripts/update-prices.mjs')).href;
  return import(`${href}?isolated=${Date.now()}-${Math.random()}`);
}

function readStore(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test.describe('price history survives a check', { concurrency: 1 }, () => {
  let directory;
  let originalFetch;

  test.before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fuel-update-'));
    originalFetch = globalThis.fetch;
  });

  test.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.DATA_FILE;
  });

  test.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('the first look records prices and does not call them a change', async () => {
    const file = path.join(directory, 'first.json');
    globalThis.fetch = fakeApi([station()]);
    const { updatePrices } = await loadUpdater(file);
    const result = await updatePrices();
    const store = readStore(file);
    assert.equal(result.inserted, 1);
    assert.equal(result.changeCount, 0);
    assert.equal(store.readings.length, 1);
    assert.equal(store.readings[0].regular, 2.789);
    assert.equal(store.readings[0].diesel, 4.989);
    assert.equal(store.changes.length, 0);
    assert.equal(store.lastError, null);
  });

  test('the same price in the same hour does not rewrite the snapshot', async () => {
    const file = path.join(directory, 'same.json');
    globalThis.fetch = fakeApi([station()]);
    const { updatePrices } = await loadUpdater(file);
    await updatePrices();
    const before = fs.readFileSync(file, 'utf8');
    const again = await updatePrices();
    assert.equal(again.changed, false);
    assert.equal(again.inserted, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  test('a posted price change is kept and the old price is still there', async () => {
    const file = path.join(directory, 'change.json');
    const { updatePrices } = await loadUpdater(file);
    globalThis.fetch = fakeApi([station({ price: 2789 })]);
    await updatePrices();
    globalThis.fetch = fakeApi([station({ price: 2799, updated: '2026-11-25 01:20:00 -05:00' })]);
    const result = await updatePrices();
    const store = readStore(file);
    assert.equal(result.changeCount, 4);
    assert.equal(store.readings.length, 2);
    assert.equal(store.readings[0].regular, 2.789);
    assert.equal(store.readings[1].regular, 2.799);
    assert.equal(store.changes.find((change) => change.grade === 'regular').oldPrice, 2.789);
    assert.equal(store.changes.find((change) => change.grade === 'regular').newPrice, 2.799);
  });

  test('stores outside Raleigh are left out', async () => {
    const file = path.join(directory, 'city.json');
    globalThis.fetch = fakeApi([
      station({ id: '1' }),
      station({ id: '2', city: 'Cary' }),
      station({ id: '3', state: 'VA' }),
    ]);
    const { updatePrices } = await loadUpdater(file);
    const result = await updatePrices();
    const store = readStore(file);
    assert.equal(result.inserted, 1);
    assert.deepEqual(Object.keys(store.stations), ['1']);
  });

  test('a failed check keeps the prices already saved', async () => {
    const file = path.join(directory, 'fail.json');
    const { updatePrices } = await loadUpdater(file);
    globalThis.fetch = fakeApi([station()]);
    await updatePrices();
    const saved = readStore(file);
    globalThis.fetch = async () => {
      throw new Error('7-Eleven store search failed (503)');
    };
    const result = await updatePrices();
    const store = readStore(file);
    assert.equal(result.changed, true);
    assert.equal(result.error, '7-Eleven store search failed (503)');
    assert.equal(store.readings.length, saved.readings.length);
    assert.equal(store.readings[0].regular, saved.readings[0].regular);
    assert.equal(store.lastError, '7-Eleven store search failed (503)');
    assert.equal(Object.keys(store.stations).length, 1);
  });
});
