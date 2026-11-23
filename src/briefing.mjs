import { fetchCalendarEvents } from './calendar.mjs';
import { DEFAULT_ROOT, loadRuntime } from './config.mjs';
import {
  buildBriefingDiscordPayload,
  deliverNotification,
  formatLocalDate,
  renderBriefingEmailHtml,
  renderBriefingPlainText,
} from './delivery.mjs';
import { fetchNewsDigest } from './news.mjs';
import { prepareReadLaterDigestItems } from './readlater.mjs';
import { readJson, writeJson } from './store.mjs';
import { fetchWeather } from './weather.mjs';

export async function runMorningBriefing(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const dryRun = Boolean(options.dryRun);
  const now = options.now instanceof Date ? options.now : new Date();
  const { config, env, paths } = loadRuntime(rootDir);
  const tz = config.timezone || 'Asia/Manila';
  const lookaheadDays = config.briefing?.lookaheadDays ?? 7;
  const warnings = [];

  // 1. Weather
  let weather = null;
  if (config.weather?.enabled !== false) {
    try {
      weather = await fetchWeather(config.weather, { timezone: tz, fetch: options.fetch });
    } catch (err) {
      warnings.push(`Weather: ${err.message}`);
    }
  }

  // 2. Calendar (.ics)
  let schedule = [];
  if (env.icalUrl) {
    try {
      schedule = await fetchCalendarEvents(env.icalUrl, {
        now,
        lookaheadDays,
        timezone: tz,
        fetch: options.fetch,
      });
    } catch (err) {
      warnings.push(`Calendar: ${err.message}`);
    }
  }

  // 3. Brain Dump due items in lookahead window (plus overdue open tasks)
  const inboxStore = readJson(paths.inbox, { version: 1, items: [] });
  const horizonMs = now.getTime() + lookaheadDays * 86_400_000;
  const dueSoon = (inboxStore.items || [])
    .filter((item) => !item.done && item.dueAt && new Date(item.dueAt).getTime() <= horizonMs)
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

  // 4. Topic News
  const seenStore = readJson(paths.seen, { version: 1, urls: {} });
  const newsResult = await fetchNewsDigest(config.news, seenStore, {
    now,
    maxNewsPerTopic: config.briefing?.maxNewsPerTopic ?? 4,
    fetch: options.fetch,
  });
  for (const e of newsResult.errors) warnings.push(`News: ${e}`);

  // 5. Read-Later Digest
  const readLaterPrep = await prepareReadLaterDigestItems({
    rootDir,
    dryRun,
    fetch: options.fetch,
  });

  const dateLabel = formatLocalDate(now, tz);
  const briefing = {
    generatedAt: now.toISOString(),
    dateLabel,
    timezone: tz,
    weather,
    schedule,
    dueSoon,
    news: newsResult.sections,
    readLater: readLaterPrep.items,
    warnings,
  };

  const subject = `ZeroScroll Morning Briefing: ${dateLabel}`;
  const html = renderBriefingEmailHtml(briefing, tz);
  const text = renderBriefingPlainText(briefing, tz);
  const discordPayload = buildBriefingDiscordPayload(briefing, tz);

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

  // Always save snapshot so the Web UI can display the latest briefing
  writeJson(paths.lastBriefing, briefing);

  if (!dryRun) {
    writeJson(paths.seen, newsResult.updatedSeen);
    if (config.briefing?.markReadLaterDigested !== false && readLaterPrep.items.length > 0) {
      const ids = new Set(readLaterPrep.items.map((it) => it.id));
      for (const entry of readLaterPrep.store.items || []) {
        if (ids.has(entry.id)) {
          entry.status = 'digested';
          entry.digestedAt = now.toISOString();
        }
      }
      writeJson(paths.readLater, readLaterPrep.store);
    }
  }

  return { briefing, delivery, html, text, discordPayload };
}
