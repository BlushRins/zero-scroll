import { localToUtcDate } from './parser.mjs';

function unfoldIcs(raw) {
  return String(raw || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function unescapeIcsText(value) {
  return String(value || '')
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function parseIcsDate(value, params, defaultTz) {
  const clean = String(value || '').trim();
  const isAllDay =
    /VALUE=DATE(?:\b|;)/i.test(params || '') || /^\d{8}$/.test(clean);

  const dateOnly = clean.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const dt = localToUtcDate(
      {
        year: Number(dateOnly[1]),
        month: Number(dateOnly[2]) - 1,
        day: Number(dateOnly[3]),
        hour: 0,
        minute: 0,
      },
      defaultTz
    );
    return { date: dt, allDay: true };
  }

  const dtMatch = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!dtMatch) return null;

  const year = Number(dtMatch[1]);
  const month = Number(dtMatch[2]) - 1;
  const day = Number(dtMatch[3]);
  const hour = Number(dtMatch[4]);
  const minute = Number(dtMatch[5]);
  const second = Number(dtMatch[6]);
  const isUtc = Boolean(dtMatch[7]);

  if (isUtc) {
    return {
      date: new Date(Date.UTC(year, month, day, hour, minute, second)),
      allDay: isAllDay,
    };
  }

  const tzMatch = String(params || '').match(/TZID=([^;:]+)/i);
  const tz = tzMatch ? tzMatch[1].replace(/^"|"$/g, '') : defaultTz;
  try {
    return {
      date: localToUtcDate({ year, month, day, hour, minute }, tz),
      allDay: isAllDay,
    };
  } catch {
    return {
      date: localToUtcDate({ year, month, day, hour, minute }, defaultTz),
      allDay: isAllDay,
    };
  }
}

export function parseIcsEvents(icsText, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const lookaheadDays = options.lookaheadDays ?? 7;
  const defaultTz = options.timezone || 'Asia/Manila';
  const windowStart = new Date(now.getTime() - 2 * 3_600_000);
  const windowEnd = new Date(now.getTime() + lookaheadDays * 86_400_000);

  const unfolded = unfoldIcs(icsText);
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current && current.startAt && current.title) {
        const startMs = new Date(current.startAt).getTime();
        if (startMs >= windowStart.getTime() && startMs <= windowEnd.getTime()) {
          events.push(current);
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const left = line.slice(0, colon);
    const val = line.slice(colon + 1);
    const semi = left.indexOf(';');
    const name = (semi === -1 ? left : left.slice(0, semi)).toUpperCase();
    const params = semi === -1 ? '' : left.slice(semi + 1);

    if (name === 'SUMMARY') {
      current.title = unescapeIcsText(val);
    } else if (name === 'LOCATION') {
      current.location = unescapeIcsText(val);
    } else if (name === 'UID') {
      current.uid = val.trim();
    } else if (name === 'DTSTART') {
      const parsed = parseIcsDate(val, params, defaultTz);
      if (parsed) {
        current.startAt = parsed.date.toISOString();
        current.allDay = parsed.allDay;
      }
    } else if (name === 'DTEND') {
      const parsed = parseIcsDate(val, params, defaultTz);
      if (parsed) {
        current.endAt = parsed.date.toISOString();
      }
    }
  }

  events.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  return events;
}

export async function fetchCalendarEvents(icalUrl, options = {}) {
  if (!icalUrl) return [];
  const fetchImpl = options.fetch || globalThis.fetch;
  const res = await fetchImpl(icalUrl, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) {
    throw new Error(`Calendar feed responded with HTTP ${res.status}`);
  }
  const text = await res.text();
  return parseIcsEvents(text, options);
}
