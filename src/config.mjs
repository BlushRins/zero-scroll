import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(__dirname, '..');

export function loadDotEnv(rootDir = DEFAULT_ROOT) {
  const envPath = path.join(rootDir, '.env');
  const parsed = {};
  if (!fs.existsSync(envPath)) return parsed;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    parsed[key] = val;
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  return parsed;
}

export function getPaths(rootDir = DEFAULT_ROOT) {
  const dataDir = path.join(rootDir, 'data');
  return {
    root: rootDir,
    config: path.join(rootDir, 'config.json'),
    dataDir,
    inbox: path.join(dataDir, 'inbox.json'),
    readLater: path.join(dataDir, 'readlater.json'),
    seen: path.join(dataDir, 'seen.json'),
    lastBriefing: path.join(dataDir, 'last-briefing.json'),
    webDir: path.join(rootDir, 'web'),
  };
}

export function loadRuntime(rootDir = DEFAULT_ROOT) {
  loadDotEnv(rootDir);
  const paths = getPaths(rootDir);
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const env = {
    gmailUser: (process.env.GMAIL_USER || '').trim(),
    gmailAppPassword: (process.env.GMAIL_APP_PASSWORD || '').trim(),
    gmailTo: (process.env.GMAIL_TO || process.env.GMAIL_USER || '').trim(),
    discordWebhookUrl: (process.env.DISCORD_WEBHOOK_URL || '').trim(),
    geminiApiKey: (process.env.GEMINI_API_KEY || '').trim(),
    icalUrl: (process.env.ICAL_URL || '').trim(),
  };
  return { config, env, paths };
}

export function saveConfig(nextConfig, rootDir = DEFAULT_ROOT) {
  const paths = getPaths(rootDir);
  const tmp = `${paths.config}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, paths.config);
  return nextConfig;
}
