const STORAGE_KEYS = {
  inbox: 'zeroscroll_inbox_v1',
  readLater: 'zeroscroll_readlater_v1',
  briefing: 'zeroscroll_briefing_v1',
  sync: 'zeroscroll_sync_v1',
};

const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const state = {
  mode: 'offline', // 'local' | 'github' | 'offline'
  tab: 'briefing',
  inboxFilter: 'open',
  rlFilter: 'unread',
  inbox: [],
  readLater: [],
  briefing: null,
  channels: null,
  sync: loadSyncConfig(),
  undoTimer: null,
  pendingUndo: null,
};

const el = (id) => document.getElementById(id);

function loadSyncConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.sync) || '{}');
    if (!saved.repo && location.hostname.endsWith('.github.io')) {
      const owner = location.hostname.replace('.github.io', '');
      const repoName = location.pathname.split('/').filter(Boolean)[0] || 'zero-scroll';
      saved.repo = `${owner}/${repoName}`;
    }
    return {
      repo: saved.repo || '',
      branch: saved.branch || 'main',
      token: saved.token || '',
    };
  } catch {
    return { repo: '', branch: 'main', token: '' };
  }
}

function saveSyncConfig(next) {
  state.sync = next;
  localStorage.setItem(STORAGE_KEYS.sync, JSON.stringify(next));
}

function makeClientId(prefix) {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function parseClientCapture(rawText) {
  const raw = rawText.trim();
  const tags = [];
  const withoutTags = raw
    .replace(/(?:^|\s)#([a-z0-9][a-z0-9_-]{0,31})/gi, (_, tag) => {
      const norm = tag.toLowerCase();
      if (!tags.includes(norm)) tags.push(norm);
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

  const urlMatch = withoutTags.match(/https?:\/\/[^\s<>()]+/i);
  if (urlMatch) {
    const url = urlMatch[0].replace(/[.,;:!?)]+$/, '');
    const note = withoutTags.replace(urlMatch[0], ' ').replace(/^(?:read|watch|save)\s*:\s*/i, '').trim();
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = 'web'; }
    return {
      route: 'readlater',
      item: {
        id: makeClientId('rl'),
        url,
        title: note || host || url,
        source: host,
        kind: /youtu\.?be/i.test(host) ? 'video' : 'article',
        note,
        tags,
        readingMinutes: null,
        bullets: ['Queued for three-bullet summary in the next Morning Briefing run.'],
        status: 'unread',
        savedAt: new Date().toISOString(),
        digestedAt: null,
      },
    };
  }

  let working = withoutTags;
  let dueAt = null;
  const now = new Date();

  const relMatch = working.match(/\bin\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i);
  if (relMatch) {
    const qty = Number(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const mult = unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000;
    dueAt = new Date(now.getTime() + qty * mult).toISOString();
    working = working.replace(relMatch[0], ' ').replace(/\s+/g, ' ').trim();
  } else {
    let time = null;
    const tMatch = working.match(/\b(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|(?:[01]?\d|2[0-3]):[0-5]\d|noon|midnight)\b/i);
    if (tMatch) {
      const s = tMatch[1].toLowerCase();
      if (s === 'noon') time = { h: 12, m: 0 };
      else if (s === 'midnight') time = { h: 0, m: 0 };
      else {
        const ap = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
        if (ap) {
          let h = Number(ap[1]);
          const m = Number(ap[2] || 0);
          if (ap[3] === 'pm' && h !== 12) h += 12;
          if (ap[3] === 'am' && h === 12) h = 0;
          time = { h, m };
        } else {
          const [h, m] = s.split(':').map(Number);
          time = { h, m };
        }
      }
      working = working.replace(tMatch[0], ' ').replace(/\s+/g, ' ').trim();
    }

    const setDay = (offset, defaultHour = 9) => {
      const d = new Date(now);
      d.setDate(d.getDate() + offset);
      d.setHours(time ? time.h : defaultHour, time ? time.m : 0, 0, 0);
      return d.toISOString();
    };

    const mRe = new RegExp(`\\b(?:on\\s+|by\\s+)?(${Object.keys(MONTHS).join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');
    const wdRe = new RegExp(`\\b(?:(?:on|by)\\s+)?(next\\s+)?(${Object.keys(WEEKDAYS).join('|')})\\b`, 'i');

    if (/\b(?:by\s+)?(today|tonight)\b/i.test(working)) {
      const m = working.match(/\b(?:by\s+)?(today|tonight)\b/i);
      dueAt = setDay(0, m[1].toLowerCase() === 'tonight' ? 20 : 18);
      working = working.replace(m[0], ' ').trim();
    } else if (/\b(?:by\s+|on\s+)?(tomorrow|tmr|tmrw)\b/i.test(working)) {
      const m = working.match(/\b(?:by\s+|on\s+)?(tomorrow|tmr|tmrw)\b/i);
      dueAt = setDay(1, 9);
      working = working.replace(m[0], ' ').trim();
    } else if (mRe.test(working)) {
      const m = working.match(mRe);
      const d = new Date(now.getFullYear(), MONTHS[m[1].toLowerCase()], Number(m[2]), time ? time.h : 9, time ? time.m : 0);
      if (d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1);
      dueAt = d.toISOString();
      working = working.replace(m[0], ' ').trim();
    } else if (wdRe.test(working)) {
      const m = working.match(wdRe);
      const target = WEEKDAYS[m[2].toLowerCase()];
      let delta = (target - now.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      if (m[1] && delta < 7) delta += 7;
      dueAt = setDay(delta, 9);
      working = working.replace(m[0], ' ').trim();
    } else if (time) {
      const d = new Date(now);
      d.setHours(time.h, time.m, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      dueAt = d.toISOString();
    }
  }

  const lower = withoutTags.toLowerCase();
  let kind = 'note';
  if (/^(idea|note|thought)\s*:/i.test(lower)) kind = 'note';
  else if (/^(event|meeting|cal)\s*:/i.test(lower) || /\b(quiz|exam|class|meeting|call with|appointment|dinner|flight)\b/i.test(lower)) kind = 'event';
  else if (/^(task|todo|remind)\s*:/i.test(lower) || dueAt || /^(buy|submit|finish|send|email|fix|build|pay|review|study|check)\b/i.test(lower)) kind = 'task';

  const priority = /!|\b(urgent|asap|exam|quiz|deadline|submit|important)\b/i.test(raw) ? 'high' : 'normal';
  const title = working
    .replace(/^(?:idea|note|thought|event|meeting|task|todo|reminder)\s*:\s*/i, '')
    .replace(/^remind\s+me\s+(?:to\s+)?/i, '')
    .replace(/\s+(?:on|at|by)$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || raw;

  return {
    route: 'inbox',
    item: {
      id: makeClientId('inb'),
      kind,
      title,
      raw,
      dueAt,
      tags,
      priority,
      done: false,
      remindedStages: [],
      createdAt: now.toISOString(),
      completedAt: null,
    },
  };
}

function formatShortTime(iso, allDay = false) {
  if (!iso) return 'Anytime';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Anytime';
  if (allDay) {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  }
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(d);
}

// GitHub Contents API helpers for 24/7 phone sync without a server
async function ghReadJson(filePath) {
  const { repo, branch, token } = state.sync;
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers, cache: 'no-store' });
  if (!res.ok) throw new Error(`GitHub read failed (${res.status}) for ${filePath}`);
  const payload = await res.json();
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(payload.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
  return { data: JSON.parse(decoded), sha: payload.sha };
}

async function ghWriteJson(filePath, data, message) {
  const { repo, branch, token } = state.sync;
  if (!repo || !token) throw new Error('Add a GitHub repo and token in Sync settings to sync from your phone.');
  let sha;
  try {
    const existing = await ghReadJson(filePath);
    sha = existing.sha;
  } catch {
    sha = undefined;
  }
  const jsonStr = `${JSON.stringify(data, null, 2)}\n`;
  const bytes = new TextEncoder().encode(jsonStr);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const content = btoa(binary);

  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, content, branch, sha }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub write failed (${res.status})`);
  }
}

function saveOfflineMirror() {
  localStorage.setItem(STORAGE_KEYS.inbox, JSON.stringify(state.inbox));
  localStorage.setItem(STORAGE_KEYS.readLater, JSON.stringify(state.readLater));
  if (state.briefing) localStorage.setItem(STORAGE_KEYS.briefing, JSON.stringify(state.briefing));
}

function loadOfflineMirror() {
  try {
    state.inbox = JSON.parse(localStorage.getItem(STORAGE_KEYS.inbox) || '[]');
    state.readLater = JSON.parse(localStorage.getItem(STORAGE_KEYS.readLater) || '[]');
    state.briefing = JSON.parse(localStorage.getItem(STORAGE_KEYS.briefing) || 'null');
  } catch {
    state.inbox = [];
    state.readLater = [];
    state.briefing = null;
  }
}

function setLoading(isLoading) {
  for (const name of ['briefing', 'inbox', 'readlater']) {
    el(`${name}-loading`).hidden = !isLoading;
  }
  if (isLoading) {
    el('briefing-content').hidden = true;
    el('briefing-empty').hidden = true;
    el('briefing-error').hidden = true;
    el('inbox-table-wrap').hidden = true;
    el('inbox-empty').hidden = true;
    el('inbox-error').hidden = true;
    el('readlater-list').hidden = true;
    el('readlater-empty').hidden = true;
    el('readlater-error').hidden = true;
  }
}

async function loadState() {
  setLoading(true);
  try {
    const apiRes = await fetch('/api/state', { cache: 'no-store' });
    if (apiRes.ok && (apiRes.headers.get('content-type') || '').includes('application/json')) {
      const data = await apiRes.json();
      state.mode = 'local';
      state.inbox = data.inbox || [];
      state.readLater = data.readLater || [];
      state.briefing = data.lastBriefing?.generatedAt ? data.lastBriefing : null;
      state.channels = data.channels || null;
      saveOfflineMirror();
      setLoading(false);
      renderAll();
      return;
    }
  } catch {
    // Fall through to GitHub sync or offline storage
  }

  if (state.sync.repo && state.sync.token) {
    try {
      const [inb, rl, br] = await Promise.all([
        ghReadJson('data/inbox.json'),
        ghReadJson('data/readlater.json'),
        ghReadJson('data/last-briefing.json'),
      ]);
      state.mode = 'github';
      state.inbox = inb.data.items || [];
      state.readLater = rl.data.items || [];
      state.briefing = br.data.generatedAt ? br.data : null;
      saveOfflineMirror();
      setLoading(false);
      renderAll();
      return;
    } catch (err) {
      loadOfflineMirror();
      state.mode = 'offline';
      setLoading(false);
      renderAll();
      showErrorState('briefing', 'GitHub sync could not connect.', err.message);
      return;
    }
  }

  // Static GitHub Pages read-only snapshot + browser localStorage captures
  loadOfflineMirror();
  state.mode = 'offline';
  try {
    const snapRes = await fetch('./data/last-briefing.json', { cache: 'no-store' });
    if (snapRes.ok) {
      const snap = await snapRes.json();
      if (snap && snap.generatedAt) state.briefing = snap;
    }
  } catch {
    // Offline fallback stays intact
  }
  setLoading(false);
  renderAll();
}

function showErrorState(panel, title, body) {
  el(`${panel}-error`).hidden = false;
  if (el(`${panel}-error-title`)) el(`${panel}-error-title`).textContent = title;
  if (el(`${panel}-error-body`)) el(`${panel}-error-body`).textContent = body;
}

function updateUrlState() {
  const params = new URLSearchParams();
  if (state.tab === 'inbox') params.set('filter', state.inboxFilter);
  if (state.tab === 'readlater') params.set('status', state.rlFilter);
  const query = params.toString();
  const nextHash = `#${state.tab}${query ? `?${query}` : ''}`;
  if (location.hash !== nextHash) {
    history.replaceState(null, '', nextHash);
  }
}

function readUrlState() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return;
  const [tabPart, queryPart] = raw.split('?');
  if (['briefing', 'inbox', 'readlater'].includes(tabPart)) {
    state.tab = tabPart;
  }
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    const f = params.get('filter');
    if (['open', 'task', 'event', 'note', 'done'].includes(f)) state.inboxFilter = f;
    const s = params.get('status');
    if (['unread', 'digested', 'all'].includes(s)) state.rlFilter = s;
  }
}

function renderTabs() {
  for (const tabEl of document.querySelectorAll('.tab')) {
    const active = tabEl.dataset.tab === state.tab;
    if (active) tabEl.setAttribute('aria-current', 'page');
    else tabEl.removeAttribute('aria-current');
  }
  for (const panelEl of document.querySelectorAll('.panel')) {
    panelEl.hidden = panelEl.dataset.panel !== state.tab;
  }
  el('count-inbox').textContent = String(state.inbox.filter((it) => !it.done).length);
  el('count-readlater').textContent = String(state.readLater.filter((it) => it.status === 'unread').length);
}

function renderStatus() {
  const modeEl = el('mode-status');
  const footEl = el('channel-summary');
  const runBtn = el('run-briefing-btn');
  const deliverBtn = el('deliver-briefing-btn');

  if (state.mode === 'local') {
    modeEl.textContent = 'Local workspace';
    runBtn.disabled = false;
    deliverBtn.disabled = false;
    if (state.channels) {
      const active = [];
      if (state.channels.gmailConfigured) active.push('Gmail ready');
      if (state.channels.discordConfigured) active.push('Discord ready');
      if (state.channels.geminiConfigured) active.push('Gemini summaries on');
      footEl.textContent = active.length > 0 ? active.join(', ') : 'No delivery secrets set in .env yet';
    }
  } else if (state.mode === 'github') {
    modeEl.textContent = `Synced to ${state.sync.repo}`;
    runBtn.disabled = true;
    deliverBtn.disabled = true;
    runBtn.title = 'Briefings run automatically via GitHub Actions on this host.';
    deliverBtn.title = 'Briefings deliver automatically via GitHub Actions on this host.';
    footEl.textContent = 'GitHub Actions delivers Gmail and Discord briefings on schedule';
  } else {
    modeEl.textContent = 'Browser storage';
    runBtn.disabled = true;
    deliverBtn.disabled = true;
    runBtn.title = 'Run npm run dev locally or connect GitHub Sync to refresh.';
    deliverBtn.title = 'Connect GitHub Sync or run npm run brief locally.';
    footEl.textContent = 'Connect Sync settings to commit captures to GitHub from your phone';
  }
}

function renderBriefing() {
  el('briefing-error').hidden = true;
  const b = state.briefing;
  if (!b || !b.generatedAt) {
    el('briefing-empty').hidden = false;
    el('briefing-content').hidden = true;
    el('briefing-meta').textContent = 'No briefing snapshot yet.';
    return;
  }

  el('briefing-empty').hidden = true;
  el('briefing-content').hidden = false;
  el('briefing-meta').textContent = `Prepared for ${b.dateLabel || 'today'}`;

  if (b.weather) {
    el('weather-strip').hidden = false;
    el('weather-city').textContent = b.weather.city;
    el('weather-temp').textContent = `${b.weather.currentTemp}${b.weather.unit}`;
    el('weather-cond').textContent = b.weather.condition;
    el('weather-high').textContent = `${b.weather.high}${b.weather.unit}`;
    el('weather-low').textContent = `${b.weather.low}${b.weather.unit}`;
    el('weather-rain').textContent = `${b.weather.rainChance}%`;
  } else {
    el('weather-strip').hidden = true;
  }

  // Schedule + due items
  const agendaRows = [
    ...(b.schedule || []).map((ev) => ({
      when: formatShortTime(ev.startAt, ev.allDay),
      title: ev.title,
      kind: ev.location || 'Calendar',
    })),
    ...(b.dueSoon || []).map((it) => ({
      when: formatShortTime(it.dueAt, false),
      title: it.title,
      kind: it.kind,
    })),
  ];

  const tbody = el('agenda-tbody');
  tbody.textContent = '';
  if (agendaRows.length === 0) {
    el('agenda-table').hidden = true;
    el('agenda-empty').hidden = false;
  } else {
    el('agenda-table').hidden = false;
    el('agenda-empty').hidden = true;
    for (const row of agendaRows) {
      const tr = document.createElement('tr');
      const tdWhen = document.createElement('td');
      tdWhen.className = 'cell-when';
      tdWhen.dataset.label = 'When';
      tdWhen.textContent = row.when;
      const tdTitle = document.createElement('td');
      tdTitle.className = 'cell-title';
      tdTitle.dataset.label = 'Item';
      tdTitle.textContent = row.title;
      const tdKind = document.createElement('td');
      tdKind.dataset.label = 'Type';
      tdKind.textContent = row.kind;
      tr.append(tdWhen, tdTitle, tdKind);
      tbody.append(tr);
    }
  }

  // News sections
  const newsWrap = el('news-groups');
  newsWrap.textContent = '';
  const nonEmptyNews = (b.news || []).filter((s) => s.items && s.items.length > 0);
  if (nonEmptyNews.length === 0) {
    el('news-empty').hidden = false;
  } else {
    el('news-empty').hidden = true;
    for (const group of nonEmptyNews) {
      const box = document.createElement('div');
      box.className = 'news-group';
      const head = document.createElement('p');
      head.className = 'news-group__name';
      head.textContent = group.topic;
      const ul = document.createElement('ul');
      ul.className = 'news-list';
      for (const item of group.items) {
        const li = document.createElement('li');
        li.className = 'news-item';
        const a = document.createElement('a');
        a.className = 'news-item__link';
        a.href = item.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = item.title;
        const src = document.createElement('span');
        src.className = 'news-item__source';
        src.textContent = item.source;
        li.append(a, src);
        ul.append(li);
      }
      box.append(head, ul);
      newsWrap.append(box);
    }
  }

  // Read-later digest in briefing
  const rlWrap = el('briefing-readlater');
  rlWrap.textContent = '';
  const rlItems = b.readLater || [];
  if (rlItems.length === 0) {
    el('briefing-readlater-empty').hidden = false;
  } else {
    el('briefing-readlater-empty').hidden = true;
    for (const item of rlItems) {
      rlWrap.append(buildDigestNode(item, false));
    }
  }
}

function buildDigestNode(item, withActions = true) {
  const card = document.createElement('article');
  card.className = 'digest-item';

  const head = document.createElement('div');
  head.className = 'digest-item__head';
  const link = document.createElement('a');
  link.className = 'digest-item__title';
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = item.title || item.url;
  head.append(link);

  const meta = document.createElement('p');
  meta.className = 'digest-item__meta';
  const parts = [item.source || 'Web'];
  if (item.readingMinutes) parts.push(`${item.readingMinutes}\u00a0min read`);
  if (item.status === 'digested') parts.push('digested');
  meta.textContent = parts.join(', ');

  card.append(head, meta);

  if (item.bullets && item.bullets.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'digest-item__bullets';
    for (const b of item.bullets) {
      const li = document.createElement('li');
      li.textContent = b;
      ul.append(li);
    }
    card.append(ul);
  }

  if (withActions) {
    const actions = document.createElement('div');
    actions.className = 'digest-item__actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'row-action';
    toggleBtn.textContent = item.status === 'unread' ? 'Mark digested' : 'Move to unread';
    toggleBtn.addEventListener('click', () => toggleReadLaterStatus(item));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'row-action';
    delBtn.textContent = 'Remove';
    delBtn.addEventListener('click', () => removeReadLater(item));

    actions.append(toggleBtn, delBtn);
    card.append(actions);
  }

  return card;
}

function renderInbox() {
  el('inbox-error').hidden = true;
  for (const btn of document.querySelectorAll('[data-inbox-filter]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.inboxFilter === state.inboxFilter));
  }

  const filtered = state.inbox.filter((it) => {
    if (state.inboxFilter === 'done') return it.done;
    if (state.inboxFilter === 'open') return !it.done;
    return !it.done && it.kind === state.inboxFilter;
  });

  if (filtered.length === 0) {
    el('inbox-empty').hidden = false;
    el('inbox-table-wrap').hidden = true;
    return;
  }

  el('inbox-empty').hidden = true;
  el('inbox-table-wrap').hidden = false;
  const tbody = el('inbox-tbody');
  tbody.textContent = '';

  for (const item of filtered) {
    const tr = document.createElement('tr');

    const tdCheck = document.createElement('td');
    const wrap = document.createElement('label');
    wrap.className = 'check-wrap';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'check-input';
    cb.checked = Boolean(item.done);
    cb.setAttribute('aria-label', `Mark "${item.title}" complete`);
    cb.addEventListener('change', () => toggleInboxDone(item));
    wrap.append(cb);
    tdCheck.append(wrap);

    const tdTitle = document.createElement('td');
    tdTitle.className = item.done ? 'cell-title cell-title--done' : 'cell-title';
    tdTitle.textContent = item.title;
    if ((item.tags && item.tags.length > 0) || item.priority === 'high') {
      const tagsDiv = document.createElement('div');
      tagsDiv.className = 'cell-tags';
      if (item.priority === 'high') {
        const p = document.createElement('span');
        p.className = 'tag tag--high';
        p.textContent = 'High priority';
        tagsDiv.append(p);
      }
      for (const t of item.tags || []) {
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = `#${t}`;
        tagsDiv.append(span);
      }
      tdTitle.append(tagsDiv);
    }

    const tdKind = document.createElement('td');
    tdKind.dataset.label = 'Category';
    tdKind.textContent = item.kind;

    const tdDue = document.createElement('td');
    tdDue.className = 'cell-when';
    tdDue.dataset.label = 'Due';
    tdDue.textContent = item.dueAt ? formatShortTime(item.dueAt, false) : 'Unscheduled';

    const tdAct = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'row-action';
    delBtn.textContent = 'Remove';
    delBtn.addEventListener('click', () => removeInboxItem(item));
    tdAct.append(delBtn);

    tr.append(tdCheck, tdTitle, tdKind, tdDue, tdAct);
    tbody.append(tr);
  }
}

function renderReadLater() {
  el('readlater-error').hidden = true;
  for (const btn of document.querySelectorAll('[data-rl-filter]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.rlFilter === state.rlFilter));
  }

  const filtered = state.readLater.filter((it) => {
    if (state.rlFilter === 'all') return true;
    return it.status === state.rlFilter;
  });

  const list = el('readlater-list');
  list.textContent = '';
  if (filtered.length === 0) {
    el('readlater-empty').hidden = false;
    list.hidden = true;
    return;
  }

  el('readlater-empty').hidden = true;
  list.hidden = false;
  for (const item of filtered) {
    list.append(buildDigestNode(item, true));
  }
}

function renderAll() {
  el('today-date').textContent = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).format(new Date());
  renderTabs();
  renderStatus();
  renderBriefing();
  renderInbox();
  renderReadLater();
}

function setCaptureHelper(msg, isError = false) {
  const helper = el('capture-helper');
  const input = el('capture-input');
  helper.textContent = msg;
  helper.classList.toggle('field-helper--error', isError);
  input.setAttribute('aria-invalid', isError ? 'true' : 'false');
}

function scheduleUndo(label, restoreFn) {
  clearTimeout(state.undoTimer);
  state.pendingUndo = restoreFn;
  el('undo-text').textContent = label;
  el('undo-bar').hidden = false;
  state.undoTimer = setTimeout(() => {
    state.pendingUndo = null;
    el('undo-bar').hidden = true;
  }, 8000);
}

async function persistGitHubList(type, commitMessage) {
  if (state.mode !== 'github') return;
  const path = type === 'inbox' ? 'data/inbox.json' : 'data/readlater.json';
  const items = type === 'inbox' ? state.inbox : state.readLater;
  await ghWriteJson(path, { version: 1, items }, commitMessage);
}

async function handleCaptureSubmit(event) {
  event.preventDefault();
  const input = el('capture-input');
  const submitBtn = el('capture-submit');
  const raw = input.value.trim();

  if (!raw) {
    setCaptureHelper('Enter a task, event, note or URL before capturing.', true);
    input.focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';
  setCaptureHelper('Sorting capture…', false);

  try {
    if (state.mode === 'local') {
      const res = await fetch('/api/dump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: raw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save capture.');
      if (data.route === 'readlater') {
        state.readLater = [data.item, ...state.readLater.filter((x) => x.id !== data.item.id)];
        state.tab = 'readlater';
        setCaptureHelper('Saved to Read later with three-bullet summary.', false);
      } else {
        state.inbox = [data.item, ...state.inbox];
        state.tab = 'inbox';
        setCaptureHelper(`Added as ${data.item.kind}${data.item.dueAt ? ` (${formatShortTime(data.item.dueAt)})` : ''}.`, false);
      }
    } else {
      const parsed = parseClientCapture(raw);
      if (parsed.route === 'readlater') {
        state.readLater = [parsed.item, ...state.readLater];
        saveOfflineMirror();
        await persistGitHubList('readlater', `Save read-later link: ${parsed.item.title.slice(0, 50)}`);
        state.tab = 'readlater';
        setCaptureHelper(
          state.mode === 'github'
            ? 'Committed to GitHub Read later queue.'
            : 'Saved locally to Read later. Connect Sync settings to sync with GitHub.',
          false
        );
      } else {
        state.inbox = [parsed.item, ...state.inbox];
        saveOfflineMirror();
        await persistGitHubList('inbox', `Capture ${parsed.item.kind}: ${parsed.item.title.slice(0, 50)}`);
        state.tab = 'inbox';
        setCaptureHelper(
          state.mode === 'github'
            ? `Committed ${parsed.item.kind} to GitHub.`
            : `Saved ${parsed.item.kind} in this browser.`,
          false
        );
      }
    }

    input.value = '';
    updateUrlState();
    renderAll();
  } catch (err) {
    setCaptureHelper(err.message || 'Capture failed. Try again.', true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Capture';
  }
}

async function toggleInboxDone(item) {
  const nextDone = !item.done;
  item.done = nextDone;
  item.completedAt = nextDone ? new Date().toISOString() : null;
  renderAll();
  try {
    if (state.mode === 'local') {
      await fetch(`/api/inbox/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done: nextDone }),
      });
    } else {
      saveOfflineMirror();
      await persistGitHubList('inbox', `Update inbox item: ${item.title.slice(0, 48)}`);
    }
  } catch (err) {
    item.done = !nextDone;
    renderAll();
    setCaptureHelper(err.message || 'Could not update item.', true);
  }
}

async function removeInboxItem(item) {
  const prev = [...state.inbox];
  state.inbox = state.inbox.filter((x) => x.id !== item.id);
  renderAll();

  scheduleUndo(`Removed "${item.title}".`, async () => {
    state.inbox = prev;
    renderAll();
    if (state.mode === 'local') {
      await fetch('/api/dump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: item.raw || item.title, kind: item.kind }),
      });
      await loadState();
    } else {
      saveOfflineMirror();
      await persistGitHubList('inbox', `Restore inbox item: ${item.title.slice(0, 48)}`);
    }
  });

  try {
    if (state.mode === 'local') {
      await fetch(`/api/inbox/${item.id}`, { method: 'DELETE' });
    } else {
      saveOfflineMirror();
      await persistGitHubList('inbox', `Remove inbox item: ${item.title.slice(0, 48)}`);
    }
  } catch (err) {
    state.inbox = prev;
    renderAll();
    setCaptureHelper(err.message || 'Could not remove item.', true);
  }
}

async function toggleReadLaterStatus(item) {
  const nextStatus = item.status === 'unread' ? 'digested' : 'unread';
  item.status = nextStatus;
  renderAll();
  try {
    if (state.mode === 'local') {
      await fetch(`/api/readlater/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
    } else {
      saveOfflineMirror();
      await persistGitHubList('readlater', `Mark link ${nextStatus}: ${item.title.slice(0, 45)}`);
    }
  } catch (err) {
    item.status = nextStatus === 'unread' ? 'digested' : 'unread';
    renderAll();
    setCaptureHelper(err.message || 'Could not update link.', true);
  }
}

async function removeReadLater(item) {
  const prev = [...state.readLater];
  state.readLater = state.readLater.filter((x) => x.id !== item.id);
  renderAll();

  scheduleUndo(`Removed "${item.title}".`, async () => {
    state.readLater = prev;
    renderAll();
    if (state.mode === 'local') {
      await fetch('/api/readlater', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url, note: item.note }),
      });
      await loadState();
    } else {
      saveOfflineMirror();
      await persistGitHubList('readlater', `Restore link: ${item.title.slice(0, 45)}`);
    }
  });

  try {
    if (state.mode === 'local') {
      await fetch(`/api/readlater/${item.id}`, { method: 'DELETE' });
    } else {
      saveOfflineMirror();
      await persistGitHubList('readlater', `Remove link: ${item.title.slice(0, 45)}`);
    }
  } catch (err) {
    state.readLater = prev;
    renderAll();
    setCaptureHelper(err.message || 'Could not remove link.', true);
  }
}

async function triggerBriefing(deliver = false) {
  if (state.mode !== 'local') return;
  const btn = deliver ? el('deliver-briefing-btn') : el('run-briefing-btn');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = deliver ? 'Sending…' : 'Refreshing…';

  try {
    const res = await fetch('/api/briefing/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliver }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Briefing failed.');
    state.briefing = data.briefing;
    if (deliver) {
      const g = data.delivery?.gmail?.status || 'skipped';
      const d = data.delivery?.discord?.status || 'skipped';
      setCaptureHelper(`Delivery complete: Gmail ${g}, Discord ${d}.`, false);
    } else {
      setCaptureHelper('Morning briefing refreshed.', false);
    }
    renderAll();
  } catch (err) {
    showErrorState('briefing', 'Briefing refresh failed.', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function wireEvents() {
  for (const tabEl of document.querySelectorAll('.tab')) {
    tabEl.addEventListener('click', (e) => {
      e.preventDefault();
      state.tab = tabEl.dataset.tab;
      updateUrlState();
      renderTabs();
    });
  }

  for (const btn of document.querySelectorAll('[data-inbox-filter]')) {
    btn.addEventListener('click', () => {
      state.inboxFilter = btn.dataset.inboxFilter;
      updateUrlState();
      renderInbox();
    });
  }

  for (const btn of document.querySelectorAll('[data-rl-filter]')) {
    btn.addEventListener('click', () => {
      state.rlFilter = btn.dataset.rlFilter;
      updateUrlState();
      renderReadLater();
    });
  }

  el('capture-form').addEventListener('submit', handleCaptureSubmit);
  el('capture-input').addEventListener('input', () => {
    if (el('capture-input').getAttribute('aria-invalid') === 'true') {
      setCaptureHelper('Dates like “tomorrow 9am” set reminders; pasted URLs move to Read later.', false);
    }
  });

  el('undo-btn').addEventListener('click', async () => {
    clearTimeout(state.undoTimer);
    el('undo-bar').hidden = true;
    const fn = state.pendingUndo;
    state.pendingUndo = null;
    if (fn) await fn();
  });

  el('run-briefing-btn').addEventListener('click', () => triggerBriefing(false));
  el('briefing-empty-btn').addEventListener('click', () => triggerBriefing(false));
  el('deliver-briefing-btn').addEventListener('click', () => triggerBriefing(true));
  el('briefing-retry-btn').addEventListener('click', loadState);
  el('inbox-retry-btn').addEventListener('click', loadState);
  el('readlater-retry-btn').addEventListener('click', loadState);

  el('inbox-focus-btn').addEventListener('click', () => el('capture-input').focus());
  el('readlater-focus-btn').addEventListener('click', () => el('capture-input').focus());

  // Sync settings dialog
  const dialog = el('sync-dialog');
  el('open-sync-btn').addEventListener('click', () => {
    el('gh-repo').value = state.sync.repo;
    el('gh-branch').value = state.sync.branch || 'main';
    el('gh-token').value = state.sync.token;
    dialog.showModal();
  });
  el('close-sync-btn').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  el('clear-sync-btn').addEventListener('click', () => {
    saveSyncConfig({ repo: el('gh-repo').value.trim(), branch: 'main', token: '' });
    dialog.close();
    loadState();
  });
  el('sync-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveSyncConfig({
      repo: el('gh-repo').value.trim(),
      branch: el('gh-branch').value.trim() || 'main',
      token: el('gh-token').value.trim(),
    });
    dialog.close();
    loadState();
  });

  window.addEventListener('hashchange', () => {
    readUrlState();
    renderTabs();
    renderInbox();
    renderReadLater();
  });
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

readUrlState();
wireEvents();
loadState();
