/**
 * KomikZone Backend Proxy Server
 * Serves JSON API from Shinigami Scans public API (api.shngm.io)
 * Port: 3001 (frontend served from same origin / static)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.static(path.join(__dirname)));

/* ── Shinigami API helpers ────────────────────────────── */
const API = 'https://api.shngm.io/v1';

// Simple in-memory cache { url: { ts, json } }
const cache = new Map();
const MAX_CACHE = 200;

async function getJSON(pathAndQuery, ttl = 300_000) {
  const url = `${API}${pathAndQuery}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < ttl) return hit.json;

  // Global fetch (Node 18+) with a real timeout — retry once on network failure
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      if (json.retcode !== 0 || !json.data) throw new Error(json.message || 'API error');
      if (cache.size > MAX_CACHE) cache.clear();
      cache.set(url, { ts: Date.now(), json });
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise(res => setTimeout(res, 800));
    }
  }
  throw new Error(`Gagal mengambil ${url} (${lastErr?.message || 'network error'})`);
}

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

/** Chapter list of a manga (single page, big page_size covers most series) */
function fetchChapters(mangaId) {
  return getJSON(
    `/chapter/${mangaId}/list?page=1&page_size=500&sort_by=chapter_number&sort_order=desc`,
    300_000
  ).then(r => (r.data || []).map(mapChapter)).catch(() => []);
}

/* ── /api/home ───────────────────────────────────────── */
app.get('/api/home', async (req, res) => {
  try {
    const [rec, topDaily, topWeekly, topRated, updates, newProj] = await Promise.all([
      getJSON('/manga/list?page=1&page_size=10&is_recommended=true&sort=rating&sort_order=desc'),
      getJSON('/manga/top?filter=daily&page=1&page_size=12'),
      getJSON('/manga/top?filter=weekly&page=1&page_size=10'),
      getJSON('/manga/list?page=1&page_size=10&sort=rating&sort_order=desc'),
      getJSON('/manga/list?page=1&page_size=16&type=project&is_update=true&sort=latest&sort_order=desc'),
      getJSON('/manga/list?page=1&page_size=6&type=project&sort=latest&sort_order=desc')
    ]);

    // Featured hero slider — recommended titles with full metadata
    const featured = (rec.data || []).map(m => ({
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
    const updatesMapped = (updates.data || []).map(m => ({
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
      weekly: rankList(topWeekly.data),
      daily: rankList(topDaily.data),
      rating: rankList(topRated.data)
    };

    // New series (sidebar)
    const newSeries = (newProj.data || []).map(m => ({
      title: m.title,
      slug: m.manga_id,
      img: coverOf(m),
      genres: genresOf(m, 3),
      year: m.release_year ? String(m.release_year) : ''
    }));

    res.json({
      featured,
      updates: updatesMapped,
      popular: (topDaily.data || []).map(mapItem).slice(0, 12),
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
      // Real view-based popularity: weekly top ranking.
      // NOTE: /manga/top ignores the format param, so a type filter
      // falls through to top-rated within that format below.
      const r = await getJSON(`/manga/top?filter=weekly&page=${page}&page_size=24`);
      items = (r.data || []).map(mapItem);
      totalPages = r.meta?.total_page || 1;
    } else {
      // 'update' (default) → newest; 'popular' + type → top rated within format
      const sort = order === 'popular' ? 'rating' : 'latest';
      let q = `/manga/list?page=${page}&page_size=24&sort=${sort}&sort_order=desc`;
      if (fmt) q += `&format=${encodeURIComponent(fmt)}`;
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

/* ── /api/search ─────────────────────────────────────── */
app.get('/api/search', async (req, res) => {
  try {
    const { q = '' } = req.query;
    if (!q) return res.json({ items: [] });

    const r = await getJSON(
      `/manga/list?q=${encodeURIComponent(q)}&page=1&page_size=10&sort=latest&sort_order=desc`,
      120_000
    );
    res.json({ items: (r.data || []).map(mapItem) });
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
    // (and recover context when opened directly from history/cards)
    const [chapters, detailR] = await Promise.all([
      fetchChapters(d.manga_id),
      getJSON(`/manga/detail/${d.manga_id}`).catch(() => null)
    ]);
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
    // rank by user rating within that format instead
    let r;
    if (fmt) {
      r = await getJSON(
        `/manga/list?page=${page}&page_size=24&sort=rating&sort_order=desc&format=${encodeURIComponent(fmt)}`,
        120_000
      );
    } else {
      r = await getJSON(`/manga/top?filter=weekly&page=${page}&page_size=24`, 120_000);
    }
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
const SITE = 'https://komikzone.web.id';

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

/* ── SPA fallback: URL routing client-side (paritas dengan rute Vercel) ──
   Path tanpa ekstensi file saja — /manga/style.css tetap ke static */
app.get(/^\/(explore|top|all-series|genre|manga|chapter|p)(\/[^.]*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ── Server start or Export for Vercel ──────────────── */
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[KomikZone Proxy] running → http://localhost:${PORT} (source: Shinigami)`);
  });
}

module.exports = app;
