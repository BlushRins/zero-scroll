import { DEFAULT_ROOT, loadRuntime } from './config.mjs';
import { buildReminderPayloads, deliverNotification } from './delivery.mjs';
import { readJson, writeJson } from './store.mjs';

export function evaluateDueReminders(items, leadHours = [24, 2], now = new Date()) {
  const sortedLeads = [...leadHours].map(Number).filter((h) => h > 0).sort((a, b) => a - b);
  const triggered = [];

  for (const item of items || []) {
    if (item.done || !item.dueAt) continue;
    const dueMs = new Date(item.dueAt).getTime();
    if (Number.isNaN(dueMs)) continue;
    const hoursUntil = (dueMs - now.getTime()) / 3_600_000;
    const sent = new Set(item.remindedStages || []);

    if (hoursUntil <= 0 && hoursUntil >= -24 && !sent.has('overdue')) {
      triggered.push({ item, stage: 'overdue', stageLabel: 'Due now' });
      continue;
    }

    for (const h of sortedLeads) {
      const stage = `${h}h`;
      if (hoursUntil > 0 && hoursUntil <= h && !sent.has(stage)) {
        triggered.push({
          item,
          stage,
          stageLabel: h === 1 ? 'Due within 1 hour' : `Due within ${h} hours`,
        });
        break;
      }
    }
  }

  return triggered;
}

export async function runReminders(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const dryRun = Boolean(options.dryRun);
  const now = options.now instanceof Date ? options.now : new Date();
  const { config, env, paths } = loadRuntime(rootDir);
  const tz = config.timezone || 'Asia/Manila';
  const leadHours = config.reminders?.leadHours || [24, 2];

  const store = readJson(paths.inbox, { version: 1, items: [] });
  const triggered = evaluateDueReminders(store.items, leadHours, now);

  if (triggered.length === 0) {
    return { triggered: [], delivery: { skipped: true, reason: 'No reminders due right now.' } };
  }

  const { subject, html, text, discordPayload } = buildReminderPayloads(triggered, tz);
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

  if (!dryRun) {
    for (const { item, stage } of triggered) {
      item.remindedStages = [...new Set([...(item.remindedStages || []), stage])];
    }
    writeJson(paths.inbox, store);
  }

  return { triggered, delivery, text, discordPayload };
}
