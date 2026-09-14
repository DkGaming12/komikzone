/**
 * KomikZone Backend Proxy Server
 * Scrapes KomikKita (WordPress/Madara) and serves JSON API
 * Port: 3001 (frontend at 8080 / static)
 */

const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.static(path.join(__dirname)));

/* ── helpers ─────────────────────────────────────────── */
const BASE = 'https://komikkita.net';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept-Language': 'id-ID,id;q=0.9',
  'Referer': BASE
};

// Simple in-memory cache { url: { ts, html } }
const cache = new Map();
const MAX_CACHE = 200;

async function getHTML(url, ttl = 300_000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < ttl) return hit.html;

  // Global fetch (Node 18+) with a real timeout — retry once on network failure
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      if (cache.size > MAX_CACHE) cache.clear();
      cache.set(url, { ts: Date.now(), html });
      return html;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise(res => setTimeout(res, 800));
    }
  }
  throw new Error(`Gagal mengambil ${url} (${lastErr?.message || 'network error'})`);
}

/** Extract last path segment, e.g. "/manga/one-piece/" → "one-piece" */
function slugFromHref(href) {
  if (!href) return '';
  try {
    const p = new URL(href, BASE).pathname;
    return p.replace(/^\/+/, '').replace(/\/+$/, '');
  } catch {
    return String(href).replace(/^\/+/, '').replace(/\/+$/, '');
  }
}

/** Manga slug from any href (strips optional "manga/" folder) */
function mangaSlugFromHref(href) {
  return slugFromHref(href).replace(/^manga\//, '');
}

function imgSrc($, el) {
  if (!el || !el.length) return '';
  return (el.attr('data-src') || el.attr('data-lazy-src') || el.attr('data-cfsrc') || el.attr('src') || '').trim();
}

/** Parse list items (.bsx cards) shared by list/search/top/genre endpoints */
function parseBsxList($) {
  const items = [];
  $('.listupd .bsx').each((_, el) => {
    const title = $(el).find('.tt').first().text().trim();
    const href = $(el).find('a').first().attr('href') || '';
    const img = imgSrc($, $(el).find('img').first());
    const score = $(el).find('.rating span, .numscore').first().text().trim();
    const type = $(el).find('.type').first().text().trim();
    const latestChapter = $(el).find('.epxs').first().text().trim();
    const slug = mangaSlugFromHref(href);
    if (title && slug) items.push({ title, slug, img, score, type, latestChapter });
  });
  return items;
}

function parseTotalPages($) {
  const nums = $('.pagination .page-numbers')
    .map((_, el) => parseInt($(el).text()))
    .get()
    .filter(n => !isNaN(n));
  return nums.length ? Math.max(...nums) : 1;
}

/* ── /api/home ───────────────────────────────────────── */
app.get('/api/home', async (req, res) => {
  try {
    const html = await getHTML(`${BASE}/home/`);
    const $ = cheerio.load(html);

    // Popular from homepage widgets ("Populer Hari Ini" etc.)
    let popular = [];
    $('.widget_series .bsx, .bixbox.hothome .bsx, .popconslide .bsx').each((_, el) => {
      const title = $(el).find('.tt, a[title]').first().attr('title') || $(el).find('.tt').first().text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const img = imgSrc($, $(el).find('img').first());
      const score = $(el).find('.rating span, .numscore').first().text().trim();
      const type = ($(el).find('[class*="type"]').first().attr('class') || '').match(/(?:^|\s)(Manga|Manhwa|Manhua|Novel)(?:\s|$)/)?.[1] || '';
      const slug = mangaSlugFromHref(href);
      if (title && slug) popular.push({ title, slug, img, score, type });
    });

    // Featured hero slider (real site slider: banner, score, type, genres, synopsis)
    const featured = [];
    const seenFeat = new Set();
    $('.swiper-slide').each((_, el) => {
      const s = $(el);
      // <a href><span class="name">Title</span></a> — .name is a child span
      const nameEl = s.find('.name').first();
      const linkEl = nameEl.closest('a');
      const slug = mangaSlugFromHref(linkEl.attr('href'));
      if (!slug || seenFeat.has(slug)) return;
      const genres = [];
      s.find('.metas-genres-values a').each((_, g) => {
        const gn = $(g).text().trim();
        if (gn) genres.push(gn);
      });
      featured.push({
        title: nameEl.text().trim(),
        slug,
        img: s.find('.bigbanner').attr('data-bg') || imgSrc($, s.find('.bigbanner')),
        banner: s.find('.bigbanner').attr('data-bg') || '',
        score: s.find('.meta-score-values').text().trim(),
        type: s.find('.meta-type-values').text().trim(),
        genres: genres.slice(0, 4),
        synopsis: s.find('.desc').text().trim()
      });
      seenFeat.add(slug);
    });

    // Fallback: if slider empty, use top popular items
    const featuredFinal = featured.length
      ? featured.slice(0, 7)
      : popular.slice(0, 6).map(m => ({ ...m, genres: [] }));

    // Fallback: fetch popular list page
    if (!popular.length) {
      try {
        const popHtml = await getHTML(`${BASE}/manga/?order=popular`, 120_000);
        popular = parseBsxList(cheerio.load(popHtml)).slice(0, 12);
      } catch (e) {
        console.warn('Popular fallback failed:', e.message);
      }
    } else {
      popular = popular.slice(0, 12);
    }

    // Latest updates (list with latest 3 chapters each)
    const updates = [];
    $('.listupd .uta').each((_, el) => {
      const title = $(el).find('.luf .imgu img').attr('title') || $(el).find('h4').first().text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const img = imgSrc($, $(el).find('img').first());
      const chapters = [];
      $(el).find('.luf ul li').each((_, li) => {
        const chHref = $(li).find('a').attr('href') || '';
        const chTitle = $(li).find('a').text().trim();
        const chDate = $(li).find('span').text().trim();
        const chSlug = slugFromHref(chHref);
        if (chTitle && chSlug) chapters.push({ title: chTitle, slug: chSlug, date: chDate });
      });
      const slug = mangaSlugFromHref(href);
      if (title && slug) updates.push({ title, slug, img, chapters: chapters.slice(0, 3) });
    });

    res.json({ featured: featuredFinal, updates: updates.slice(0, 16), popular });
  } catch (e) {
    console.error('/api/home error:', e.message);
    res.status(502).json({ error: 'Sumber data sedang tidak bisa diakses. Coba lagi beberapa saat.' });
  }
});

/* ── /api/list ───────────────────────────────────────── */
app.get('/api/list', async (req, res) => {
  try {
    const { page = 1, order = 'update', type = '', status = '', genre = '' } = req.query;
    let url = `${BASE}/manga/?page=${page}&order=${order}`;
    if (type) url += `&type=${encodeURIComponent(type)}`;
    if (status) url += `&status=${encodeURIComponent(status)}`;
    if (genre) url += `&genre=${encodeURIComponent(genre)}`;

    const $ = cheerio.load(await getHTML(url, 60_000));
    res.json({ items: parseBsxList($), page: Number(page), totalPages: parseTotalPages($) });
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

    const $ = cheerio.load(await getHTML(`${BASE}/?s=${encodeURIComponent(q)}`, 60_000));
    res.json({ items: parseBsxList($).slice(0, 10) });
  } catch (e) {
    console.error('/api/search error:', e.message);
    res.status(502).json({ error: 'Pencarian gagal.' });
  }
});

/* ── /api/manga/:slug ────────────────────────────────── */
app.get('/api/manga/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const url = `${BASE}/manga/${slug}/`;
    const $ = cheerio.load(await getHTML(url));

    const title = $('h1.entry-title').first().text().trim();
    if (!title) return res.status(404).json({ error: 'Komik tidak ditemukan.' });

    const altTitle = $('.seriestualt').first().text().trim();
    const img = imgSrc($, $('.thumb img, .sertothumb img, .thumbook img').first());
    const synopsis = $('.entry-content p, .synp p, .entry-content').first().text().trim();
    const score = $('.rating-num, .num').first().text().trim();
    const status = $('.tsinfo .imptdt:contains("Status") i').first().text().trim()
      || $('.infotable td:contains("Ongoing"), .infotable td:contains("Completed")').first().text().trim();
    const type = $('.tsinfo .imptdt:contains("Type") a').first().text().trim()
      || $('.infotable td:contains("Manga"), .infotable td:contains("Manhwa"), .infotable td:contains("Manhua")').first().text().trim();
    const author = $('.tsinfo .imptdt:contains("Author") i').first().text().trim()
      || $('.infotable tr:contains("Author") td:last-child').first().text().trim();
    const genres = [];
    $('.mgen a').each((_, a) => genres.push($(a).text().trim()));

    // Chapter list is fully rendered in the HTML (newest first)
    const chapters = [];
    $('#chapterlist li, .eplister ul li').each((_, el) => {
      const chHref = $(el).find('a').attr('href') || '';
      const chTitle = $(el).find('.chapternum').first().text().trim() || $(el).find('span').first().text().trim();
      const chDate = $(el).find('.chapterdate').first().text().trim();
      const chSlug = slugFromHref(chHref);
      if (chSlug) chapters.push({ title: chTitle || 'Chapter', slug: chSlug, date: chDate });
    });

    res.json({ title, altTitle, img, synopsis, score, status, type, author, genres, chapters });
  } catch (e) {
    console.error('/api/manga/:slug error:', e.message);
    res.status(502).json({ error: 'Gagal memuat detail komik.' });
  }
});

/* ── /api/chapter?slug= ──────────────────────────────── */
app.get('/api/chapter', async (req, res) => {
  try {
    const slug = slugFromHref(req.query.slug || '');
    if (!slug) return res.status(400).json({ error: 'Slug chapter tidak valid.' });

    const url = `${BASE}/${slug}/`;
    const $ = cheerio.load(await getHTML(url, 3_600_000)); // 1hr cache

    const images = [];
    const seen = new Set();
    $('.reading-content .page-break img, .reader-area img, #readerarea img').each((_, img) => {
      let src = imgSrc($, img);
      if (!src) return;
      try { src = new URL(src, BASE).href; } catch { /* keep as-is */ }
      // Skip tracking pixels / icons
      if (/pixel|logo|banner/i.test(src) || src.endsWith('.gif') || src.endsWith('.svg')) return;
      if (!seen.has(src)) { seen.add(src); images.push(src); }
    });

    // Fallback: ts_reader JSON embedded in page
    if (!images.length) {
      const scripts = $('script').map((_, s) => $(s).html()).get().join('\n');
      const m = scripts.match(/ts_reader\.run\(\s*(\{[\s\S]*?\})\s*\)\s*;/);
      if (m) {
        try {
          const data = JSON.parse(m[1]);
          for (const src of (data?.sources?.[0]?.images || [])) {
            if (src && !seen.has(src)) { seen.add(src); images.push(src); }
          }
        } catch { /* ignore bad JSON */ }
      }
    }

    const chapterTitle = $('h1.entry-title').first().text().trim();
    res.json({ images, chapterTitle, sourceUrl: url });
  } catch (e) {
    console.error('/api/chapter error:', e.message);
    res.status(502).json({ error: 'Gagal memuat gambar chapter.' });
  }
});

/* ── /api/top ────────────────────────────────────────── */
app.get('/api/top', async (req, res) => {
  try {
    const { type = '', page = 1 } = req.query;
    let url = `${BASE}/manga/?page=${page}&order=popular`;
    if (type) url += `&type=${encodeURIComponent(type)}`;

    const $ = cheerio.load(await getHTML(url, 120_000));
    res.json({ items: parseBsxList($), page: Number(page), totalPages: parseTotalPages($) });
  } catch (e) {
    console.error('/api/top error:', e.message);
    res.status(502).json({ error: 'Gagal memuat top komik.' });
  }
});

/* ── /api/genres ─────────────────────────────────────── */
app.get('/api/genres', async (req, res) => {
  try {
    const $ = cheerio.load(await getHTML(`${BASE}/genres/`, 3_600_000));
    const seen = new Set();
    const genres = [];
    $('a[href*="/genres/"]').each((_, a) => {
      // Strip trailing count, e.g. "Action 1395" → "Action"
      const name = $(a).text().replace(/\s*\d+\s*$/, '').trim();
      const slug = slugFromHref($(a).attr('href')).replace(/^genres\//, '');
      if (name && slug && !seen.has(slug)) { seen.add(slug); genres.push({ name, slug }); }
    });
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
    const url = `${BASE}/genres/${slug}/?page=${page}`;
    const $ = cheerio.load(await getHTML(url, 120_000));
    res.json({
      items: parseBsxList($),
      page: Number(page),
      totalPages: parseTotalPages($),
      genreName: slug
    });
  } catch (e) {
    console.error('/api/genre/:slug error:', e.message);
    res.status(502).json({ error: 'Gagal memuat komik berdasarkan genre.' });
  }
});

/* ── Server start or Export for Vercel ──────────────── */
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[KomikZone Proxy] running → http://localhost:${PORT}`);
  });
}

module.exports = app;
