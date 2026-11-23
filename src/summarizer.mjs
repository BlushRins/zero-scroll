import { decodeXmlEntities } from './news.mjs';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'are', 'was', 'were', 'been',
  'being', 'will', 'would', 'could', 'should', 'into', 'about', 'their', 'there', 'which',
  'when', 'where', 'while', 'what', 'your', 'more', 'most', 'some', 'such', 'than', 'then',
  'them', 'they', 'also', 'just', 'only', 'over', 'after', 'before', 'between', 'through',
  'because', 'very', 'much', 'many', 'make', 'made', 'like', 'other', 'each', 'those', 'these',
  'here', 'does', 'doing', 'done', 'said', 'says', 'using', 'used', 'can', 'not', 'but', 'you',
  'our', 'out', 'all', 'its', 'has', 'had', 'his', 'her', 'she', 'who', 'why', 'how',
]);

export function isYouTubeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
  } catch {
    return false;
  }
}

export function extractArticleFromHtml(html, fallbackUrl = '') {
  const source = String(html || '');
  const ogTitle =
    source.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] ||
    source.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i)?.[1];
  const titleTag = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const metaDesc =
    source.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] ||
    source.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i)?.[1] ||
    source.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] ||
    '';

  const title = decodeXmlEntities(ogTitle || titleTag || fallbackUrl);
  const description = decodeXmlEntities(metaDesc);

  // Strip non-content tags
  let body = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(?:nav|footer|aside|header|form)[\s\S]*?<\/(?:nav|footer|aside|header|form)>/gi, ' ');

  const articleMatch = body.match(/<article[\s\S]*?<\/article>/i) || body.match(/<main[\s\S]*?<\/main>/i);
  if (articleMatch) {
    body = articleMatch[0];
  }

  const paragraphs = [];
  const pMatches = body.match(/<p(?:\s[^>]*)?>[\s\S]*?<\/p>/gi) || [];
  for (const p of pMatches) {
    const clean = decodeXmlEntities(p);
    if (clean.length >= 45) paragraphs.push(clean);
  }

  const text = paragraphs.length > 0 ? paragraphs.join('\n\n') : decodeXmlEntities(body);
  const words = text.split(/\s+/).filter(Boolean).length;
  const readingMinutes = Math.max(1, Math.round(words / 220));

  return {
    title: title || fallbackUrl,
    description,
    text: text.slice(0, 12_000),
    words,
    readingMinutes,
  };
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

export function extractiveBullets(text, title = '', maxBullets = 3) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  const sentences = cleaned
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 280);

  if (sentences.length <= maxBullets) {
    return sentences.map((s) => (s.length > 220 ? `${s.slice(0, 217).trim()}…` : s));
  }

  const freqs = new Map();
  for (const w of tokenize(cleaned)) {
    freqs.set(w, (freqs.get(w) || 0) + 1);
  }
  const titleWords = new Set(tokenize(title));

  const scored = sentences.map((sentence, idx) => {
    const words = tokenize(sentence);
    if (words.length === 0) return { idx, sentence, score: 0 };
    let score = 0;
    const seen = new Set();
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      score += freqs.get(w) || 0;
      if (titleWords.has(w)) score += 3;
    }
    score /= Math.sqrt(words.length);
    if (idx < 3) score *= 1.2;
    return { idx, sentence, score, words: seen };
  });

  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const cand of scored) {
    const tooSimilar = picked.some((p) => {
      let overlap = 0;
      for (const w of cand.words) if (p.words.has(w)) overlap++;
      const denom = Math.max(1, Math.min(cand.words.size, p.words.size));
      return overlap / denom > 0.6;
    });
    if (!tooSimilar) picked.push(cand);
    if (picked.length >= maxBullets) break;
  }

  picked.sort((a, b) => a.idx - b.idx);
  return picked.map((p) => (p.sentence.length > 220 ? `${p.sentence.slice(0, 217).trim()}…` : p.sentence));
}

async function summarizeWithGemini(title, text, apiKey, fetchImpl) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = [
    'Summarize this saved link in exactly 3 short, concrete bullet points.',
    'Rules: no intro text, no markdown bold, max 24 words per bullet, start each line with "- ".',
    `Title: ${title}`,
    `Content: ${text.slice(0, 5000)}`,
  ].join('\n');

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const bullets = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((line) => line.length >= 12)
    .slice(0, 3);
  return bullets.length > 0 ? bullets : null;
}

export async function summarizeUrl(rawUrl, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const geminiApiKey = options.geminiApiKey || '';
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (!/^https?:$/i.test(parsedUrl.protocol)) {
    throw new Error('Only http and https URLs are supported.');
  }

  const host = parsedUrl.hostname.replace(/^www\./, '');

  if (isYouTubeUrl(rawUrl)) {
    let title = rawUrl;
    let author = 'YouTube';
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`;
      const res = await fetchImpl(oembedUrl, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const meta = await res.json();
        title = meta.title || title;
        author = meta.author_name || author;
      }
    } catch {
      // keep fallback title
    }

    let description = '';
    try {
      const pageRes = await fetchImpl(rawUrl, {
        headers: { 'User-Agent': 'ZeroScroll/1.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        description = extractArticleFromHtml(html, rawUrl).description;
      }
    } catch {
      // optional description
    }

    const sourceText = [title, description].filter(Boolean).join('. ');
    let bullets = null;
    if (geminiApiKey && sourceText.length > 40) {
      try {
        bullets = await summarizeWithGemini(title, sourceText, geminiApiKey, fetchImpl);
      } catch {
        bullets = null;
      }
    }
    if (!bullets) {
      bullets = extractiveBullets(description, title, 2);
      if (bullets.length === 0) {
        bullets = [`Video by ${author} saved to watch when you have time.`];
      } else {
        bullets.unshift(`Video by ${author}.`);
      }
    }

    return {
      url: rawUrl,
      title,
      source: author,
      kind: 'video',
      readingMinutes: null,
      bullets: bullets.slice(0, 3),
      summarizedBy: geminiApiKey ? 'gemini' : 'extractive',
    };
  }

  const res = await fetchImpl(rawUrl, {
    headers: {
      'User-Agent': 'ZeroScroll/1.0 (+https://github.com/BlushRins/zero-scroll)',
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`Could not fetch link (HTTP ${res.status})`);
  }
  const html = await res.text();
  const article = extractArticleFromHtml(html, rawUrl);

  let bullets = null;
  if (geminiApiKey && article.text.length > 100) {
    try {
      bullets = await summarizeWithGemini(article.title, article.text, geminiApiKey, fetchImpl);
    } catch {
      bullets = null;
    }
  }

  if (!bullets) {
    bullets = extractiveBullets(article.text || article.description, article.title, 3);
    if (bullets.length === 0 && article.description) {
      bullets = [article.description];
    }
    if (bullets.length === 0) {
      bullets = [`Saved article from ${host} (${article.readingMinutes} min read).`];
    }
  }

  return {
    url: rawUrl,
    title: article.title,
    source: host,
    kind: 'article',
    readingMinutes: article.readingMinutes,
    bullets: bullets.slice(0, 3),
    summarizedBy: geminiApiKey && bullets ? 'gemini' : 'extractive',
  };
}
