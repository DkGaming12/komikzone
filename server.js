/**
 * KomikZone Backend Proxy Server
 * Serves JSON API from Shinigami Scans public API (api.shngm.io)
 * Port: 3001 (frontend served from same origin / static)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Vercel's reverse proxy for correct IP detection in rate limiting
app.set('trust proxy', 1);

// Security Headers (Anti-Cloning & XSS)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.googletagmanager.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https://assets.shngm.id", "https://api.shngm.io", "https://*.shinigami.asia"],
      connectSrc: ["'self'", "https://api.shngm.io"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["'none'"],
      frameAncestors: ["'none'"], // Prevent iframe cloning
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors());
app.use(express.static(path.join(__dirname)));

/* ── Shinigami API helpers ────────────────────────────── */
const API = 'https://api.shngm.io/v1';

// Simple in-memory cache { url: { ts, json } }
const cache = new Map();
const MAX_CACHE = 200;

async function getJSON(pathAndQuery, ttl = 300_000, opts = {}) {
  const url = `${API}${pathAndQuery}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < ttl) return hit.json;

  // Global fetch (Node 18+) with a real timeout — retry once on network
  // failure by default; callers on a known-broken/slow path can shorten
  // the timeout and skip the retry via opts so a dead endpoint cannot
  // stall the whole response.
  const timeoutMs = opts.timeout ?? 15000;
  const attempts = (opts.retries ?? 1) + 1;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      if (json.retcode !== 0 || !json.data) throw new Error(json.message || 'API error');
      if (cache.size > MAX_CACHE) cache.clear();
      cache.set(url, { ts: Date.now(), json });
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt < attempts - 1) await new Promise(res => setTimeout(res, 800));
    }
  }
  throw new Error(`Gagal mengambil ${url} (${lastErr?.message || 'network error'})`);
}

/* ── Online User Tracking (SSE & Heartbeat) ──────────────────────── */
const onlineClients = new Set();
const recentHeartbeats = new Map(); // ip/key -> timestamp

// Clean up stale heartbeats older than 90 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentHeartbeats.entries()) {
    if (now - ts > 90000) recentHeartbeats.delete(key);
  }
}, 30000);

function getCalculatedOnlineCount() {
  const now = new Date();
  // WIB = UTC+7 (Indonesian Western Time)
  const wibHour = (now.getUTCHours() + 7) % 24;
  const minute = now.getUTCMinutes();
  const second = now.getUTCSeconds();

  // Baseline traffic curve per hour
  const hourlyBase = [
    38, 28, 22, 18, 20, 28, // 00 - 05 Subuh
    45, 62, 78, 88, 98, 110, // 06 - 11 Pagi / Siang
    125, 134, 122, 130, 148, 162, // 12 - 17 Sore
    182, 198, 212, 205, 168, 115  // 18 - 23 Malam (Peak)
  ];

  const base = hourlyBase[wibHour] || 50;
  // Natural micro-fluctuations (smooth sine/cosine curves based on time)
  const timeProgress = (wibHour * 3600 + minute * 60 + second);
  const variance = Math.sin(timeProgress / 20) * 4 + Math.cos(timeProgress / 48) * 3;
  const organicBase = Math.max(15, Math.round(base + variance));

  // Add real live connected clients/sessions
  const realActive = Math.max(onlineClients.size, recentHeartbeats.size);
  return organicBase + realActive;
}

function broadcastOnlineCount() {
  if (onlineClients.size === 0) return;
  const count = getCalculatedOnlineCount();
  const data = `data: ${JSON.stringify({ count })}\n\n`;
  for (const client of onlineClients) {
    try {
      client.write(data);
    } catch (e) {
      onlineClients.delete(client);
    }
  }
}

// Periodic broadcast every 8 seconds for smooth real-time updates
setInterval(broadcastOnlineCount, 8000);

// SSE stream endpoint — clients stay connected
app.get('/api/online/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',   // nginx compatibility
  });
  res.write('\n');  // flush headers

  onlineClients.add(res);

  // Send initial count immediately
  res.write(`data: ${JSON.stringify({ count: getCalculatedOnlineCount() })}\n\n`);

  // Heartbeat every 25s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    onlineClients.delete(res);
  });
});

// Ping endpoint for active sessions & polling
app.get('/api/online/ping', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'client';
  recentHeartbeats.set(ip, Date.now());
  res.json({ count: getCalculatedOnlineCount() });
});

// Direct count endpoint
app.get('/api/online/count', (req, res) => {
  res.json({ count: getCalculatedOnlineCount() });
});

/* ── field mapping (keep response shapes identical to the old scraper) ── */

const STATUS_MAP = { 1: 'Ongoing', 2: 'Completed', 3: 'Hiatus' };

// /manga/top responses carry no taxonomy — fall back to country of origin
const COUNTRY_TYPE = { JP: 'Manga', KR: 'Manhwa', CN: 'Manhua' };

function typeOf(m) {
  return (m.taxonomy?.Format || [])[0]?.name || COUNTRY_TYPE[m.country_id] || '';
}

function genresOf(m, n = 4) {
  return (m.taxonomy?.Genre || []).map(g => g.name).slice(0, n);
}

function coverOf(m) {
  // portrait crop fits 2:3 cards best; fall back to the wide banner
  return m.cover_portrait_url || m.cover_image_url || '';
}

function scoreOf(m) {
  return m.user_rate != null ? String(m.user_rate) : '';
}

/** Indonesian short relative time, e.g. "3 jam" / "5 mnt" / "8 Sep" (fits card chips) */
function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t)) return '';
  const diff = Date.now() - t.getTime();
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  if (diff < MIN) return 'baru saja';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} mnt`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} jam`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} hr`;
  return t.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

/** Map a Shinigami manga object to the card shape the frontend expects */
function mapItem(m) {
  return {
    title: m.title,
    slug: m.manga_id,
    img: coverOf(m),
    score: scoreOf(m),
    type: typeOf(m),
    status: STATUS_MAP[m.status] || '',
    latestChapter: m.latest_chapter_number != null ? `Ch. ${m.latest_chapter_number}` : ''
  };
}

/** Map a chapter-list entry: { title, slug, date } (newest-first preserved) */
function mapChapter(c) {
  return {
    title: `Chapter ${c.chapter_number}`,
    slug: c.chapter_id,
    date: relTime(c.release_date || c.created_at)
  };
}

/** Chapter list of a manga.
    Since Shinigami's Nov 2026 migration their chapter endpoints fail in
    patches, so combine every source that works and union the results:
      1. the single-shot list (page_size=500) — the healthy-upstream path;
      2. paged list @24 desc, pages 1–3 — page 1 usually answers even now
         (likely edge-cached upstream) while other sizes/pages 502; its
         rows double as resume anchors for the walk;
      3. the prev_chapter_id walk from the latest chapter.
    Individual chapter records also 502 in clusters: a broken record used
    to kill the whole list (the walk died at the chain head when the
    LATEST chapter was the broken one — "Tidak Ada Chapter" even though
    90+ chapters were fine). Now, when a walk breaks at a dead record it
    resumes from the next anchor below the break (a list row), so one
    dead record hides only itself. Walks are time-boxed and resumable
    via chapterWalkCache. All list attempts use a short timeout and no
    retry so a dead variant cannot stall callers (the reader especially).
    Remove once /chapter/:id/list works reliably again. */
const chapterWalkCache = new Map(); // mangaId -> { map: Map<slug,{n,e}>, complete, dead: Map<slug,ts> }

function walkSnapshot(mangaId) {
  const entry = chapterWalkCache.get(mangaId);
  if (!entry) return [];
  return [...entry.map.values()]
    .sort((a, b) => (b.n ?? 0) - (a.n ?? 0))
    .map(x => x.e);
}

async function fetchChapters(mangaId, walkBudgetMs = 8000) {
  const full = await getJSON(
    `/chapter/${mangaId}/list?page=1&page_size=500&sort_by=chapter_number&sort_order=desc`,
    300_000, { timeout: 6000, retries: 0 }
  ).catch(() => null);
  if (full?.data?.length) return full.data.map(mapChapter);

  const seedPages = await Promise.all([1, 2, 3].map(p =>
    getJSON(
      `/chapter/${mangaId}/list?page=${p}&page_size=24&sort_by=chapter_number&sort_order=desc`,
      300_000, { timeout: 6000, retries: 0 }
    ).catch(() => null)
  ));
  const seeds = seedPages.flatMap(r => r?.data || []);
  return fetchChaptersWalk(mangaId, walkBudgetMs, seeds);
}

async function fetchChaptersWalk(mangaId, budgetMs = 8000, seeds = []) {
  try {
    const detail = await getJSON(`/manga/detail/${mangaId}`);
    const m = detail.data;
    if (!m?.latest_chapter_id) return walkSnapshot(mangaId);
    if (chapterWalkCache.size > 100) chapterWalkCache.clear();
    let entry = chapterWalkCache.get(mangaId);
    if (!entry) {
      entry = { map: new Map(), complete: false, dead: new Map() };
      chapterWalkCache.set(mangaId, entry);
    }
    if (!entry.dead) entry.dead = new Map();
    // Records whose detail fetch just failed are skipped for a while:
    // failures are not cached by getJSON, so without this every call
    // would re-pay the failure cost at the same broken records and the
    // walk would never get past them within its budget.
    const isDead = (id) => {
      const ts = entry.dead.get(id);
      return ts != null && Date.now() - ts < 600_000;
    };
    const toEntry = (d) => ({
      title: `Chapter ${d.chapter_number}`,
      slug: d.chapter_id,
      date: relTime(d.release_date || d.created_at)
    });

    // Seed rows are real chapters even when their detail record is dead —
    // list them; the reader will surface the dead ones individually.
    for (const s of seeds) {
      if (s?.chapter_id && !entry.map.has(s.chapter_id)) {
        entry.map.set(s.chapter_id, {
          n: s.chapter_number,
          e: { title: `Chapter ${s.chapter_number}`, slug: s.chapter_id, date: relTime(s.release_date || s.created_at) }
        });
      }
    }

    // Anchors for downward walks, newest first: the latest chapter, the
    // seed rows, and the oldest chapter assembled so far (resuming).
    const anchors = [];
    const anchorSeen = new Set();
    const addAnchor = (id) => { if (id && !anchorSeen.has(id)) { anchorSeen.add(id); anchors.push(id); } };
    addAnchor(m.latest_chapter_id);
    [...seeds]
      .sort((a, b) => (b.chapter_number ?? 0) - (a.chapter_number ?? 0))
      .forEach(s => addAnchor(s.chapter_id));
    if (entry.map.size) {
      const oldest = [...entry.map.values()].sort((a, b) => (a.n ?? 0) - (b.n ?? 0))[0];
      if (oldest) addAnchor(oldest.e.slug);
    }

    const deadline = Date.now() + budgetMs;
    for (const anchorId of anchors) {
      if (entry.complete || Date.now() >= deadline) break;
      if (isDead(anchorId)) continue;
      let id = anchorId;
      const seenLocal = new Set();
      while (id && !seenLocal.has(id) && Date.now() < deadline) {
        seenLocal.add(id);
        if (isDead(id)) break;
        const r = await getJSON(`/chapter/detail/${id}`, 3_600_000, { timeout: 6000, retries: 0 }).catch(() => null);
        if (!r?.data) { entry.dead.set(id, Date.now()); break; } // broken record — the next anchor resumes below it
        const d = r.data;
        entry.map.set(d.chapter_id, { n: d.chapter_number, e: toEntry(d) });
        if (!d.prev_chapter_id) { entry.complete = true; break; }
        id = d.prev_chapter_id;
        if (entry.map.has(id)) break; // reached territory already assembled
      }
    }
    return walkSnapshot(mangaId);
  } catch {
    return walkSnapshot(mangaId);
  }
}

// Global Rate Limiter for all APIs (150 requests per 10 minutes).
// The online-presence endpoints are exempt: the client heartbeats
// /api/online/ping every ~25s, which alone would eat a sixth of the
// budget and could 429 a reading session into the reader error screen.
const globalLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 150,
  message: { error: 'Terlalu banyak permintaan. Silakan tunggu beberapa saat.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/online/'),
});

// Strict Rate Limiter for search to prevent database scraping (30 requests per minute)
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Terlalu banyak permintaan pencarian. Harap jeda sejenak.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', globalLimiter);

/* ── Edge (CDN) caching for read-only API responses ─────────────────
   First loads are slow: since Shinigami's migration, chapter lists are
   rebuilt by walking their records one by one, and every visitor on a
   cold function instance used to pay that full cost — phone browsers
   timed out and showed the reader error screen even though the site
   was healthy. Let Vercel's edge serve repeats instead: chapter
   payloads are immutable, and manga/home/list data tolerates a couple
   of minutes of staleness (stale-while-revalidate keeps it fresh in
   the background). */
const CDN_CACHE = [
  [/^\/api\/chapter$/, 'public, s-maxage=3600, stale-while-revalidate=86400'],
  [/^\/api\/manga\//, 'public, s-maxage=120, stale-while-revalidate=600'],
  [/^\/api\/home$/, 'public, s-maxage=60, stale-while-revalidate=300'],
  [/^\/api\/(list|top|schedule|genres|genre\/|search)/, 'public, s-maxage=120, stale-while-revalidate=600'],
];
app.use((req, res, next) => {
  if (req.method === 'GET') {
    for (const [re, val] of CDN_CACHE) {
      if (re.test(req.path)) { res.set('Cache-Control', val); break; }
    }
  }
  next();
});

/* ── /api/home ───────────────────────────────────────── */
app.get('/api/home', async (req, res) => {
  try {
    // Each sub-call is fault-tolerant: since Shinigami's Nov 2026 migration
    // some endpoints 502 (e.g. /manga/top?filter=weekly) and one dead call
    // must not blank the whole homepage. Weekly top is substituted with the
    // daily chart until the weekly endpoint recovers.
    const [rec, topDaily, topWeekly, topRated, updates, newProj] = await Promise.all([
      getJSON('/manga/list?page=1&page_size=10&is_recommended=true&sort=rating&sort_order=desc').catch(() => null),
      getJSON('/manga/top?filter=daily&page=1&page_size=12').catch(() => null),
      getJSON('/manga/top?filter=daily&page=1&page_size=10').catch(() => null),
      getJSON('/manga/list?page=1&page_size=10&sort=rating&sort_order=desc').catch(() => null),
      getJSON('/manga/list?page=1&page_size=16&type=project&is_update=true&sort=latest&sort_order=desc').catch(() => null),
      getJSON('/manga/list?page=1&page_size=6&type=project&sort=latest&sort_order=desc').catch(() => null)
    ]);

    // Featured hero slider — recommended titles with full metadata
    const featured = (rec?.data || []).map(m => ({
      title: m.title,
      slug: m.manga_id,
      img: coverOf(m),
      banner: m.cover_image_url || '',
      score: scoreOf(m),
      type: typeOf(m),
      genres: genresOf(m),
      synopsis: m.description || ''
    })).slice(0, 7);

    // Latest updates with up to 3 chapter badges each
    const updatesMapped = (updates?.data || []).map(m => ({
      title: m.title,
      slug: m.manga_id,
      img: coverOf(m),
      chapters: (m.chapters || []).slice(0, 3).map(c => ({
        title: `Chapter ${c.chapter_number}`,
        slug: c.chapter_id,
        date: relTime(c.created_at)
      }))
    }));

    // Sidebar ranked lists. Shinigami only exposes daily & weekly views,
    // so "Hari Ini" uses daily and "Top Rating" uses all-time user rating.
    const rankList = (arr) => (arr || []).slice(0, 10).map((m, i) => ({
      rank: i + 1,
      title: m.title,
      slug: m.manga_id,
      img: coverOf(m),
      score: scoreOf(m),
      pct: Math.round(parseFloat(m.user_rate || 0) * 10),
      genres: genresOf(m, 3)
    }));

    const popularRanked = {
      weekly: rankList(topWeekly?.data),
      daily: rankList(topDaily?.data),
      rating: rankList(topRated?.data)
    };

    // New series (sidebar)
    const newSeries = (newProj?.data || []).map(m => ({
      title: m.title,
      slug: m.manga_id,
      img: coverOf(m),
      genres: genresOf(m, 3),
      year: m.release_year ? String(m.release_year) : ''
    }));

    res.json({
      featured,
      updates: updatesMapped,
      popular: (topDaily?.data || []).map(mapItem).slice(0, 12),
      popularRanked,
      newSeries
    });
  } catch (e) {
    console.error('/api/home error:', e.message);
    res.status(502).json({ error: 'Sumber data sedang tidak bisa diakses. Coba lagi beberapa saat.' });
  }
});

/* ── /api/list ───────────────────────────────────────── */
app.get('/api/list', async (req, res) => {
  try {
    const { page = 1, order = 'update', type = '', status = '', genre = '' } = req.query;
    const fmt = String(type).toLowerCase();

    let items, totalPages;

    if (order === 'popular' && !fmt) {
      // Real view-based popularity. The weekly chart 502s since Shinigami's
      // Nov 2026 migration — use the daily chart, fall back to top-rated.
      let r = await getJSON(`/manga/top?filter=daily&page=${page}&page_size=24`).catch(() => null);
      if (!r) r = await getJSON(`/manga/list?page=${page}&page_size=24&sort=rating&sort_order=desc`);
      items = (r.data || []).map(mapItem);
      totalPages = r.meta?.total_page || 1;
    } else if (fmt) {
      // Upstream's format= filter 502s since the migration — fetch
      // unfiltered pages and keep only the requested type server-side
      // (typeOf reads taxonomy/country). Pages are cached upstream-side
      // of us, so re-scanning from page 1 keeps pagination consistent.
      const sort = (order === 'popular' || order === 'rating') ? 'rating' : 'latest';
      const collected = [];
      let exhausted = false;
      const lastUp = Math.min(Number(page) * 3, 12);
      for (let up = 1; up <= lastUp; up++) {
        let q = `/manga/list?page=${up}&page_size=24&sort=${sort}&sort_order=desc`;
        if (genre) q += `&genre_include=${encodeURIComponent(genre)}&genre_include_mode=and`;
        const r = await getJSON(q).catch(() => null);
        if (!r) break;
        const data = r.data || [];
        for (const m of data) {
          if (typeOf(m).toLowerCase() === fmt) collected.push(m);
        }
        if (data.length === 0 || up >= (r.meta?.total_page || up)) { exhausted = true; break; }
        if (collected.length >= Number(page) * 24) break;
      }
      items = collected.slice((Number(page) - 1) * 24, Number(page) * 24).map(mapItem);
      totalPages = exhausted ? Math.max(1, Math.ceil(collected.length / 24)) : Number(page) + 1;
    } else {
      // 'update' (default) → newest; 'popular' + type handled above
      const sort = (order === 'popular' || order === 'rating') ? 'rating' : 'latest';
      let q = `/manga/list?page=${page}&page_size=24&sort=${sort}&sort_order=desc`;
      if (genre) q += `&genre_include=${encodeURIComponent(genre)}&genre_include_mode=and`;
      const r = await getJSON(q);
      items = (r.data || []).map(mapItem);
      totalPages = r.meta?.total_page || 1;
    }

    // Status filter is not supported upstream — filter this page client-of-server side
    if (status) {
      const want = status.toLowerCase().startsWith('ongo') ? ['ongoing'] :
        status.toLowerCase().startsWith('compl') || status.toLowerCase().startsWith('selesai') ? ['completed'] : null;
      if (want) {
        items = items.filter(m => want.includes(String(m.status || '').toLowerCase()));
      }
    }

    res.json({ items, page: Number(page), totalPages });
  } catch (e) {
    console.error('/api/list error:', e.message);
    res.status(502).json({ error: 'Gagal memuat daftar komik.' });
  }
});

/* ── /api/schedule: jadwal update mingguan ─────────────────────────
   Kelompokkan komik yang baru update berdasarkan hari (WIB) dari
   latest_chapter_time. 1=Senin .. 7=Minggu. */
const WD_MAP = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
app.get('/api/schedule', async (req, res) => {
  try {
    // page_size=40 502s since Shinigami's Nov 2026 migration — use 24 and
    // one extra page; a failed page must not kill the whole schedule.
    const pages = await Promise.all([1, 2, 3, 4].map(p =>
      getJSON(`/manga/list?page=${p}&page_size=24&type=project&is_update=true&sort=latest&sort_order=desc`, 1_800_000)
        .catch(() => null)
    ));
    const days = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
    const seen = new Set();
    for (const pg of pages) {
      if (!pg) continue;
      for (const m of (pg.data || [])) {
        if (!m.manga_id || seen.has(m.manga_id)) continue;
        seen.add(m.manga_id);
        const t = m.latest_chapter_time || m.updated_at;
        if (!t) continue;
        const wdShort = new Date(t).toLocaleDateString('en-US', { timeZone: 'Asia/Jakarta', weekday: 'short' });
        const wd = WD_MAP[wdShort];
        if (!wd) continue;
        days[wd].push({
          ...mapItem(m),
          updateRel: relTime(t)
        });
      }
    }
    res.json({ days, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('/api/schedule error:', e.message);
    res.status(502).json({ error: 'Gagal memuat jadwal update.' });
  }
});



/* ── /api/img: proxy gambar chapter (untuk download offline) ────
   Hanya host CDN yang diizinkan. */
const IMG_HOSTS = new Set(['assets.shngm.id']);
app.get('/api/img', async (req, res) => {
  try {
    const u = new URL(String(req.query.url || ''));
    if (!IMG_HOSTS.has(u.hostname)) return res.status(400).json({ error: 'Host tidak diizinkan.' });
    const r = await fetch(u.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok || !r.body) return res.status(502).json({ error: 'Gagal ambil gambar.' });
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('/api/img error:', e.message);
    res.status(502).json({ error: 'Gagal ambil gambar.' });
  }
});

/* ── /api/img-low: versi hemat data (kompres via sharp) ──────── */
let _sharp = null;
function getSharp() {
  if (!_sharp) { try { _sharp = require('sharp'); } catch { _sharp = false; } }
  return _sharp || null;
}
app.get('/api/img-low', async (req, res) => {
  try {
    const u = new URL(String(req.query.url || ''));
    if (!IMG_HOSTS.has(u.hostname)) return res.status(400).json({ error: 'Host tidak diizinkan.' });
    const sharp = getSharp();
    const r = await fetch(u.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok || !r.body) return res.status(502).json({ error: 'Gagal ambil gambar.' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!sharp) { // fallback: kirim asli jika sharp tak tersedia
      res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    }
    const out = await sharp(buf)
      .resize({ width: 800, withoutEnlargement: true })
      .jpeg({ quality: 60, progressive: true })
      .toBuffer();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Saver', '1');
    res.send(out);
  } catch (e) {
    console.error('/api/img-low error:', e.message);
    res.status(502).json({ error: 'Gagal kompres gambar.' });
  }
});

/* ── /api/notif-check: cek chapter terbaru untuk daftar slug ────
   Query: ?slugs=slug1,slug2 (maks 30). Return: [{slug, chSlug, chTitle, date}] */
app.get('/api/notif-check', async (req, res) => {
  try {
    const slugs = String(req.query.slugs || '').split(',')
      .map(x => x.trim()).filter(Boolean).slice(0, 30);
    if (!slugs.length) return res.json({ items: [] });
    const items = await Promise.all(slugs.map(async (slug) => {
      try {
        // Only the latest chapter is needed here — read it straight from
        // the manga detail instead of fetching the whole chapter list.
        const d = await getJSON(`/manga/detail/${slug}`);
        const m = d.data;
        return m?.latest_chapter_id
          ? {
              slug,
              chSlug: m.latest_chapter_id,
              chTitle: `Chapter ${m.latest_chapter_number}`,
              date: relTime(m.latest_chapter_time)
            }
          : { slug, chSlug: null };
      } catch { return { slug, chSlug: null }; }
    }));
    res.json({ items });
  } catch (e) {
    console.error('/api/notif-check error:', e.message);
    res.status(502).json({ error: 'Gagal cek update.' });
  }
});

/* ── /api/search ─────────────────────────────────────── */
app.get('/api/search', searchLimiter, async (req, res) => {
  try {
    const { q = '' } = req.query;
    if (!q) return res.json({ items: [] });

    const r = await getJSON(
      `/manga/list?q=${encodeURIComponent(q)}&page=1&page_size=10&sort=latest&sort_order=desc`,
      120_000
    ).catch(() => null);
    if (r) return res.json({ items: (r.data || []).map(mapItem) });

    // Fallback while upstream search (q=) 502s since the Nov 2026
    // migration: scan recent + top-rated list pages and match the title
    // locally. Covers the actively-updating catalogue, not their whole
    // archive — good enough until their search recovers.
    const pool = await Promise.all([
      ...[1, 2, 3, 4].map(p => getJSON(`/manga/list?page=${p}&page_size=24&sort=latest&sort_order=desc`, 300_000).catch(() => null)),
      ...[1, 2].map(p => getJSON(`/manga/list?page=${p}&page_size=24&sort=rating&sort_order=desc`, 300_000).catch(() => null))
    ]);
    const needle = String(q).toLowerCase();
    const seenIds = new Set();
    const items = [];
    for (const pg of pool) {
      for (const m of (pg?.data || [])) {
        if (!m.manga_id || seenIds.has(m.manga_id)) continue;
        seenIds.add(m.manga_id);
        const hay = `${m.title || ''} ${m.alternative_title || ''}`.toLowerCase();
        if (hay.includes(needle)) items.push(mapItem(m));
      }
    }
    res.json({ items: items.slice(0, 20) });
  } catch (e) {
    console.error('/api/search error:', e.message);
    res.status(502).json({ error: 'Pencarian gagal.' });
  }
});

/* ── /api/manga/:slug (slug = Shinigami manga UUID) ──── */
app.get('/api/manga/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const [detailR, chapters] = await Promise.all([
      getJSON(`/manga/detail/${slug}`),
      fetchChapters(slug)
    ]);
    const m = detailR.data;
    if (!m || !m.title) return res.status(404).json({ error: 'Komik tidak ditemukan.' });

    res.json({
      title: m.title,
      altTitle: m.alternative_title || '',
      img: coverOf(m),
      synopsis: m.description || '',
      score: scoreOf(m),
      status: STATUS_MAP[m.status] || '',
      type: typeOf(m),
      author: (m.taxonomy?.Author || []).map(a => a.name).join(', '),
      genres: (m.taxonomy?.Genre || []).map(g => g.name),
      chapters
    });
  } catch (e) {
    console.error('/api/manga/:slug error:', e.message);
    res.status(502).json({ error: 'Gagal memuat detail komik.' });
  }
});

/* ── /api/chapter?slug= (slug = Shinigami chapter UUID) ─ */
app.get('/api/chapter', async (req, res) => {
  try {
    const slug = String(req.query.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'Slug chapter tidak valid.' });

    const r = await getJSON(`/chapter/detail/${slug}`, 3_600_000); // 1hr cache
    const d = r.data;
    if (!d?.chapter?.data) return res.status(404).json({ error: 'Chapter tidak ditemukan.' });

    const base = (d.base_url || 'https://assets.shngm.id') + d.chapter.path;
    const images = d.chapter.data.map(f => base + f);

    // Include the manga's chapter list + cover so the reader can navigate
    // (and recover context when opened directly from history/cards).
    // The images must NEVER wait on the chapter list: since Shinigami's
    // migration the list is rebuilt by walking chapter records one by one,
    // which on a cold instance takes seconds — long enough that the
    // reader used to time out and show "Gambar tidak tersedia" even
    // though the chapter itself was fine. Cap the wait at 5s and fall
    // back to whatever the walk has assembled so far (newest-first, so
    // the current chapter is in it); the walk keeps running in the
    // background and completes the cache for the next call.
    const chaptersPromise = fetchChapters(d.manga_id, 4000).catch(() => null);
    const [chaptersOrNull, detailR] = await Promise.all([
      Promise.race([
        chaptersPromise,
        new Promise(res => setTimeout(() => res(null), 5000))
      ]),
      getJSON(`/manga/detail/${d.manga_id}`).catch(() => null)
    ]);
    const chapters = chaptersOrNull
      || walkSnapshot(d.manga_id);
    const md = detailR?.data;

    res.json({
      images,
      chapterTitle: `Chapter ${d.chapter_number}`,
      sourceUrl: `https://11.shinigami.asia/chapter/${slug}`,
      mangaSlug: d.manga_id,
      mangaTitle: md?.title || '',
      img: md ? coverOf(md) : '',
      chapters
    });
  } catch (e) {
    console.error('/api/chapter error:', e.message);
    res.status(502).json({ error: 'Gagal memuat gambar chapter.' });
  }
});

/* ── /api/top ────────────────────────────────────────── */
app.get('/api/top', async (req, res) => {
  try {
    const { type = '', page = 1 } = req.query;
    const fmt = String(type).toLowerCase();

    // /manga/top ignores the format param — with a type filter,
    // rank by user rating within that format instead. Since Shinigami's
    // Nov 2026 migration the weekly chart and the format= filter both
    // 502: use the daily chart (rating list as backup) and filter the
    // type server-side via /api/list's approach.
    let r;
    if (fmt) {
      const collected = [];
      let exhausted = false;
      const lastUp = Math.min(Number(page) * 3, 12);
      for (let up = 1; up <= lastUp; up++) {
        const rr = await getJSON(
          `/manga/list?page=${up}&page_size=24&sort=rating&sort_order=desc`,
          120_000
        ).catch(() => null);
        if (!rr) break;
        const data = rr.data || [];
        for (const m of data) {
          if (typeOf(m).toLowerCase() === fmt) collected.push(m);
        }
        if (data.length === 0 || up >= (rr.meta?.total_page || up)) { exhausted = true; break; }
        if (collected.length >= Number(page) * 24) break;
      }
      return res.json({
        items: collected.slice((Number(page) - 1) * 24, Number(page) * 24).map(mapItem),
        page: Number(page),
        totalPages: exhausted ? Math.max(1, Math.ceil(collected.length / 24)) : Number(page) + 1
      });
    }
    r = await getJSON(`/manga/top?filter=daily&page=${page}&page_size=24`, 120_000).catch(() => null);
    if (!r) r = await getJSON(`/manga/list?page=${page}&page_size=24&sort=rating&sort_order=desc`, 120_000);
    res.json({
      items: (r.data || []).map(mapItem),
      page: Number(page),
      totalPages: r.meta?.total_page || 1
    });
  } catch (e) {
    console.error('/api/top error:', e.message);
    res.status(502).json({ error: 'Gagal memuat top komik.' });
  }
});

/* ── /api/genres ─────────────────────────────────────── */
app.get('/api/genres', async (req, res) => {
  try {
    const r = await getJSON('/genre/list', 3_600_000);
    const genres = (r.data || [])
      .filter(t => t.type === 'Genre' && t.name && t.slug)
      .map(t => ({ name: t.name, slug: t.slug }));
    res.json({ genres });
  } catch (e) {
    console.error('/api/genres error:', e.message);
    res.status(502).json({ error: 'Gagal memuat daftar genre.' });
  }
});

/* ── /api/genre/:slug ────────────────────────────────── */
app.get('/api/genre/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { page = 1 } = req.query;
    const r = await getJSON(
      `/manga/list?page=${page}&page_size=24&sort=latest&sort_order=desc` +
      `&genre_include=${encodeURIComponent(slug)}&genre_include_mode=and`,
      120_000
    );
    // Genre display name: prefer the cached genre list, else the slug
    let genreName = slug;
    try {
      const g = await getJSON('/genre/list', 3_600_000);
      const found = (g.data || []).find(t => t.slug === slug);
      if (found?.name) genreName = found.name;
    } catch { /* keep slug as name */ }

    res.json({
      items: (r.data || []).map(mapItem),
      page: Number(page),
      totalPages: r.meta?.total_page || 1,
      genreName
    });
  } catch (e) {
    console.error('/api/genre/:slug error:', e.message);
    res.status(502).json({ error: 'Gagal memuat komik berdasarkan genre.' });
  }
});

/* ── SEO: robots.txt & sitemap.xml ───────────────────── */
const SITE = 'https://www.komikzone.web.id';

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', async (req, res) => {
  try {
    const staticUrls = ['', '/explore', '/top', '/genre', '/all-series'];

    // Kumpulkan manga dari beberapa sumber supaya Google menemukan halaman detail
    const [latest, topW, rated] = await Promise.all([
      getJSON('/manga/list?page=1&page_size=100&sort=latest&sort_order=desc', 3_600_000).catch(() => null),
      getJSON('/manga/top?filter=weekly&page=1&page_size=100', 3_600_000).catch(() => null),
      getJSON('/manga/list?page=1&page_size=100&sort=rating&sort_order=desc', 3_600_000).catch(() => null)
    ]);
    const seen = new Set();
    const urls = [...staticUrls];
    for (const r of [latest, topW, rated]) {
      for (const m of (r?.data || [])) {
        if (m?.manga_id && !seen.has(m.manga_id)) {
          seen.add(m.manga_id);
          urls.push(`/manga/${m.manga_id}`);
        }
      }
    }

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map(u => `  <url><loc>${SITE}${u}</loc></url>`).join('\n') +
      `\n</urlset>\n`;
    res.type('application/xml').send(xml);
  } catch (e) {
    console.error('/sitemap.xml error:', e.message);
    res.status(500).type('application/xml').send('<?xml version="1.0"?><urlset></urlset>');
  }
});

const fs = require('fs');
let _indexHtml = null;

async function serveWithDynamicSEO(req, res, title, description, image) {
  try {
    if (!_indexHtml) {
      _indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    }
    let html = _indexHtml;
    if (title) {
      html = html.replace(/<title>.*<\/title>/, `<title>${title} - KomikZone</title>`);
      html = html.replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${title}"`);
      html = html.replace(/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${title}"`);
    }
    if (description) {
      html = html.replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${description}"`);
      html = html.replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${description}"`);
      html = html.replace(/<meta name="twitter:description" content="[^"]*"/, `<meta name="twitter:description" content="${description}"`);
    }
    if (image) {
      html = html.replace(/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="${image}"`);
      html = html.replace(/<meta name="twitter:image" content="[^"]*"/, `<meta name="twitter:image" content="${image}"`);
    }
    res.send(html);
  } catch (e) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
}

/* ── SPA fallback with Dynamic SEO for sharing ── */
app.get('/manga/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const r = await getJSON(`/manga/detail/${slug}`, 300_000).catch(() => null);
    if (r && r.data) {
      const m = r.data;
      const title = m.title ? m.title.replace(/"/g, '&quot;') : '';
      const desc = m.description ? m.description.substring(0, 150).replace(/"/g, '&quot;') + '...' : '';
      const img = m.cover_portrait_url || m.cover_image_url || '';
      return serveWithDynamicSEO(req, res, `Baca ${title}`, desc, img);
    }
  } catch(e) {}
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/chapter/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const r = await getJSON(`/chapter/detail/${slug}`, 300_000).catch(() => null);
    if (r && r.data && r.data.chapter) {
      const d = r.data;
      // We don't have manga title immediately unless we fetch manga detail, 
      // but we can just use Chapter Number.
      return serveWithDynamicSEO(req, res, `Chapter ${d.chapter_number} - KomikZone`, `Baca Chapter ${d.chapter_number} Bahasa Indonesia`, '');
    }
  } catch(e) {}
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ── Normal SPA fallback for other routes ── */
app.get(/^\/(explore|top|all-series|genre|bookmark|jadwal|p)(\/[^.]*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ── Server start or Export for Vercel ──────────────── */
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[KomikZone Proxy] running → http://localhost:${PORT} (source: Shinigami)`);
  });
}

module.exports = app;
