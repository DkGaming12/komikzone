/**
 * KomikZone Backend Proxy Server
 * Scrapes KomikKita.com (WordPress/Madara) and serves JSON API
 * Port: 3001 (frontend at 8080)
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.static(path.join(__dirname)));

/* ── helpers ─────────────────────────────────────────── */
const BASE = 'https://komikkita.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept-Language': 'id-ID,id;q=0.9',
  'Referer': BASE
};

const cache = new Map();

async function getHTML(url, ttl = 300_000) {
  if (cache.has(url)) {
    const { ts, html } = cache.get(url);
    if (Date.now() - ts < ttl) return html;
  }
  const r = await fetch(url, { headers: HEADERS, timeout: 12000 });
  if (!r.ok) throw new Error(`HTTP ${r.status} – ${url}`);
  const html = await r.text();
  cache.set(url, { ts: Date.now(), html });
  return html;
}

function imgSrc($, el) {
  return $(el).attr('data-src')
    || $(el).attr('data-lazy-src')
    || $(el).attr('data-cfsrc')
    || $(el).attr('src')
    || '';
}

/* ── /api/home ───────────────────────────────────────── */
// Latest updates + popular
app.get('/api/home', async (req, res) => {
  try {
    const html = await getHTML(`${BASE}/home/`);
    const $ = cheerio.load(html);

    // Featured slider - try multiple selector patterns
    const featured = [];
    const featuredSelectors = [
      '.slider .bs',
      '.featured-slider .bsx',
      '.owl-carousel .bsx',
      '#slider .bsx',
      '.postbody .bsx',
    ];
    for (const sel of featuredSelectors) {
      $(sel).each((_, el) => {
        const title = $(el).find('.tt, .bigor .tt').first().text().trim();
        const href = $(el).find('a').first().attr('href') || '';
        const img = imgSrc($, $(el).find('img').first());
        const genres = [];
        $(el).find('.ge-ul a, .genres-list a').each((_, g) => genres.push($(g).text().trim()));
        const slug = href.replace(BASE + '/manga/', '').replace(/\/$/, '');
        if (title && !featured.find(f => f.slug === slug)) featured.push({ title, slug, img, genres });
      });
      if (featured.length >= 3) break;
    }

    // Latest updates list
    const updates = [];
    $('.listupd .uta').each((_, el) => {
      const title = $(el).find('.luf .imgu img').attr('title') || $(el).find('h4').text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const img = imgSrc($, $(el).find('img').first());
      const chapters = [];
      $(el).find('.luf ul li').each((_, li) => {
        const chHref = $(li).find('a').attr('href') || '';
        const chTitle = $(li).find('a').text().trim();
        const chDate = $(li).find('span').text().trim();
        const chSlug = chHref.replace(BASE + '/', '').replace(/\/$/, '');
        if (chTitle) chapters.push({ title: chTitle, slug: chSlug, date: chDate });
      });
      const slug = href.replace(BASE + '/manga/', '').replace(/\/$/, '');
      if (title) updates.push({ title, slug, img, chapters: chapters.slice(0, 3) });
    });

    let popular = [];
    $('.postbody .pop-list .bsx, .widget_series .bsx, .bixbox.hothome .bsx').each((_, el) => {
      const title = $(el).find('.tt').first().text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const img = imgSrc($, $(el).find('img').first());
      const score = $(el).find('.rating span, .numscore').text().trim();
      const slug = href.replace(BASE + '/manga/', '').replace(/\/$/, '');
      if (title) popular.push({ title, slug, img, score });
    });

    if (!popular.length) {
      try {
        const popHtml = await getHTML(`${BASE}/manga/?order=popular`);
        const $p = cheerio.load(popHtml);
        $p('.listupd .bsx').slice(0, 10).each((_, el) => {
          const title = $p(el).find('.tt').first().text().trim();
          const href = $p(el).find('a').first().attr('href') || '';
          const img = imgSrc($p, $p(el).find('img').first());
          const score = $p(el).find('.rating span').text().trim();
          const slug = href.replace(BASE + '/manga/', '').replace(/\/$/, '');
          if (title) popular.push({ title, slug, img, score });
        });
      } catch (e) {
        console.warn('Failed to fetch popular fallback', e.message);
      }
    }

    // Fallback: if featured is empty, use popular items
    const featuredFinal = featured.length
      ? featured.slice(0, 6)
      : popular.slice(0, 6).map(m => ({ ...m, genres: [] }));

    res.json({ featured: featuredFinal, updates: updates.slice(0, 16), popular: popular.slice(0, 12) });
  } catch (e) {
    console.error('/api/home error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── /api/list ───────────────────────────────────────── */
// List komik dengan filter & pagination
app.get('/api/list', async (req, res) => {
  try {
    const { page = 1, order = 'update', type = '', status = '', genre = '' } = req.query;
    let url = `${BASE}/manga/?page=${page}&order=${order}`;
    if (type) url += `&type=${encodeURIComponent(type)}`;
    if (status) url += `&status=${encodeURIComponent(status)}`;
    if (genre) url += `&genre=${encodeURIComponent(genre)}`;

    const html = await getHTML(url, 60_000);
    const $ = cheerio.load(html);

    const items = [];
    $('.listupd .bsx').each((_, el) => {
      const title = $(el).find('.tt').first().text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const img = imgSrc($, $(el).find('img').first());
      const score = $(el).find('.rating span').text().trim();
      const type_ = $(el).find('.type').text().trim();
      const status_ = $(el).find('.status').text().trim();
      const latCh = $(el).find('.epxs').text().trim();
      const slug = href.replace(BASE + '/manga/', '').replace(/\/$/, '');
      if (title) items.push({ title, slug, img, score, type: type_, status: status_, latestChapter: latCh });
    });

    // Pagination
    const totalPages = parseInt($('.pagination .page-numbers:not(.next):not(.prev)').last().text()) || 1;

    res.json({ items, page: Number(page), totalPages });
  } catch (e) {
    console.error('/api/list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── /api/search ─────────────────────────────────────── */
app.get('/api/search', async (req, res) => {
  try {
    const { q = '' } = req.query;
    if (!q) return res.json({ items: [] });

    const url = `${BASE}/?s=${encodeURIComponent(q)}`;
    const html = await getHTML(url, 60_000);
    const $ = cheerio.load(html);

    const items = [];
    $('.listupd .bsx, .search-wrap .bsx').each((_, el) => {
      const title = $(el).find('.tt').first().text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const img = imgSrc($, $(el).find('img').first());
      const score = $(el).find('.rating span').text().trim();
      const type_ = $(el).find('.type').text().trim();
      const slug = href.replace(BASE + '/manga/', '').replace(/\/$/, '');
      if (title) items.push({ title, slug, img, score, type: type_ });
    });

    res.json({ items: items.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── /api/manga/:slug ────────────────────────────────── */
app.get('/api/manga/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const url = `${BASE}/manga/${slug}/`;
    const html = await getHTML(url);
    const $ = cheerio.load(html);

    const title = $('h1.entry-title, .seriestukon h1').first().text().trim();
    const altTitle = $('.seriestualt').text().trim();
    const img = imgSrc($, $('.thumb img, .sertothumb img, .thumbook img').first());
    const synopsis = $('.entry-content p, .synp p, .entry-content').first().text().trim();
    const score = $('.rating-num, .num').first().text().trim();
    const status = $('.tsinfo .imptdt:contains("Status") i, .infotable td:contains("Ongoing"), .infotable td:contains("Completed")').first().text().trim()
      || $('time').first().attr('datetime') || '';
    const type_ = $('.tsinfo .imptdt:contains("Type") a, .infotable td:contains("Manga"), .infotable td:contains("Manhwa"), .infotable td:contains("Manhua")').first().text().trim();
    // Author might be in .infotable or .tsinfo
    const author = $('.tsinfo .imptdt:contains("Author") i, .infotable tr:contains("Author") td:last-child').text().trim();
    const genres = [];
    $('.mgen a').each((_, a) => genres.push($(a).text().trim()));

    // Chapters - try AJAX first (Madara theme) to get ALL chapters at once
    const chapters = [];
    const postId = $('#manga-chapters-holder').attr('data-id')
      || $('[data-id]').filter((_, el) => $(el).attr('id') && $(el).attr('id').includes('manga')).first().attr('data-id')
      || $('script:contains("manga_chapters")').first().html()?.match(/"manga"\s*:\s*"?(\d+)"?/)?.[1];

    let ajaxSuccess = false;
    if (postId) {
      try {
        const ajaxRes = await fetch(`${BASE}/wp-admin/admin-ajax.php`, {
          method: 'POST',
          headers: {
            ...HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: `action=manga_get_chapters&manga=${postId}`,
          timeout: 10000
        });
        if (ajaxRes.ok) {
          const ajaxHtml = await ajaxRes.text();
          if (ajaxHtml && ajaxHtml.trim() !== '0' && ajaxHtml.includes('<li')) {
            const $a = cheerio.load(ajaxHtml);
            $a('li').each((_, el) => {
              const chHref = $a(el).find('a').attr('href') || '';
              const chTitle = $a(el).find('.chapternum').text().trim() || $a(el).find('span').first().text().trim();
              const chDate = $a(el).find('.chapterdate').text().trim();
              const chSlug = chHref.replace(BASE + '/', '').replace(/\/$/, '');
              if (chSlug) chapters.push({ title: chTitle, slug: chSlug, date: chDate });
            });
            if (chapters.length) ajaxSuccess = true;
          }
        }
      } catch (e) {
        console.warn('AJAX chapters failed, falling back to HTML:', e.message);
      }
    }

    // Fallback: scrape chapter list from HTML
    if (!ajaxSuccess) {
      $('#chapterlist li, .eplister ul li').each((_, el) => {
        const chHref = $(el).find('a').attr('href') || '';
        const chTitle = $(el).find('.chapternum').text().trim() || $(el).find('span').first().text().trim();
        const chDate = $(el).find('.chapterdate').text().trim();
        const chSlug = chHref.replace(BASE + '/', '').replace(/\/$/, '');
        if (chSlug) chapters.push({ title: chTitle, slug: chSlug, date: chDate });
      });
    }

    res.json({ title, altTitle, img, synopsis, score, status: status.trim(), type: type_, author, genres, chapters });
  } catch (e) {
    console.error('/api/manga/:slug error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── /api/chapter/:slug ──────────────────────────────── */
// Returns array of image URLs for a chapter
app.get('/api/chapter', async (req, res) => {
  try {
    const slug = req.query.slug || '';
    // KomikKita chapter URL format: komikkita.com/slug-chapter-N/
    const url = `${BASE}/${slug}/`;
    const html = await getHTML(url, 3_600_000); // 1hr cache for chapter pages
    const $ = cheerio.load(html);

    const images = [];
    // Madara theme reader
    $('.reading-content .page-break img, .reader-area img, #readerarea img').each((_, img) => {
      let src = imgSrc($, img);
      if (src) {
        src = src.trim();
        // Skip tracking pixel / very small images
        if (!src.includes('pixel') && !src.endsWith('.gif')) images.push(src);
      }
    });

    // Also try ts_reader JSON embedded in page
    if (!images.length) {
      const scripts = $('script').map((_, s) => $(s).html()).get().join('\n');
      const m = scripts.match(/ts_reader\.run\(({.*?})\)/s);
      if (m) {
        try {
          const data = JSON.parse(m[1]);
          const srcs = data?.sources?.[0]?.images || [];
          images.push(...srcs);
        } catch (_) { }
      }
    }

    const manga = $('html').find('meta[property="og:url"]').attr('content') || '';
    const chapterTitle = $('h1.entry-title').text().trim() || '';

    res.json({ images, chapterTitle, sourceUrl: url });
  } catch (e) {
    console.error('/api/chapter/:slug error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── /api/top ────────────────────────────────────────── */
app.get('/api/top', async (req, res) => {
  try {
    const { type = '', page = 1 } = req.query;
    let url = `${BASE}/manga/?page=${page}&order=popular`;
    if (type) url += `&type=${encodeURIComponent(type)}`;

    const html = await getHTML(url, 120_000);
    const $ = cheerio.load(html);
    const items = [];

    $('.listupd .bsx').each((_, el) => {
      const title = $(el).find('.tt').first().text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const img = imgSrc($, $(el).find('img').first());
      const score = $(el).find('.rating span').text().trim();
      const type_ = $(el).find('.type').text().trim();
      const latCh = $(el).find('.epxs').text().trim();
      const slug = href.replace(BASE + '/manga/', '').replace(/\/$/, '');
      if (title) items.push({ title, slug, img, score, type: type_, latestChapter: latCh });
    });

    const totalPages = parseInt($('.pagination .page-numbers:not(.next):not(.prev)').last().text()) || 1;
    res.json({ items, page: Number(page), totalPages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── /api/genres ─────────────────────────────────────── */
app.get('/api/genres', async (req, res) => {
  try {
    const html = await getHTML(`${BASE}/manga/`, 3_600_000);
    const $ = cheerio.load(html);
    const genres = [];
    $('.genre-list a, .genrelist a').each((_, a) => {
      const name = $(a).text().trim();
      const href = $(a).attr('href') || '';
      const slug = href.replace(BASE + '/genres/', '').replace(/\/$/, '');
      if (name) genres.push({ name, slug });
    });
    res.json({ genres });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── /api/genre/:slug ────────────────────────────────── */
app.get('/api/genre/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { page = 1 } = req.query;
    const url = `${BASE}/genres/${slug}/?page=${page}`;
    const html = await getHTML(url, 120_000);
    const $ = cheerio.load(html);
    const items = [];

    $('.listupd .bsx').each((_, el) => {
      const title = $(el).find('.tt').first().text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const img = imgSrc($, $(el).find('img').first());
      const score = $(el).find('.rating span').text().trim();
      const type_ = $(el).find('.type').text().trim();
      const slug_ = href.replace(BASE + '/manga/', '').replace(/\/$/, '');
      if (title) items.push({ title, slug: slug_, img, score, type: type_ });
    });

    const totalPages = parseInt($('.pagination .page-numbers:not(.next):not(.prev)').last().text()) || 1;
    res.json({ items, page: Number(page), totalPages, genreName: slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Server start or Export for Vercel ──────────────── */
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[KomikZone Proxy] running → http://localhost:${PORT}`);
  });
}

module.exports = app;
