import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMorningBriefing } from './briefing.mjs';
import { DEFAULT_ROOT, loadRuntime, saveConfig } from './config.mjs';
import { addBrainDump, deleteInboxItem, listInbox, updateInboxItem } from './inbox.mjs';
import { deleteReadLaterItem, listReadLater, saveReadLater, updateReadLaterItem } from './readlater.mjs';
import { readJson, writeJson } from './store.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 262_144) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request payload too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

export function createAppServer(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;

  const deleted = new Map();

  function rememberDeletion(key, item) {
    const existing = deleted.get(key);
    if (existing) clearTimeout(existing.timeout);
    const timeout = setTimeout(() => deleted.delete(key), 15_000).unref();
    deleted.set(key, { item, timeout });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      const { config, env, paths } = loadRuntime(rootDir);

      // API routes
      if (pathname === '/api/state' && req.method === 'GET') {
        const lastBriefing = readJson(paths.lastBriefing, {
          generatedAt: null,
          dateLabel: null,
          weather: null,
          schedule: [],
          dueSoon: [],
          news: [],
          readLater: [],
        });
        return sendJson(res, 200, {
          mode: 'local',
          config,
          inbox: listInbox({ rootDir }),
          readLater: listReadLater({ rootDir }),
          lastBriefing,
          channels: {
            gmailConfigured: Boolean(env.gmailUser && env.gmailAppPassword && env.gmailTo),
            discordConfigured: Boolean(env.discordWebhookUrl),
            geminiConfigured: Boolean(env.geminiApiKey),
            calendarConfigured: Boolean(env.icalUrl),
          },
        });
      }

      if (pathname === '/api/dump' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await addBrainDump(body.text, {
          rootDir,
          kind: body.kind,
          fetch: options.fetch,
          skipFetch: options.skipFetch,
        });
        return sendJson(res, 201, result);
      }

      const inboxMatch = pathname.match(/^\/api\/inbox\/([a-z0-9_]+)$/i);
      if (inboxMatch && req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const updated = updateInboxItem(inboxMatch[1], body, { rootDir });
        if (!updated) return sendJson(res, 404, { error: 'Inbox item not found.' });
        return sendJson(res, 200, { item: updated });
      }
      if (inboxMatch && req.method === 'DELETE') {
        const removed = deleteInboxItem(inboxMatch[1], { rootDir });
        if (!removed) return sendJson(res, 404, { error: 'Inbox item not found.' });
        rememberDeletion(pathname, removed);
        return sendJson(res, 200, { removed });
      }

      if (pathname === '/api/readlater' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const item = await saveReadLater(body.url, {
          rootDir,
          note: body.note || '',
          tags: body.tags || [],
          fetch: options.fetch,
          skipFetch: options.skipFetch,
        });
        return sendJson(res, 201, { item });
      }

      const rlMatch = pathname.match(/^\/api\/readlater\/([a-z0-9_]+)$/i);
      if (rlMatch && req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const updated = updateReadLaterItem(rlMatch[1], body, { rootDir });
        if (!updated) return sendJson(res, 404, { error: 'Read-Later item not found.' });
        return sendJson(res, 200, { item: updated });
      }
      if (rlMatch && req.method === 'DELETE') {
        const removed = deleteReadLaterItem(rlMatch[1], { rootDir });
        if (!removed) return sendJson(res, 404, { error: 'Read-Later item not found.' });
        rememberDeletion(pathname, removed);
        return sendJson(res, 200, { removed });
      }

      const restoreMatch = pathname.match(/^(\/api\/(inbox|readlater)\/[a-z0-9_]+)\/restore$/i);
      if (restoreMatch && req.method === 'POST') {
        const [, key, list] = restoreMatch;
        const record = deleted.get(key);
        if (!record) return sendJson(res, 404, { error: 'This item is no longer available to restore.' });
        const file = list === 'inbox' ? paths.inbox : paths.readLater;
        const store = readJson(file, { version: 1, items: [] });
        if (!store.items.some((item) => item.id === record.item.id)) {
          store.items.unshift(record.item);
          writeJson(file, store);
        }
        clearTimeout(record.timeout);
        deleted.delete(key);
        return sendJson(res, 200, { item: record.item });
      }

      if (pathname === '/api/briefing/run' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const dryRun = body.deliver === true ? false : true;
        const result = await runMorningBriefing({
          rootDir,
          dryRun,
          fetch: options.fetch,
        });
        return sendJson(res, 200, {
          briefing: result.briefing,
          delivery: result.delivery,
          dryRun,
        });
      }

      if (pathname === '/api/config' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const merged = {
          ...config,
          timezone: body.timezone || config.timezone,
          weather: { ...config.weather, ...(body.weather || {}) },
          news: {
            ...config.news,
            maxAgeDays: Number.isInteger(body.news?.maxAgeDays) && body.news.maxAgeDays >= 0
              ? body.news.maxAgeDays : config.news.maxAgeDays,
            excludePatterns: Array.isArray(body.news?.excludePatterns)
              && body.news.excludePatterns.every((pattern) => typeof pattern === 'string')
              ? body.news.excludePatterns : config.news.excludePatterns,
            topics: Array.isArray(body.news?.topics) ? body.news.topics : config.news.topics,
            feeds: Array.isArray(body.news?.feeds) ? body.news.feeds : config.news.feeds,
          },
          delivery: { ...config.delivery, ...(body.delivery || {}) },
        };
        saveConfig(merged, rootDir);
        return sendJson(res, 200, { config: merged });
      }

      // Allow static read of last-briefing.json so GitHub Pages & local share identical paths
      if (pathname === '/data/last-briefing.json' && req.method === 'GET') {
        const snapshot = readJson(paths.lastBriefing, { generatedAt: null });
        return sendJson(res, 200, snapshot);
      }

      // Static web files
      const safeRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const resolved = path.resolve(paths.webDir, safeRel);
      if (!resolved.startsWith(path.resolve(paths.webDir) + path.sep)) {
        return sendJson(res, 403, { error: 'Forbidden' });
      }
      if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
        return sendJson(res, 404, { error: 'Not found' });
      }

      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      fs.createReadStream(resolved).pipe(res);
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Request failed.' });
    }
  });
}

export function startServer(options = {}) {
  const port = options.port ?? 4310;
  const host = options.host || '127.0.0.1';
  const server = createAppServer(options);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`ZeroScroll running at http://${host}:${port}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 4310;
  startServer({ port });
}
