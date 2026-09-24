import express from 'express';

const router = express.Router();

/**
 * Bitcoin/crypto news, merged from public RSS feeds.
 *
 * Server-side rather than in the app because: the app would otherwise need an
 * XML parser and four network calls on every open, thousands of devices hitting
 * publisher feeds directly is what gets an app blocked, and sources can be
 * changed here without shipping a release.
 *
 * Only the feed's own title and summary are stored and served. The full article
 * is the publisher's copyrighted work; RSS summaries are what feeds exist to
 * syndicate, and every item carries its source name for attribution.
 */
const FEEDS = [
  { source: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { source: 'Decrypt', url: 'https://decrypt.co/feed' },
  { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { source: 'Bitcoin.com', url: 'https://news.bitcoin.com/feed/' },
];

/** Feeds are fetched at most this often; every request in between is served from memory. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ITEMS = 200;

let cache = { items: [], fetchedAt: 0, inFlight: null };

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&apos;': "'", '&#39;': "'", '&nbsp;': ' ', '&#8217;': '’',
  '&#8216;': '‘', '&#8220;': '“', '&#8221;': '”', '&#8230;': '…',
};

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&[a-zA-Z#0-9]+;/g, match => ENTITIES[match] ?? match);
}

/** Feed summaries routinely contain markup; the app renders plain text. */
function stripHtml(text) {
  return decodeEntities(
    String(text ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function unwrap(value) {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value ?? '');
  return cdata ? cdata[1] : (value ?? '');
}

function tagContent(itemXml, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(itemXml);
  return match ? unwrap(match[1]) : '';
}

/**
 * Minimal RSS item reader. Deliberately dependency-free: adding a parser to the
 * backend would make every deploy require an npm install on the server, and an
 * <item> block is a shape simple enough to read directly.
 */
export function parseFeed(xml, source) {
  const items = [];
  const blocks = String(xml ?? '').split(/<item(?:\s[^>]*)?>/i).slice(1);

  for (const block of blocks) {
    const body = block.split(/<\/item>/i)[0];
    const title = stripHtml(tagContent(body, 'title'));
    if (!title) continue;

    const summary = stripHtml(tagContent(body, 'description'));
    const published = tagContent(body, 'pubDate').trim();
    const publishedAt = published ? new Date(published) : null;

    items.push({
      // Stable across refetches, so the app can key a list without duplicates.
      id: `${source}:${title}`.slice(0, 200),
      title,
      summary,
      source,
      publishedAt: publishedAt && !isNaN(publishedAt.getTime())
        ? publishedAt.toISOString()
        : null,
    });
  }
  return items;
}

async function fetchFeed({ source, url }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow', // CoinDesk answers 308 before serving the feed
      headers: {
        // Some publishers front their feed with Cloudflare and refuse
        // requests with no user agent.
        'User-Agent': 'Mozilla/5.0 (compatible; BitPlayNews/1.0)',
        Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseFeed(await res.text(), source);
  } catch (err) {
    // One dead feed must never empty the page.
    console.warn(`[News] ${source} failed: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function loadAll() {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const merged = results.flat();

  const seen = new Set();
  return merged
    .filter(item => (seen.has(item.id) ? false : seen.add(item.id)))
    .sort((a, b) => new Date(b.publishedAt ?? 0) - new Date(a.publishedAt ?? 0))
    .slice(0, MAX_ITEMS);
}

async function getItems() {
  const fresh = Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (fresh && cache.items.length > 0) return cache.items;

  // Single-flight: a burst of requests on a cold cache must not fan out into a
  // burst of requests at the publishers.
  if (!cache.inFlight) {
    cache.inFlight = loadAll()
      .then(items => {
        if (items.length > 0) cache = { items, fetchedAt: Date.now(), inFlight: null };
        else cache.inFlight = null;
        return items;
      })
      .catch(err => {
        cache.inFlight = null;
        throw err;
      });
  }

  try {
    const items = await cache.inFlight;
    // Every feed failed: keep serving the last good copy rather than a blank page.
    return items.length > 0 ? items : cache.items;
  } catch {
    return cache.items;
  }
}

// GET /api/news?limit=10&offset=0
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const items = await getItems();
    const page = items.slice(offset, offset + limit);

    res.status(200).json({
      success: true,
      total: items.length,
      offset,
      limit,
      hasMore: offset + page.length < items.length,
      news: page,
    });
  } catch (err) {
    console.error('[News] Error serving news:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

export default router;
