import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const cache = new Map();
const inflight = new Map();

function resolveRequestPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { error: 400 };
  }
  if (decoded.includes('\0')) return { error: 400 };
  const cleaned = decoded.replace(/^[/\\]+/, '');
  const filePath = path.resolve(ROOT, cleaned);
  const relative = path.relative(ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { error: 404 };
  return { filePath };
}

function readCached(filePath, mtimeMs, size) {
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return Promise.resolve(cached.body);
  }
  const pending = inflight.get(filePath);
  if (pending) return pending;
  const reading = fs.promises.readFile(filePath).then((body) => {
    cache.set(filePath, { mtimeMs, size, body });
    inflight.delete(filePath);
    return body;
  }, (error) => {
    inflight.delete(filePath);
    throw error;
  });
  inflight.set(filePath, reading);
  return reading;
}

function send(res, status, headers, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, headers);
  res.end(body);
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') {
        send(res, 204, {}, '');
        return;
      }
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const resolved = resolveRequestPath(pathname);
      if (resolved.error) {
        const message = resolved.error === 400 ? 'Bad request' : 'Not found';
        send(res, resolved.error, { 'Content-Type': 'text/plain; charset=utf-8' }, message);
        return;
      }
      let stat;
      try {
        stat = await fs.promises.stat(resolved.filePath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
          return;
        }
        throw error;
      }
      if (!stat.isFile()) {
        send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
        return;
      }
      const body = await readCached(resolved.filePath, stat.mtimeMs, stat.size);
      send(res, 200, {
        'Content-Type': TYPES[path.extname(resolved.filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': String(body.length),
      }, body);
    } catch (error) {
      console.error(error);
      send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Server error');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export function startServer({ host = HOST, port = PORT } = {}) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const address = server.address();
      resolve({ server, url: `http://${host}:${address.port}` });
    });
  });
}

const ranDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (ranDirectly) {
  startServer().then(({ url }) => {
    console.log(`Raleigh fuel prices: ${url}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
