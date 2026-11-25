import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { startServer } from '../server.mjs';

const USERS = 250;
const ROUNDS = 4;
const PAGES = ['/', '/styles.css', '/app.js', '/data/prices.json'];

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function fetch(url, agent) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test('250 visitors can load the site at the same time', { timeout: 60_000 }, async () => {
  const { server, url } = await startServer({ port: 0 });
  const agent = new http.Agent({ keepAlive: true, maxSockets: USERS });
  const timings = [];
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      const visits = Array.from({ length: USERS }, () => PAGES.map(async (page) => {
        const started = performance.now();
        const response = await fetch(`${url}${page}`, agent);
        timings.push(performance.now() - started);
        assert.equal(response.status, 200, `${page} returned ${response.status}`);
        if (page === '/') {
          assert.match(response.body.toString('utf8'), /Fuel prices/);
        } else if (page === '/styles.css') {
          assert.match(response.body.toString('utf8'), /footer/);
        } else if (page === '/app.js') {
          assert.match(response.body.toString('utf8'), /PRICE_REPOSITORY/);
        } else {
          const data = JSON.parse(response.body.toString('utf8'));
          assert.ok(data.stations && Object.keys(data.stations).length > 0);
          assert.ok(Array.isArray(data.readings));
        }
      }));
      await Promise.all(visits.flat());
    }

    const failures = timings.filter((ms) => ms > 5_000);
    assert.equal(failures.length, 0, `${failures.length} requests took longer than 5 seconds`);
    assert.ok(percentile(timings, 95) < 1_000, `p95 was ${percentile(timings, 95).toFixed(0)} ms`);

    const again = await fetch(`${url}/`, agent);
    assert.equal(again.status, 200);
  } finally {
    agent.destroy();
    await stop(server);
  }
});

test('dropped connections do not take the site down', { timeout: 30_000 }, async () => {
  const { server, url } = await startServer({ port: 0 });
  try {
    await Promise.all(Array.from({ length: 200 }, () => new Promise((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => resolve());
      req.setTimeout(20, () => req.destroy());
    })));

    const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });
    try {
      const responses = await Promise.all(Array.from({ length: 50 }, () => fetch(`${url}/data/prices.json`, agent)));
      for (const response of responses) {
        assert.equal(response.status, 200);
        const data = JSON.parse(response.body.toString('utf8'));
        assert.ok(data.generatedAt);
      }
    } finally {
      agent.destroy();
    }
  } finally {
    await stop(server);
  }
});

test('a bad request does not crash the server', async () => {
  const { server, url } = await startServer({ port: 0 });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  try {
    const bad = await fetch(`${url}/%`, agent);
    assert.equal(bad.status, 400);

    const escape = await fetch(`${url}/%2e%2e/%2e%2e/etc/passwd`, agent);
    assert.equal(escape.status, 404);
    assert.equal(escape.body.toString('utf8'), 'Not found');

    const home = await fetch(`${url}/`, agent);
    assert.equal(home.status, 200);
    assert.match(home.body.toString('utf8'), /Fuel prices/);
  } finally {
    agent.destroy();
    await stop(server);
  }
});
