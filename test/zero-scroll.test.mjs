import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runMorningBriefing } from '../src/briefing.mjs';
import { parseIcsEvents } from '../src/calendar.mjs';
import {
  buildBriefingDiscordPayload,
  renderBriefingEmailHtml,
  renderBriefingPlainText,
} from '../src/delivery.mjs';
import { addBrainDump, deleteInboxItem, listInbox, updateInboxItem } from '../src/inbox.mjs';
import { fetchNewsDigest, parseFeedXml, pruneSeenUrls } from '../src/news.mjs';
import { parseBrainDump } from '../src/parser.mjs';
import { listReadLater, saveReadLater } from '../src/readlater.mjs';
import { evaluateDueReminders, runReminders } from '../src/reminders.mjs';
import { createAppServer } from '../src/server.mjs';
import { extractArticleFromHtml, extractiveBullets, isYouTubeUrl, summarizeUrl } from '../src/summarizer.mjs';

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-scroll-test-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web', 'index.html'), '<h1>ZeroScroll</h1>', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        name: 'ZeroScroll',
        timezone: 'Asia/Manila',
        weather: { enabled: true, city: 'Manila', latitude: 14.5995, longitude: 120.9842, unit: 'celsius' },
        briefing: { maxNewsPerTopic: 3, maxReadLaterItems: 5, lookaheadDays: 7, markReadLaterDigested: true },
        reminders: { leadHours: [24, 2] },
        news: {
          topics: [{ name: 'OpenAI', query: 'OpenAI', maxItems: 3 }],
          feeds: [],
        },
        delivery: { gmail: true, discord: true },
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'data', 'inbox.json'), '{"version":1,"items":[]}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'data', 'readlater.json'), '{"version":1,"items":[]}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'data', 'seen.json'), '{"version":1,"urls":{}}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'data', 'last-briefing.json'), '{"generatedAt":null}\n', 'utf8');
  return dir;
}

test('parseBrainDump classifies tasks, events, notes, tags, dates and URLs', () => {
  // Tuesday, Nov 24 2026 08:00 Asia/Manila (00:00 UTC)
  const now = new Date('2026-11-24T00:00:00.000Z');

  assert.equal(parseBrainDump('submit 2026-02-31', { now }).dueAt, null);
  const task = parseBrainDump('submit IT3107 lab Friday 5pm #school', { now, timezone: 'Asia/Manila' });
  assert.equal(task.route, 'inbox');
  assert.equal(task.kind, 'task');
  assert.equal(task.priority, 'high');
  assert.deepEqual(task.tags, ['school']);
  assert.equal(task.title, 'submit IT3107 lab');
  // Friday Nov 27 2026 17:00 Manila = 09:00 UTC
  assert.equal(task.dueAt, '2026-11-27T09:00:00.000Z');

  const ev = parseBrainDump('Database quiz tomorrow 9:30am #uni', { now, timezone: 'Asia/Manila' });
  assert.equal(ev.kind, 'event');
  assert.equal(ev.priority, 'high');
  assert.equal(ev.dueAt, '2026-11-25T01:30:00.000Z');

  const rel = parseBrainDump('remind me in 2 hours to stretch', { now, timezone: 'Asia/Manila' });
  assert.equal(rel.kind, 'task');
  assert.equal(rel.dueAt, '2026-11-24T02:00:00.000Z');

  const note = parseBrainDump('idea: custom Hyprland quick capture shortcut #linux', { now, timezone: 'Asia/Manila' });
  assert.equal(note.kind, 'note');
  assert.equal(note.dueAt, null);
  assert.deepEqual(note.tags, ['linux']);

  const link = parseBrainDump('read: https://openai.com/index/example-post/ check tonight #ai', { now, timezone: 'Asia/Manila' });
  assert.equal(link.route, 'readlater');
  assert.equal(link.url, 'https://openai.com/index/example-post/');
  assert.deepEqual(link.tags, ['ai']);
});

test('parseIcsEvents parses folded lines, UTC, TZID and all-day events within window', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:ev-1',
    'SUMMARY:Algorithms Lecture ',
    ' (Room 402)',
    'DTSTART;TZID=Asia/Manila:20261125T090000',
    'DTEND;TZID=Asia/Manila:20261125T103000',
    'LOCATION:Engineering Hall',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:ev-2',
    'SUMMARY:Far Future Event',
    'DTSTART:20261230T090000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:ev-3',
    'SUMMARY:Project Demo Day',
    'DTSTART;VALUE=DATE:20261126',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const events = parseIcsEvents(ics, {
    now: new Date('2026-11-24T00:00:00.000Z'),
    lookaheadDays: 7,
    timezone: 'Asia/Manila',
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].title, 'Algorithms Lecture (Room 402)');
  assert.equal(events[0].startAt, '2026-11-25T01:00:00.000Z');
  assert.equal(events[1].title, 'Project Demo Day');
  assert.equal(events[1].allDay, true);
});

test('parseFeedXml and fetchNewsDigest parse RSS/Atom and deduplicate seen URLs', async () => {
  const sampleRss = `<?xml version="1.0"?>
  <rss version="2.0"><channel>
    <item>
      <title>OpenAI launches developer API update - TechDaily</title>
      <link>https://example.com/news/1?utm_source=rss</link>
      <pubDate>Tue, 24 Nov 2026 02:00:00 GMT</pubDate>
      <source>TechDaily</source>
    </item>
    <item>
      <title>OpenAI opens research benchmark - ScienceWire</title>
      <link>https://example.com/news/2</link>
      <pubDate>Tue, 24 Nov 2026 03:00:00 GMT</pubDate>
    </item>
  </channel></rss>`;

  const parsed = parseFeedXml(sampleRss);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'OpenAI launches developer API update');
  assert.equal(parsed[0].source, 'TechDaily');
  assert.equal(parsed[1].source, 'ScienceWire');

  const mockFetch = async () => new Response(sampleRss, { status: 200 });
  const initialSeen = {
    version: 1,
    urls: {
      'https://example.com/news/1': '2026-11-23T00:00:00.000Z',
      'https://example.com/ancient': '2025-01-01T00:00:00.000Z',
    },
  };

  const pruned = pruneSeenUrls(initialSeen, 30, new Date('2026-11-24T04:00:00.000Z'));
  assert.equal(Boolean(pruned.urls['https://example.com/ancient']), false);

  const digest = await fetchNewsDigest(
    { topics: [{ name: 'OpenAI', query: 'OpenAI', maxItems: 3 }], feeds: [] },
    initialSeen,
    { fetch: mockFetch, now: new Date('2026-11-24T04:00:00.000Z') }
  );
  assert.equal(digest.sections[0].items.length, 1);
  assert.equal(digest.sections[0].items[0].url, 'https://example.com/news/2');

  // Verify trustedSources, excludePatterns (anti-fake leaks), and freshness window
  const mixedRss = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item>
      <title>OpenAI internal roadmap leaked to reporters - Reuters</title>
      <link>https://example.com/real-leak</link>
      <pubDate>Tue, 24 Nov 2026 02:00:00 GMT</pubDate>
      <source>Reuters</source>
    </item>
    <item>
      <title>Unconfirmed GPT-9 rumor goes viral on TikTok - RandomBlog</title>
      <link>https://example.com/fake-leak</link>
      <pubDate>Tue, 24 Nov 2026 02:00:00 GMT</pubDate>
      <source>RandomBlog</source>
    </item>
    <item>
      <title>Unconfirmed rumor about AI chip - Reuters</title>
      <link>https://example.com/rumor-reuters</link>
      <pubDate>Tue, 24 Nov 2026 02:00:00 GMT</pubDate>
      <source>Reuters</source>
    </item>
    <item>
      <title>Old AI announcement from last month - Reuters</title>
      <link>https://example.com/stale-news</link>
      <pubDate>Thu, 01 Oct 2026 02:00:00 GMT</pubDate>
      <source>Reuters</source>
    </item>
  </channel></rss>`;

  const vetted = await fetchNewsDigest(
    {
      maxAgeDays: 7,
      excludePatterns: ['\\brumou?r\\b', '\\bunconfirmed\\b', '\\btiktok\\b'],
      topics: [{ name: 'Verified Leaks', query: 'AI leak', maxItems: 5, trustedSources: ['Reuters', 'Bloomberg'] }],
      feeds: [],
    },
    { version: 1, urls: {} },
    { fetch: async () => new Response(mixedRss, { status: 200 }), now: new Date('2026-11-24T04:00:00.000Z') }
  );
  assert.equal(vetted.sections[0].items.length, 1);
  assert.equal(vetted.sections[0].items[0].url, 'https://example.com/real-leak');
});

test('summarizer extracts article paragraphs and builds deterministic 3-bullet summaries offline', async () => {
  assert.equal(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://openai.com/news/'), false);

  const html = `<html><head><title>Zero-Scrolling Systems</title><meta name="description" content="How batched daily briefings cut notification fatigue."></head>
  <body><nav>Home About</nav><article>
    <p>Constant feed checking fragments focus across dozens of tiny interruptions throughout the workday. Researchers consistently find that recovering full attention takes more than twenty minutes after each alert.</p>
    <p>Batching news, tasks, and saved links into one scheduled morning briefing eliminates reactive scrolling. Instead of opening five apps on waking, you scan one structured digest in two minutes.</p>
    <p>Natural-language capture lets you record deadlines in seconds without leaving your workflow. Automated reminders then fire only when an actual due date approaches.</p>
    <p>Three-bullet summaries turn overgrown read-later bookmark lists into actionable knowledge you actually finish.</p>
  </article></body></html>`;

  const extracted = extractArticleFromHtml(html, 'https://example.com/post');
  assert.equal(extracted.title, 'Zero-Scrolling Systems');
  const bullets = extractiveBullets(extracted.text, extracted.title, 3);
  assert.equal(bullets.length, 3);

  const mockFetch = async () => new Response(html, { status: 200 });
  const summary = await summarizeUrl('https://example.com/post', { fetch: mockFetch });
  assert.equal(summary.title, 'Zero-Scrolling Systems');
  assert.equal(summary.bullets.length, 3);
  assert.equal(summary.summarizedBy, 'extractive');
});

test('evaluateDueReminders triggers 24h, 2h, and overdue stages without duplicates', () => {
  const now = new Date('2026-11-24T06:00:00.000Z');
  const items = [
    { id: '1', title: 'Due in 90m', dueAt: '2026-11-24T07:30:00.000Z', done: false, remindedStages: [] },
    { id: '2', title: 'Due in 12h', dueAt: '2026-11-24T18:00:00.000Z', done: false, remindedStages: [] },
    { id: '3', title: 'Already reminded 24h', dueAt: '2026-11-24T18:00:00.000Z', done: false, remindedStages: ['24h'] },
    { id: '4', title: 'Done task', dueAt: '2026-11-24T07:00:00.000Z', done: true, remindedStages: [] },
    { id: '5', title: 'Overdue 1h', dueAt: '2026-11-24T05:00:00.000Z', done: false, remindedStages: [] },
  ];

  const triggered = evaluateDueReminders(items, [24, 2], now);
  assert.deepEqual(
    triggered.map((t) => [t.item.id, t.stage]),
    [
      ['1', '2h'],
      ['2', '24h'],
      ['5', 'overdue'],
    ]
  );
});

test('end-to-end briefing, reminders, inbox routing and HTTP server work cleanly', async () => {
  const dir = makeTempProject();
  try {
    const mockFetch = async (url) => {
      const s = String(url);
      if (s.includes('api.open-meteo.com')) {
        return new Response(
          JSON.stringify({
            current: { temperature_2m: 29.4, apparent_temperature: 32.1, weather_code: 2 },
            daily: { temperature_2m_max: [32.6], temperature_2m_min: [25.2], precipitation_probability_max: [40], weather_code: [2] },
          }),
          { status: 200 }
        );
      }
      if (s.includes('news.google.com')) {
        return new Response(
          `<rss><channel><item><title>OpenAI ships new reasoning model - TechPress</title><link>https://example.com/openai-model</link><source>TechPress</source></item></channel></rss>`,
          { status: 200 }
        );
      }
      return new Response(
        `<html><head><title>Deep Work Guide</title></head><body><article><p>Deep work requires uninterrupted focus blocks free from reactive chat and social feeds. Scheduling a single daily review keeps commitments visible without constant checking. Writing tasks down immediately clears mental residue.</p></article></body></html>`,
        { status: 200 }
      );
    };

    const now = new Date('2026-11-24T00:00:00.000Z');
    const addedTask = await addBrainDump('submit capstone report tomorrow 9am #school', { rootDir: dir, now, fetch: mockFetch });
    assert.equal(addedTask.route, 'inbox');
    assert.equal(listInbox({ rootDir: dir }).length, 1);

    const addedUrl = await addBrainDump('https://example.com/deep-work', { rootDir: dir, now, fetch: mockFetch });
    assert.equal(addedUrl.route, 'readlater');
    assert.equal(listReadLater({ rootDir: dir }).length, 1);

    const dry = await runMorningBriefing({ rootDir: dir, dryRun: true, now, fetch: mockFetch });
    assert.equal(dry.briefing.weather.city, 'Manila');
    assert.equal(dry.briefing.dueSoon.length, 1);
    assert.equal(dry.briefing.news[0].items.length, 1);
    assert.equal(dry.briefing.readLater.length, 1);
    assert.ok(renderBriefingEmailHtml(dry.briefing).includes('OpenAI ships new reasoning model'));
    assert.ok(renderBriefingPlainText(dry.briefing).includes('Deep Work Guide'));
    const discord = buildBriefingDiscordPayload(dry.briefing);
    assert.equal(discord.embeds.length, 3);

    // Dry run must NOT mark links digested
    assert.equal(listReadLater({ rootDir: dir })[0].status, 'unread');

    // Non-dry run marks seen & digested
    await runMorningBriefing({ rootDir: dir, dryRun: false, now, fetch: mockFetch });
    assert.equal(listReadLater({ rootDir: dir })[0].status, 'digested');

    // Reminders dry run picks up task due in ~25h? At +2h from now it's 23h away -> hits 24h stage!
    const rem = await runReminders({ rootDir: dir, dryRun: true, now: new Date('2026-11-24T02:00:00.000Z') });
    assert.equal(rem.triggered.length, 1);
    assert.equal(rem.triggered[0].stage, '24h');

    // Update & delete inbox item
    const updated = updateInboxItem(addedTask.item.id, { done: true }, { rootDir: dir });
    assert.equal(updated.done, true);
    const removed = deleteInboxItem(addedTask.item.id, { rootDir: dir });
    assert.equal(removed.id, addedTask.item.id);

    // Save readlater directly
    const rl2 = await saveReadLater('https://example.com/second', { rootDir: dir, fetch: mockFetch });
    assert.equal(rl2.status, 'unread');

    // HTTP server smoke test
    const server = createAppServer({ rootDir: dir, fetch: mockFetch });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`);
      assert.equal(stateRes.status, 200);
      const st = await stateRes.json();
      assert.equal(st.mode, 'local');

      const postRes = await fetch(`http://127.0.0.1:${port}/api/dump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'buy USB-C cable tomorrow 6pm' }),
      });
      assert.equal(postRes.status, 201);
      const posted = await postRes.json();
      assert.equal(posted.route, 'inbox');
      assert.equal(posted.item.kind, 'task');
      const endpoint = `http://127.0.0.1:${port}/api/inbox/${posted.item.id}`;
      const editedRes = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueAt: '2026-12-31T08:00:00Z', done: true }),
      });
      const edited = (await editedRes.json()).item;
      assert.equal(edited.done, true);
      assert.equal((await fetch(endpoint, { method: 'DELETE' })).status, 200);
      const undone = await fetch(`${endpoint}/restore`, { method: 'POST' });
      assert.equal(undone.status, 200);
      assert.deepEqual((await undone.json()).item, edited);
      assert.equal((await fetch(`${endpoint}/restore`, { method: 'POST' })).status, 404);
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
