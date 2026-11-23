const WEEKDAYS = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const MONTHS = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const URL_RE = /https?:\/\/[^\s<>()]+/i;
const TAG_RE = /(?:^|\s)#([a-z0-9][a-z0-9_-]{0,31})/gi;

export function getLocalParts(date, timeZone = 'Asia/Manila') {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const map = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const weekdayIndex = WEEKDAYS[String(map.weekday || '').toLowerCase()] ?? date.getUTCDay();
  return {
    year: Number(map.year),
    month: Number(map.month) - 1,
    day: Number(map.day),
    hour: Number(map.hour === '24' ? '0' : map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: weekdayIndex,
  };
}

export function localToUtcDate({ year, month, day, hour = 9, minute = 0 }, timeZone = 'Asia/Manila') {
  const guessUtc = Date.UTC(year, month, day, hour, minute, 0, 0);
  const asLocal = getLocalParts(new Date(guessUtc), timeZone);
  const localWallUtc = Date.UTC(
    asLocal.year,
    asLocal.month,
    asLocal.day,
    asLocal.hour,
    asLocal.minute,
    0,
    0
  );
  const offsetMs = localWallUtc - guessUtc;
  return new Date(guessUtc - offsetMs);
}

function parseTimeToken(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === 'noon') return { hour: 12, minute: 0 };
  if (s === 'midnight') return { hour: 0, minute: 0 };
  if (s === 'morning') return { hour: 9, minute: 0 };
  if (s === 'afternoon') return { hour: 14, minute: 0 };
  if (s === 'evening') return { hour: 19, minute: 0 };
  if (s === 'tonight') return { hour: 20, minute: 0 };

  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = Number(ampm[2] || 0);
    const meridiem = ampm[3];
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  const h24 = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (h24) {
    return { hour: Number(h24[1]), minute: Number(h24[2]) };
  }
  return null;
}

function extractTime(text) {
  const timePattern =
    /\b(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|(?:[01]?\d|2[0-3]):[0-5]\d|noon|midnight)\b/i;
  const m = text.match(timePattern);
  if (!m) return { time: null, cleaned: text };
  const parsed = parseTimeToken(m[1]);
  if (!parsed) return { time: null, cleaned: text };
  const cleaned = text.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  return { time: parsed, cleaned };
}

function extractDueDate(text, now, timeZone) {
  const localNow = getLocalParts(now, timeZone);
  let working = text;

  // 1. Relative offset: "in 2 hours", "in 45 mins", "in 3 days"
  const relMatch = working.match(
    /\bin\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)\b/i
  );
  if (relMatch) {
    const qty = Number(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith('m')) ms = qty * 60_000;
    else if (unit.startsWith('h')) ms = qty * 3_600_000;
    else if (unit.startsWith('d')) ms = qty * 86_400_000;
    else if (unit.startsWith('w')) ms = qty * 7 * 86_400_000;
    const due = new Date(now.getTime() + ms);
    const cleaned = working.replace(relMatch[0], ' ').replace(/\s+/g, ' ').trim();
    return { dueAt: due.toISOString(), cleaned };
  }

  // Pull optional explicit time first so date patterns stay clean
  const { time, cleaned: afterTime } = extractTime(working);
  working = afterTime;

  const makeDate = (dayOffset, explicitTime, fallbackHour = 9) => {
    const baseUtc = new Date(Date.UTC(localNow.year, localNow.month, localNow.day + dayOffset));
    const h = explicitTime ? explicitTime.hour : fallbackHour;
    const m = explicitTime ? explicitTime.minute : 0;
    return localToUtcDate(
      {
        year: baseUtc.getUTCFullYear(),
        month: baseUtc.getUTCMonth(),
        day: baseUtc.getUTCDate(),
        hour: h,
        minute: m,
      },
      timeZone
    );
  };

  // 2. ISO date YYYY-MM-DD
  const isoMatch = working.match(/\b(?:on\s+|by\s+)?(\d{4})-(\d{2})-(\d{2})\b/i);
  if (isoMatch) {
    const due = localToUtcDate(
      {
        year: Number(isoMatch[1]),
        month: Number(isoMatch[2]) - 1,
        day: Number(isoMatch[3]),
        hour: time ? time.hour : 9,
        minute: time ? time.minute : 0,
      },
      timeZone
    );
    const cleaned = working.replace(isoMatch[0], ' ').replace(/\s+/g, ' ').trim();
    return { dueAt: due.toISOString(), cleaned };
  }

  // 3. Month Day (e.g. "Nov 28", "December 5")
  const monthNames = Object.keys(MONTHS).join('|');
  const monthRe = new RegExp(`\\b(?:on\\s+|by\\s+)?(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, 'i');
  const monthMatch = working.match(monthRe);
  if (monthMatch) {
    const month = MONTHS[monthMatch[1].toLowerCase()];
    const day = Number(monthMatch[2]);
    let year = monthMatch[3] ? Number(monthMatch[3]) : localNow.year;
    if (!monthMatch[3]) {
      const candidate = localToUtcDate({ year, month, day, hour: time ? time.hour : 23, minute: time ? time.minute : 59 }, timeZone);
      if (candidate.getTime() < now.getTime() - 86_400_000) {
        year += 1;
      }
    }
    const due = localToUtcDate(
      {
        year,
        month,
        day,
        hour: time ? time.hour : 9,
        minute: time ? time.minute : 0,
      },
      timeZone
    );
    const cleaned = working.replace(monthMatch[0], ' ').replace(/\s+/g, ' ').trim();
    return { dueAt: due.toISOString(), cleaned };
  }

  // 4. Today / Tonight / Tomorrow
  const todayMatch = working.match(/\b(?:by\s+)?(today|tonight)\b/i);
  if (todayMatch) {
    const isTonight = todayMatch[1].toLowerCase() === 'tonight';
    const due = makeDate(0, time, isTonight ? 20 : 18);
    const cleaned = working.replace(todayMatch[0], ' ').replace(/\s+/g, ' ').trim();
    return { dueAt: due.toISOString(), cleaned };
  }

  const tomorrowMatch = working.match(/\b(?:by\s+|on\s+)?(tomorrow|tmr|tmrw)\b/i);
  if (tomorrowMatch) {
    const due = makeDate(1, time, 9);
    const cleaned = working.replace(tomorrowMatch[0], ' ').replace(/\s+/g, ' ').trim();
    return { dueAt: due.toISOString(), cleaned };
  }

  // 5. Weekday ("friday", "next monday", "on wed")
  const dayNames = Object.keys(WEEKDAYS).join('|');
  const wdRe = new RegExp(`\\b(?:(?:on|by)\\s+)?(next\\s+)?(${dayNames})\\b`, 'i');
  const wdMatch = working.match(wdRe);
  if (wdMatch) {
    const isNext = Boolean(wdMatch[1]);
    const targetDay = WEEKDAYS[wdMatch[2].toLowerCase()];
    let delta = (targetDay - localNow.weekday + 7) % 7;
    if (delta === 0) delta = 7;
    if (isNext && delta < 7) delta += 7;
    const due = makeDate(delta, time, 9);
    const cleaned = working.replace(wdMatch[0], ' ').replace(/\s+/g, ' ').trim();
    return { dueAt: due.toISOString(), cleaned };
  }

  // 6. Bare time only ("call mom 5pm")
  if (time) {
    let due = makeDate(0, time);
    if (due.getTime() <= now.getTime()) {
      due = makeDate(1, time);
    }
    return { dueAt: due.toISOString(), cleaned: working };
  }

  return { dueAt: null, cleaned: text };
}

function classifyKind(rawText, hasDueDate) {
  const lower = rawText.trim().toLowerCase();

  if (/^(idea|note|thought|memo|quote)\s*:/i.test(lower)) return 'note';
  if (/^(event|meeting|cal|calendar|schedule)\s*:/i.test(lower)) return 'event';
  if (/^(task|todo|remind|reminder)\s*:/i.test(lower)) return 'task';

  if (/\b(quiz|exam|midterm|finals|class|lecture|meeting|call with|appointment|interview|webinar|sync|dinner|lunch|flight|standup)\b/i.test(lower)) {
    return 'event';
  }
  if (/\b(idea|thought|brainstorm|remember that|note to self|concept)\b/i.test(lower) && !hasDueDate) {
    return 'note';
  }
  if (hasDueDate) return 'task';
  if (/^(buy|submit|finish|send|email|fix|build|update|clean|pay|review|read|write|prepare|study|check|book|cancel|call|text|reply|remind)\b/i.test(lower)) {
    return 'task';
  }
  return 'note';
}

function inferPriority(rawText) {
  const lower = rawText.toLowerCase();
  if (/!{1,}|(\b(urgent|asap|critical|exam|quiz|midterm|final|deadline|submit|overdue|important)\b)/i.test(lower)) {
    return 'high';
  }
  if (/\b(someday|maybe|later|low priority|optional)\b/i.test(lower)) {
    return 'low';
  }
  return 'normal';
}

function stripLeadingCommandWords(text) {
  return text
    .replace(/^(?:idea|note|thought|memo|event|meeting|task|todo|reminder|read|watch|save)\s*:\s*/i, '')
    .replace(/^remind\s+me\s+(?:to\s+)?/i, '')
    .replace(/\s+(?:on|at|by)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseBrainDump(rawText, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const timeZone = options.timezone || 'Asia/Manila';
  const raw = String(rawText || '').trim();
  if (!raw) {
    throw new Error('Empty capture text.');
  }

  // Extract #tags
  const tags = [];
  const withoutTags = raw
    .replace(TAG_RE, (_, tag) => {
      const normalized = tag.toLowerCase();
      if (!tags.includes(normalized)) tags.push(normalized);
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

  // Check if URL -> Read-Later capture
  const urlMatch = withoutTags.match(URL_RE);
  if (urlMatch) {
    const url = urlMatch[0].replace(/[.,;:!?)]+$/, '');
    const remainder = stripLeadingCommandWords(withoutTags.replace(urlMatch[0], ' ').trim());
    return {
      route: 'readlater',
      kind: 'readlater',
      url,
      title: remainder || url,
      note: remainder || '',
      tags,
      priority: inferPriority(raw),
      dueAt: null,
      raw,
    };
  }

  const { dueAt, cleaned } = extractDueDate(withoutTags, now, timeZone);
  const kind = classifyKind(withoutTags, Boolean(dueAt));
  const priority = inferPriority(raw);
  const title = stripLeadingCommandWords(cleaned) || stripLeadingCommandWords(withoutTags) || raw;

  return {
    route: 'inbox',
    kind,
    title,
    url: null,
    dueAt,
    tags,
    priority,
    raw,
  };
}
