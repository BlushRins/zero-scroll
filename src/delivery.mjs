import nodemailer from 'nodemailer';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatLocalDate(isoOrDate, timeZone = 'Asia/Manila') {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

export function formatLocalShortDateTime(isoOrDate, timeZone = 'Asia/Manila', allDay = false) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return '';
  if (allDay) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(d);
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

function truncate(str, max) {
  const s = String(str || '');
  return s.length <= max ? s : `${s.slice(0, max - 1).trim()}…`;
}

export function renderBriefingEmailHtml(briefing, timeZone = 'Asia/Manila') {
  const weatherBlock = briefing.weather
    ? `<div style="border-top:1px solid #c9c2b5;padding:16px 0;">
        <div style="font-size:13px;color:#6c665c;margin-bottom:4px;">Weather in ${escapeHtml(briefing.weather.city)}</div>
        <div style="font-size:20px;color:#1f1c18;">${briefing.weather.currentTemp}${escapeHtml(briefing.weather.unit)} ${escapeHtml(briefing.weather.condition)}</div>
        <div style="font-size:14px;color:#4a453e;margin-top:4px;">High ${briefing.weather.high}${escapeHtml(briefing.weather.unit)}, low ${briefing.weather.low}${escapeHtml(briefing.weather.unit)}, rain chance ${briefing.weather.rainChance}%</div>
      </div>`
    : '';

  const scheduleRows = [
    ...(briefing.schedule || []).map((ev) => ({
      when: formatLocalShortDateTime(ev.startAt, timeZone, ev.allDay),
      label: ev.title,
      detail: ev.location || 'Calendar',
    })),
    ...(briefing.dueSoon || []).map((item) => ({
      when: item.dueAt ? formatLocalShortDateTime(item.dueAt, timeZone, false) : 'Unscheduled',
      label: item.title,
      detail: item.kind,
    })),
  ];

  const scheduleBlock =
    scheduleRows.length > 0
      ? `<div style="border-top:1px solid #c9c2b5;padding:18px 0;">
          <h2 style="font-family:Georgia,serif;font-weight:400;font-size:20px;margin:0 0 12px;color:#1f1c18;">Schedule and due items</h2>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            ${scheduleRows
              .map(
                (r) => `<tr>
                  <td style="padding:8px 12px 8px 0;border-top:1px solid #dfd8cb;font-size:13px;color:#6c665c;white-space:nowrap;vertical-align:top;">${escapeHtml(r.when)}</td>
                  <td style="padding:8px 0;border-top:1px solid #dfd8cb;font-size:15px;color:#1f1c18;">${escapeHtml(r.label)} <span style="font-size:13px;color:#6c665c;">(${escapeHtml(r.detail)})</span></td>
                </tr>`
              )
              .join('')}
          </table>
        </div>`
      : `<div style="border-top:1px solid #c9c2b5;padding:18px 0;">
          <h2 style="font-family:Georgia,serif;font-weight:400;font-size:20px;margin:0 0 8px;color:#1f1c18;">Schedule and due items</h2>
          <p style="margin:0;font-size:15px;color:#6c665c;">Clear slate ahead. No calendar events or due tasks in the next window.</p>
        </div>`;

  const newsTopics = (briefing.news || []).filter((s) => s.items && s.items.length > 0);
  const newsBlock =
    newsTopics.length > 0
      ? `<div style="border-top:1px solid #c9c2b5;padding:18px 0;">
          <h2 style="font-family:Georgia,serif;font-weight:400;font-size:20px;margin:0 0 12px;color:#1f1c18;">Topic news</h2>
          ${newsTopics
            .map(
              (sec) => `<div style="margin-bottom:16px;">
                <div style="font-size:14px;font-weight:600;color:#1f1c18;margin-bottom:6px;">${escapeHtml(sec.topic)}</div>
                <ul style="margin:0;padding-left:18px;color:#1f1c18;">
                  ${sec.items
                    .map(
                      (item) => `<li style="margin:6px 0;font-size:15px;line-height:1.45;">
                        <a href="${escapeHtml(item.url)}" style="color:#2b47a1;text-decoration:underline;">${escapeHtml(item.title)}</a>
                        <span style="font-size:13px;color:#6c665c;"> (${escapeHtml(item.source)})</span>
                      </li>`
                    )
                    .join('')}
                </ul>
              </div>`
            )
            .join('')}
        </div>`
      : '';

  const readLaterBlock =
    (briefing.readLater || []).length > 0
      ? `<div style="border-top:1px solid #c9c2b5;padding:18px 0;">
          <h2 style="font-family:Georgia,serif;font-weight:400;font-size:20px;margin:0 0 12px;color:#1f1c18;">Read-later digest</h2>
          ${briefing.readLater
            .map(
              (item) => `<div style="padding:12px 0;border-top:1px solid #dfd8cb;">
                <div style="font-size:15px;font-weight:600;">
                  <a href="${escapeHtml(item.url)}" style="color:#2b47a1;text-decoration:underline;">${escapeHtml(item.title)}</a>
                </div>
                <div style="font-size:13px;color:#6c665c;margin:2px 0 8px;">${escapeHtml(item.source || '')}${item.readingMinutes ? `, ${item.readingMinutes} min read` : ''}</div>
                <ul style="margin:0;padding-left:18px;color:#2b2722;font-size:14px;line-height:1.5;">
                  ${(item.bullets || []).map((b) => `<li style="margin:4px 0;">${escapeHtml(b)}</li>`).join('')}
                </ul>
              </div>`
            )
            .join('')}
        </div>`
      : '';

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 16px;background:#f4efe6;color:#1f1c18;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#f7f3eb;border:1px solid #c9c2b5;padding:28px 24px;">
    <div style="border-bottom:3px double #9e9688;padding-bottom:14px;margin-bottom:8px;">
      <div style="font-family:Georgia,serif;font-size:28px;color:#1f1c18;line-height:1.1;">ZeroScroll</div>
      <div style="font-size:14px;color:#6c665c;margin-top:4px;">Morning Briefing for ${escapeHtml(briefing.dateLabel || '')}</div>
    </div>
    ${weatherBlock}
    ${scheduleBlock}
    ${newsBlock}
    ${readLaterBlock}
    <div style="border-top:1px solid #c9c2b5;padding-top:14px;margin-top:12px;font-size:12px;color:#6c665c;">
      Sent automatically by ZeroScroll. Edit topics or add captures in your repo or web app.
    </div>
  </div>
</body>
</html>`;
}

export function renderBriefingPlainText(briefing, timeZone = 'Asia/Manila') {
  const lines = [`ZeroScroll Morning Briefing`, `${briefing.dateLabel || ''}`, ''];

  if (briefing.weather) {
    const w = briefing.weather;
    lines.push(
      `WEATHER (${w.city})`,
      `${w.currentTemp}${w.unit} ${w.condition} (High ${w.high}${w.unit}, Low ${w.low}${w.unit}, Rain ${w.rainChance}%)`,
      ''
    );
  }

  lines.push('SCHEDULE & DUE ITEMS');
  const combined = [
    ...(briefing.schedule || []).map(
      (ev) => `- ${formatLocalShortDateTime(ev.startAt, timeZone, ev.allDay)}: ${ev.title}`
    ),
    ...(briefing.dueSoon || []).map(
      (it) =>
        `- ${it.dueAt ? formatLocalShortDateTime(it.dueAt, timeZone, false) : 'Anytime'}: ${it.title} [${it.kind}]`
    ),
  ];
  lines.push(combined.length > 0 ? combined.join('\n') : '- Nothing scheduled in this window.');
  lines.push('');

  const newsTopics = (briefing.news || []).filter((s) => s.items && s.items.length > 0);
  if (newsTopics.length > 0) {
    lines.push('TOPIC NEWS');
    for (const sec of newsTopics) {
      lines.push(`[${sec.topic}]`);
      for (const item of sec.items) {
        lines.push(`- ${item.title} (${item.source}) ${item.url}`);
      }
      lines.push('');
    }
  }

  if ((briefing.readLater || []).length > 0) {
    lines.push('READ-LATER DIGEST');
    for (const item of briefing.readLater) {
      lines.push(`* ${item.title} (${item.url})`);
      for (const b of item.bullets || []) {
        lines.push(`  - ${b}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

export function buildBriefingDiscordPayload(briefing, timeZone = 'Asia/Manila') {
  const embeds = [];
  const summaryFields = [];

  if (briefing.weather) {
    const w = briefing.weather;
    summaryFields.push({
      name: `Weather in ${w.city}`,
      value: `${w.currentTemp}${w.unit} ${w.condition}\nHigh ${w.high}${w.unit}, low ${w.low}${w.unit}, rain ${w.rainChance}%`,
      inline: false,
    });
  }

  const agendaLines = [
    ...(briefing.schedule || []).map(
      (ev) => `- **${formatLocalShortDateTime(ev.startAt, timeZone, ev.allDay)}** ${ev.title}`
    ),
    ...(briefing.dueSoon || []).map(
      (it) =>
        `- **${it.dueAt ? formatLocalShortDateTime(it.dueAt, timeZone, false) : 'Task'}** ${it.title}`
    ),
  ];

  summaryFields.push({
    name: 'Schedule and due items',
    value:
      agendaLines.length > 0
        ? truncate(agendaLines.join('\n'), 1000)
        : 'Clear slate for this window.',
    inline: false,
  });

  embeds.push({
    title: `Morning Briefing (${briefing.dateLabel || 'Today'})`,
    color: 0x2b47a1,
    fields: summaryFields,
    timestamp: briefing.generatedAt || new Date().toISOString(),
  });

  const newsTopics = (briefing.news || []).filter((s) => s.items && s.items.length > 0);
  if (newsTopics.length > 0) {
    const fields = newsTopics.slice(0, 6).map((sec) => ({
      name: truncate(sec.topic, 250),
      value: truncate(
        sec.items.map((it) => `- [${truncate(it.title, 110)}](${it.url}) (${it.source})`).join('\n'),
        1000
      ),
      inline: false,
    }));
    embeds.push({
      title: 'Topic News',
      color: 0x1f1c18,
      fields,
    });
  }

  if ((briefing.readLater || []).length > 0) {
    const fields = briefing.readLater.slice(0, 5).map((item) => ({
      name: truncate(item.title, 250),
      value: truncate(
        [
          item.url,
          ...(item.bullets || []).map((b) => `- ${b}`),
        ].join('\n'),
        1000
      ),
      inline: false,
    }));
    embeds.push({
      title: 'Read-Later Digest',
      color: 0x5c554c,
      fields,
    });
  }

  return {
    username: 'ZeroScroll',
    embeds: embeds.slice(0, 10),
  };
}

export function buildReminderPayloads(dueItems, timeZone = 'Asia/Manila') {
  const subject =
    dueItems.length === 1
      ? `Reminder: ${dueItems[0].item.title}`
      : `ZeroScroll: ${dueItems.length} upcoming reminders`;

  const textLines = [
    'ZeroScroll Reminders',
    '',
    ...dueItems.map(({ item, stageLabel }) => {
      const when = formatLocalShortDateTime(item.dueAt, timeZone, false);
      return `- [${stageLabel}] ${item.title} (Due ${when})`;
    }),
  ];

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px 16px;background:#f4efe6;color:#1f1c18;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#f7f3eb;border:1px solid #c9c2b5;padding:24px;">
    <div style="font-family:Georgia,serif;font-size:24px;border-bottom:3px double #9e9688;padding-bottom:10px;margin-bottom:14px;">Upcoming Reminders</div>
    ${dueItems
      .map(
        ({ item, stageLabel }) => `<div style="padding:10px 0;border-bottom:1px solid #dfd8cb;">
          <div style="font-size:15px;font-weight:600;color:#1f1c18;">${escapeHtml(item.title)}</div>
          <div style="font-size:13px;color:#6c665c;margin-top:2px;">${escapeHtml(stageLabel)}, due ${escapeHtml(formatLocalShortDateTime(item.dueAt, timeZone, false))}</div>
        </div>`
      )
      .join('')}
  </div>
</body>
</html>`;

  const discordPayload = {
    username: 'ZeroScroll',
    embeds: [
      {
        title: dueItems.length === 1 ? 'Reminder' : `${dueItems.length} Upcoming Reminders`,
        color: 0x9b3b2e,
        description: truncate(
          dueItems
            .map(
              ({ item, stageLabel }) =>
                `- **${item.title}**\n  ${stageLabel}, due ${formatLocalShortDateTime(item.dueAt, timeZone, false)}`
            )
            .join('\n'),
          3900
        ),
        timestamp: new Date().toISOString(),
      },
    ],
  };

  return { subject, html, text: textLines.join('\n'), discordPayload };
}

export async function sendGmail({ env, subject, html, text, dryRun = false }) {
  if (!env.gmailUser || !env.gmailAppPassword || !env.gmailTo) {
    return { status: 'skipped', reason: 'GMAIL_USER or GMAIL_APP_PASSWORD not set' };
  }
  if (dryRun) {
    return { status: 'dry-run', to: env.gmailTo, subject };
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: env.gmailUser,
      pass: env.gmailAppPassword,
    },
  });
  const info = await transporter.sendMail({
    from: `ZeroScroll <${env.gmailUser}>`,
    to: env.gmailTo,
    subject,
    text,
    html,
  });
  return { status: 'sent', messageId: info.messageId, to: env.gmailTo };
}

export async function sendDiscord({ env, payload, dryRun = false, fetch: fetchImpl = globalThis.fetch }) {
  if (!env.discordWebhookUrl) {
    return { status: 'skipped', reason: 'DISCORD_WEBHOOK_URL not set' };
  }
  if (dryRun) {
    return { status: 'dry-run', embeds: payload.embeds?.length || 0 };
  }
  const res = await fetchImpl(env.discordWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Discord webhook HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  return { status: 'sent', embeds: payload.embeds?.length || 0 };
}

export async function deliverNotification({
  config,
  env,
  subject,
  html,
  text,
  discordPayload,
  dryRun = false,
  fetch: fetchImpl = globalThis.fetch,
}) {
  const results = { gmail: { status: 'disabled' }, discord: { status: 'disabled' } };

  if (config?.delivery?.gmail !== false) {
    try {
      results.gmail = await sendGmail({ env, subject, html, text, dryRun });
    } catch (err) {
      results.gmail = { status: 'error', error: err.message };
    }
  }

  if (config?.delivery?.discord !== false) {
    try {
      results.discord = await sendDiscord({ env, payload: discordPayload, dryRun, fetch: fetchImpl });
    } catch (err) {
      results.discord = { status: 'error', error: err.message };
    }
  }

  return results;
}
