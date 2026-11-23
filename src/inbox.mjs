import { DEFAULT_ROOT, loadRuntime } from './config.mjs';
import { parseBrainDump } from './parser.mjs';
import { saveReadLater } from './readlater.mjs';
import { makeId, readJson, writeJson } from './store.mjs';

const EMPTY_INBOX = { version: 1, items: [] };

export function listInbox(options = {}) {
  const { paths } = loadRuntime(options.rootDir || DEFAULT_ROOT);
  const store = readJson(paths.inbox, EMPTY_INBOX);
  return store.items || [];
}

export async function addBrainDump(rawText, options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const { config, paths } = loadRuntime(rootDir);
  const parsed = parseBrainDump(rawText, {
    now: options.now || new Date(),
    timezone: config.timezone || 'Asia/Manila',
  });

  if (parsed.route === 'readlater') {
    const saved = await saveReadLater(parsed.url, {
      rootDir,
      note: parsed.note,
      tags: parsed.tags,
      fetch: options.fetch,
      skipFetch: options.skipFetch,
    });
    return { route: 'readlater', item: saved };
  }

  const store = readJson(paths.inbox, EMPTY_INBOX);
  const item = {
    id: makeId('inb'),
    kind: options.kind || parsed.kind,
    title: parsed.title,
    raw: parsed.raw,
    dueAt: parsed.dueAt,
    tags: parsed.tags,
    priority: parsed.priority,
    done: false,
    remindedStages: [],
    createdAt: (options.now || new Date()).toISOString(),
    completedAt: null,
  };

  store.items = [item, ...(store.items || [])];
  writeJson(paths.inbox, store);
  return { route: 'inbox', item };
}

export function updateInboxItem(id, patch, options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const { paths } = loadRuntime(rootDir);
  const store = readJson(paths.inbox, EMPTY_INBOX);
  const idx = (store.items || []).findIndex((it) => it.id === id);
  if (idx === -1) return null;

  const prev = store.items[idx];
  const next = { ...prev };
  if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim();
  if (typeof patch.kind === 'string' && ['task', 'event', 'note'].includes(patch.kind)) {
    next.kind = patch.kind;
  }
  if (typeof patch.priority === 'string' && ['high', 'normal', 'low'].includes(patch.priority)) {
    next.priority = patch.priority;
  }
  if (patch.dueAt !== undefined) {
    next.dueAt = patch.dueAt ? new Date(patch.dueAt).toISOString() : null;
    next.remindedStages = [];
  }
  if (Array.isArray(patch.tags)) {
    next.tags = patch.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof patch.done === 'boolean') {
    next.done = patch.done;
    next.completedAt = patch.done ? new Date().toISOString() : null;
  }

  store.items[idx] = next;
  writeJson(paths.inbox, store);
  return next;
}

export function deleteInboxItem(id, options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const { paths } = loadRuntime(rootDir);
  const store = readJson(paths.inbox, EMPTY_INBOX);
  const prevLen = (store.items || []).length;
  const removed = (store.items || []).find((it) => it.id === id) || null;
  store.items = (store.items || []).filter((it) => it.id !== id);
  if (store.items.length !== prevLen) {
    writeJson(paths.inbox, store);
  }
  return removed;
}
