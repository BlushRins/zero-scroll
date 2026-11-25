export function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTag(block, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1]) : '';
}

function getAtomLink(block) {
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/i);
  if (alt) return alt[1].trim();
  const any = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
  return any ? any[1].trim() : '';
}

export function parseFeedXml(xmlText, defaultSource = '') {
  const xml = String(xmlText || '');
  const items = [];

  // RSS 2.0 <item>
  const rssMatches = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  for (const block of rssMatches) {
    let title = getTag(block, 'title');
    const url = getTag(block, 'link');
    let source = getTag(block, 'source') || defaultSource;
    const pubDate = getTag(block, 'pubDate') || getTag(block, 'dc:date');

    // Google News appends " - Publisher" to titles
    if (!source && title.includes(' - ')) {
      const idx = title.lastIndexOf(' - ');
      source = title.slice(idx + 3).trim();
      title = title.slice(0, idx).trim();
    } else if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(` - ${source}`).length).trim();
    }

    if (title && url) {
      const parsedDate = pubDate ? new Date(pubDate) : null;
      items.push({
        title,
        url,
        source: source || 'News',
        publishedAt:
          parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
      });
    }
  }

  if (items.length > 0) return items;

  // Atom <entry>
  const atomMatches = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  for (const block of atomMatches) {
    const title = getTag(block, 'title');
    const url = getAtomLink(block) || getTag(block, 'id');
    const updated = getTag(block, 'published') || getTag(block, 'updated');
    const author = getTag(block, 'name') || defaultSource || 'Feed';
    if (title && url) {
      const parsedDate = updated ? new Date(updated) : null;
      items.push({
        title,
        url,
        source: author,
        publishedAt:
          parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
      });
    }
  }

  return items;
}

export function normalizeUrlKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|oc|ref$)/i.test(k)) u.searchParams.delete(k);
    }
    return `${u.origin}${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return String(rawUrl || '').trim().toLowerCase();
  }
}

export function buildGoogleNewsUrl(query) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en&gl=US&ceid=US:en`;
}

export function pruneSeenUrls(seenStore, maxAgeDays = 30, now = new Date()) {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const next = {};
  for (const [k, ts] of Object.entries(seenStore?.urls || {})) {
    const ms = new Date(ts).getTime();
    if (!Number.isNaN(ms) && ms >= cutoff) {
      next[k] = ts;
    }
  }
  return { version: 1, urls: next };
}

function matchesTrustedSource(sourceName, trustedSources) {
  if (!Array.isArray(trustedSources) || trustedSources.length === 0) return true;
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/^www\./, '');
  const norm = normalize(sourceName);
  return Boolean(norm) && trustedSources.some((trusted) => normalize(trusted) === norm);
}

function compileExcludes(patterns) {
  if (!Array.isArray(patterns)) return [];
  return patterns.flatMap((pattern) => {
    if (typeof pattern !== 'string') return [];
    try {
      return [new RegExp(pattern, 'i')];
    } catch {
      return [];
    }
  });
}

function matchesExcludePatterns(title, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some((re) => re.test(title));
}

function isFreshEnough(publishedAt, maxAgeDays, now) {
  if (!publishedAt || !maxAgeDays || maxAgeDays <= 0) return true;
  const ms = new Date(publishedAt).getTime();
  if (Number.isNaN(ms)) return true;
  return now.getTime() - ms <= maxAgeDays * 86_400_000;
}

export async function fetchNewsDigest(newsConfig, seenStore, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now instanceof Date ? options.now : new Date();
  const maxPerTopicDefault = options.maxNewsPerTopic ?? 4;
  const defaultMaxAgeDays = newsConfig?.maxAgeDays ?? 7;
  const globalExcludes = compileExcludes(newsConfig?.excludePatterns);

  const pruned = pruneSeenUrls(seenStore, 30, now);
  const seenUrls = { ...pruned.urls };
  const batchKeys = new Set();
  const sections = [];
  const errors = [];

  const sources = [
    ...(newsConfig?.topics || []).map((t) => ({
      name: t.name,
      url: buildGoogleNewsUrl(t.query || t.name),
      maxItems: t.maxItems ?? maxPerTopicDefault,
      trustedSources: t.trustedSources || null,
      maxAgeDays: t.maxAgeDays ?? defaultMaxAgeDays,
      excludePatterns: [
        ...globalExcludes,
        ...compileExcludes(t.excludePatterns),
      ],
      isDirectFeed: false,
    })),
    ...(newsConfig?.feeds || []).map((f) => ({
      name: f.name,
      url: f.url,
      maxItems: f.maxItems ?? maxPerTopicDefault,
      trustedSources: f.trustedSources || null,
      maxAgeDays: f.maxAgeDays ?? Math.max(defaultMaxAgeDays, 14),
      excludePatterns: globalExcludes,
      isDirectFeed: true,
    })),
  ];

  const isRealFetch = !options.fetch;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (isRealFetch && i > 0) {
      await new Promise((r) => setTimeout(r, 600));
    }
    try {
      const fetchOnce = () =>
        fetchImpl(src.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ZeroScroll/1.0)',
            Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          },
          signal: AbortSignal.timeout(12_000),
        });
      let res = await fetchOnce();
      if (res.status === 429 && isRealFetch) {
        await new Promise((r) => setTimeout(r, 1800));
        res = await fetchOnce();
      }
      if (!res.ok) {
        errors.push(`${src.name}: HTTP ${res.status}`);
        continue;
      }
      const xml = await res.text();
      const parsed = parseFeedXml(xml, src.name);
      const fresh = [];
      for (const item of parsed) {
        if (!isFreshEnough(item.publishedAt, src.maxAgeDays, now)) continue;
        if (!src.isDirectFeed && !matchesTrustedSource(item.source, src.trustedSources)) continue;
        if (matchesExcludePatterns(item.title, src.excludePatterns)) continue;

        const key = normalizeUrlKey(item.url);
        const titleKey = `title:${item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
        if (seenUrls[key] || batchKeys.has(key) || batchKeys.has(titleKey)) continue;
        batchKeys.add(key);
        batchKeys.add(titleKey);
        fresh.push(item);
        if (fresh.length >= src.maxItems) break;
      }
      for (const item of fresh) {
        seenUrls[normalizeUrlKey(item.url)] = now.toISOString();
      }
      sections.push({
        topic: src.name,
        items: fresh,
      });
    } catch (err) {
      errors.push(`${src.name}: ${err.message}`);
    }
  }

  return {
    sections,
    errors,
    updatedSeen: { version: 1, urls: seenUrls },
  };
}
