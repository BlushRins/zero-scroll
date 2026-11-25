import { DEFAULT_ROOT, loadRuntime } from './config.mjs';
import {
  buildBriefingDiscordPayload,
  deliverNotification,
  formatLocalDate,
  renderBriefingEmailHtml,
  renderBriefingPlainText,
} from './delivery.mjs';
import { normalizeUrlKey } from './news.mjs';
import { makeId, readJson, writeJson } from './store.mjs';
import { summarizeUrl } from './summarizer.mjs';

const EMPTY_READLATER = { version: 1, items: [] };

export function listReadLater(options = {}) {
  const { paths } = loadRuntime(options.rootDir || DEFAULT_ROOT);
  const store = readJson(paths.readLater, EMPTY_READLATER);
  return store.items || [];
}

export async function saveReadLater(rawUrl, options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const { env, paths } = loadRuntime(rootDir);
  const store = readJson(paths.readLater, EMPTY_READLATER);
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }
  const parsedHost = parsed.hostname.replace(/^www\./, '');
  const normKey = normalizeUrlKey(rawUrl);

  const existing = (store.items || []).find((it) => normalizeUrlKey(it.url) === normKey);
  if (existing && existing.status === 'unread') {
    return existing;
  }


  let summary = null;
  if (!options.skipFetch) {
    try {
      summary = await summarizeUrl(rawUrl, {
        geminiApiKey: env.geminiApiKey,
        fetch: options.fetch,
      });
    } catch {
      summary = null;
    }
  }

  const item = {
    id: makeId('rl'),
    url: rawUrl,
    title: summary?.title || options.note || parsedHost || rawUrl,
    source: summary?.source || parsedHost,
    kind: summary?.kind || 'article',
    note: options.note || '',
    tags: Array.isArray(options.tags) ? options.tags : [],
    readingMinutes: summary?.readingMinutes ?? null,
    bullets: summary?.bullets || [],
    summarizedBy: summary?.summarizedBy || null,
    status: 'unread',
    savedAt: new Date().toISOString(),
    digestedAt: null,
  };

  store.items = [item, ...(store.items || [])];
  writeJson(paths.readLater, store);
  return item;
}

export function updateReadLaterItem(id, patch, options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const { paths } = loadRuntime(rootDir);
  const store = readJson(paths.readLater, EMPTY_READLATER);
  const idx = (store.items || []).findIndex((it) => it.id === id);
  if (idx === -1) return null;

  const next = { ...store.items[idx] };
  if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim();
  if (typeof patch.note === 'string') next.note = patch.note.trim();
  if (typeof patch.status === 'string' && ['unread', 'digested', 'archived'].includes(patch.status)) {
    next.status = patch.status;
    if (patch.status === 'digested') next.digestedAt = new Date().toISOString();
  }
  store.items[idx] = next;
  writeJson(paths.readLater, store);
  return next;
}

export function deleteReadLaterItem(id, options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const { paths } = loadRuntime(rootDir);
  const store = readJson(paths.readLater, EMPTY_READLATER);
  const removed = (store.items || []).find((it) => it.id === id) || null;
  store.items = (store.items || []).filter((it) => it.id !== id);
  if (removed) writeJson(paths.readLater, store);
  return removed;
}

export async function prepareReadLaterDigestItems(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const { config, env, paths } = loadRuntime(rootDir);
  const maxItems = options.maxItems ?? config.briefing?.maxReadLaterItems ?? 5;
  const store = readJson(paths.readLater, EMPTY_READLATER);
  const unread = (store.items || []).filter((it) => it.status === 'unread').slice(0, maxItems);
  let mutated = false;

  for (const item of unread) {
    if (!item.bullets || item.bullets.length === 0) {
      try {
        const res = await summarizeUrl(item.url, {
          geminiApiKey: env.geminiApiKey,
          fetch: options.fetch,
        });
        item.title = res.title || item.title;
        item.source = res.source || item.source;
        item.kind = res.kind || item.kind;
        item.readingMinutes = res.readingMinutes ?? item.readingMinutes;
        item.bullets = res.bullets;
        item.summarizedBy = res.summarizedBy;
        mutated = true;
      } catch {
        item.bullets = [`Saved link from ${item.source || 'web'}. Open to read in full.`];
      }
    }
  }

  if (mutated && !options.dryRun) {
    writeJson(paths.readLater, store);
  }
  return { items: unread, store };
}

export async function runReadLaterDigest(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const dryRun = Boolean(options.dryRun);
  const { config, env, paths } = loadRuntime(rootDir);
  const tz = config.timezone || 'Asia/Manila';
  const now = options.now || new Date();

  const { items, store } = await prepareReadLaterDigestItems({
    rootDir,
    dryRun,
    fetch: options.fetch,
  });

  if (items.length === 0) {
    return { items: [], delivery: { skipped: true, reason: 'No unread links in Read-Later queue.' } };
  }

  const pseudoBriefing = {
    generatedAt: now.toISOString(),
    dateLabel: formatLocalDate(now, tz),
    weather: null,
    schedule: [],
    dueSoon: [],
    news: [],
    readLater: items,
  };

  const subject = `ZeroScroll Read-Later Digest (${items.length} ${items.length === 1 ? 'link' : 'links'})`;
  const html = renderBriefingEmailHtml(pseudoBriefing, tz);
  const text = renderBriefingPlainText(pseudoBriefing, tz);
  const discordPayload = buildBriefingDiscordPayload(pseudoBriefing, tz);

  const delivery = await deliverNotification({
    config,
    env,
    subject,
    html,
    text,
    discordPayload,
    dryRun,
    fetch: options.fetch,
  });

  if (!dryRun && config.briefing?.markReadLaterDigested !== false) {
    const ids = new Set(items.map((it) => it.id));
    for (const entry of store.items || []) {
      if (ids.has(entry.id)) {
        entry.status = 'digested';
        entry.digestedAt = now.toISOString();
      }
    }
    writeJson(paths.readLater, store);
  }

  return { items, delivery, text, discordPayload };
}
