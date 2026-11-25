import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('the page includes every element the browser script needs', () => {
  const html = read('index.html');
  const required = [
    'id="hero"',
    'id="bars"',
    'id="scale-note"',
    'id="board"',
    'id="board-body"',
    'id="history-note"',
    'id="chart"',
    'id="legend"',
    'id="changes"',
    'id="status-line"',
    'id="check-now"',
    'href="styles.css"',
    'src="app.js"',
  ];
  for (const snippet of required) assert.match(html, new RegExp(snippet));

  for (const grade of ['regular', 'midgrade', 'premium', 'diesel', 'kerosene']) {
    assert.match(html, new RegExp(`data-grade="${grade}"`));
    assert.match(html, new RegExp(`data-sort="${grade}"`));
  }
  for (const brand of ['all', '7-eleven', 'speedway']) {
    assert.match(html, new RegExp(`data-brand="${brand}"`));
  }
  for (const range of ['24h', '7d', '30d']) assert.match(html, new RegExp(`data-range="${range}"`));
  for (const bucket of ['hour', 'day', 'reading']) assert.match(html, new RegExp(`data-bucket="${bucket}"`));
  assert.match(html, /Developed by/);
});

test('the saved price file can be shown on the page', () => {
  const data = JSON.parse(read('data/prices.json'));
  assert.equal(typeof data.generatedAt, 'string');
  assert.ok(data.stations && Object.keys(data.stations).length > 0);
  assert.ok(Array.isArray(data.readings) && data.readings.length > 0);
  assert.ok(Array.isArray(data.changes));
  for (const station of Object.values(data.stations)) {
    assert.equal(typeof station.id, 'string');
    assert.equal(typeof station.address, 'string');
    assert.ok(station.address.length > 0);
    assert.ok(station.brand === '7-eleven' || station.brand === 'speedway');
  }
  for (const reading of data.readings) {
    assert.equal(typeof reading.storeId, 'string');
    assert.ok(data.stations[reading.storeId], `reading for unknown station ${reading.storeId}`);
    assert.ok(Number.isFinite(Date.parse(reading.observedAt)));
    for (const grade of ['regular', 'midgrade', 'premium', 'diesel']) {
      if (reading[grade] != null) assert.ok(reading[grade] > 0 && reading[grade] < 20);
    }
  }
});

test('the site scripts parse', () => {
  for (const file of ['app.js', 'server.mjs', 'scripts/update-prices.mjs']) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('a finished check starts another one', () => {
  const workflow = read('.github/workflows/update-prices.yml');
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /sleep 260/);
  assert.match(workflow, /workflows\/update-prices\.yml\/dispatches/);
  assert.match(workflow, /if: always\(\)/);
});
