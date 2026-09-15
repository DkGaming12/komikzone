/* =====================================================
   KomikZone – app.js
   Data source: Shinigami (api.shngm.io) via proxy
   ===================================================== */

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const PROXY = isLocal ? 'http://localhost:3001' : '';

/* ── fetch with cache, timeout & clear errors ── */
const _apiCache = new Map();
const _inflight = new Map();

async function api(url) {
  if (_apiCache.has(url)) return _apiCache.get(url);
  if (_inflight.has(url)) return _inflight.get(url);

  const p = (async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      _apiCache.set(url, d);
      return d;
    } catch (e) {
      console.warn('API err:', url, e.message);
      return null;
    } finally {
      _inflight.delete(url);
    }
  })();

  _inflight.set(url, p);
  return p;
}

/* ── DOM helpers ── */
const $ = id => document.getElementById(id);
const $$ = s => [...document.querySelectorAll(s)];

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let _toastTimer = null;

function showToast(msg, dur = 2800) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(hideToast, dur);
}

function hideToast() {
  clearTimeout(_toastTimer);
  $('toast')?.classList.remove('on');
}

/** Retry button box for failed loads — fn must be callable from onclick string */
function retryBox(msg = 'Gagal memuat data.') {
  return `<div class="empty-box" style="padding:3rem">
    <div class="ei">📡</div>
    <div class="et">${esc(msg)}</div>
    <div class="es">Periksa koneksi internet lalu coba lagi</div>
    <button class="btn-primary" style="margin-top:1rem" onclick="location.reload()">🔄 Muat Ulang</button>
  </div>`;
}

/* ── State ── */
let curPg = 'home';
let prevPg = 'home';

let expSort = 'update', expType = '';
let topType = '';

let slideIdx = 0, slideN = 0, slideTimer = null;

/* ── URL routing (SEO: tiap halaman punya URL sendiri) ── */
const PAGE_PATHS = {
  home: { path: '/', title: '' },
  explore: { path: '/explore', title: 'Explore Komik' },
  top: { path: '/top', title: 'Top Komik' },
  allseries: { path: '/all-series', title: 'All Series' },
  genre: { path: '/genre', title: 'Genre Komik' }
};
const DEFAULT_TITLE = document.title;
let _navPushed = false;

/** Update address bar + document.title.
 *  Pindah "grup" halaman (mis. /manga → /chapter) = pushState;
 *  pindah item dalam grup yang sama (chapter 1 → chapter 2) = replaceState
 *  supaya history tidak penuh entri chapter. */
function setUrl(path, title) {
  try {
    const base = p => p.replace(/\/[^/]*$/, '');
    if (location.pathname !== path) {
      if (base(location.pathname) === base(path)) history.replaceState({}, '', path);
      else { history.pushState({}, '', path); _navPushed = true; }
    }
  } catch { }
  document.title = title ? `${title} – KomikZone` : DEFAULT_TITLE;
}

/** Tombol "← Kembali": pakai history bila kita yang push, agar URL ikut mundur */
function goBack() {
  if (_navPushed) history.back();
  else navigate(prevPg || 'home');
}

/** Restore halaman dari URL (popstate / direct load / back dari Google) */
function routeFromPath() {
  const p = decodeURIComponent(location.pathname).replace(/\/+$/, '') || '/';
  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    const inp = $('q');
    if (inp) { inp.value = q; inp.dispatchEvent(new Event('input')); }
    return;
  }
  if (p === '/' || p === '/index.html') { navigate('home'); return; }
  if (p === '/explore') return navigate('explore');
  if (p === '/top') return navigate('top');
  if (p === '/all-series') return navigate('allseries');
  if (p === '/genre') return navigate('genre');
  let m;
  if ((m = p.match(/^\/genre\/([^/]+)$/))) return loadGenre(m[1], m[1].replace(/-/g, ' '), 1);
  if ((m = p.match(/^\/manga\/([^/]+)$/))) return openDetail(m[1]);
  if ((m = p.match(/^\/chapter\/([^/]+)$/))) return openReader(m[1]);
  if ((m = p.match(/^\/p\/([a-z]+)$/))) return showPage(m[1]);
  navigate('home');
}
window.addEventListener('popstate', routeFromPath);

/* ── Genre list (fallback if API empty) ── */
const GENRES_DEFAULT = [
  { name: 'Action', slug: 'action', icon: '⚔️' },
  { name: 'Adventure', slug: 'adventure', icon: '🗺️' },
  { name: 'Comedy', slug: 'comedy', icon: '😄' },
  { name: 'Drama', slug: 'drama', icon: '🎭' },
  { name: 'Fantasy', slug: 'fantasy', icon: '🧙' },
  { name: 'Horror', slug: 'horror', icon: '👻' },
  { name: 'Mystery', slug: 'mystery', icon: '🔍' },
  { name: 'Romance', slug: 'romance', icon: '💕' },
  { name: 'Sci-Fi', slug: 'sci-fi', icon: '🚀' },
  { name: 'Slice of Life', slug: 'slice-of-life', icon: '🌸' },
  { name: 'Shounen', slug: 'shounen', icon: '🔥' },
  { name: 'Seinen', slug: 'seinen', icon: '🗡️' },
  { name: 'Josei', slug: 'josei', icon: '💐' },
  { name: 'Shoujo', slug: 'shoujo', icon: '🌷' },
  { name: 'Manhwa', slug: 'manhwa', icon: '🇰🇷' },
  { name: 'Manhua', slug: 'manhua', icon: '🇨🇳' },
  { name: 'Isekai', slug: 'isekai', icon: '🌀' },
  { name: 'Martial Arts', slug: 'martial-arts', icon: '🥋' },
  { name: 'Supernatural', slug: 'supernatural', icon: '👁️' },
  { name: 'Psychological', slug: 'psychological', icon: '🧠' },
];

/* ─────────────────────────────────────────────────────
   CARD BUILDERS
───────────────────────────────────────────────────── */
function openReaderSafe(chSlug, title) {
  openReader(chSlug, title);
}

function buildCard(m, opts = {}) {
  const el = document.createElement('div');
  el.className = 'komik-card';
  el.onclick = () => openDetail(m.slug);

  const rank = opts.rank
    ? `<div class="kc-rank${opts.rank <= 3 ? ' top' : ''}">${opts.rank}</div>`
    : '';
  const typeLabel = m.type ? `<span class="kc-type tag t-${esc(m.type.toLowerCase())}">${esc(m.type)}</span>` : '';
  const score = m.score ? `<div class="kc-score">★ ${esc(m.score)}</div>` : '';
  const safeTitle = esc(m.title || '');

  // Build chapter badges (max 2) below title
  // "Chapter" dibungkus span agar bisa disingkat jadi "Ch." di layar kecil (CSS)
  const splitChTitle = t => {
    const s = String(t || '');
    return /^Chapter\s+/i.test(s)
      ? `<span class="kc-ch-word">Chapter</span> ${esc(s.replace(/^Chapter\s+/i, ''))}`
      : esc(s || 'Chapter');
  };
  let chaptersHtml = '';
  if (m.chapters && m.chapters.length > 0) {
    chaptersHtml = `<div class="kc-chapters">` + m.chapters.slice(0, 2).map(c => `
      <div class="kc-ch" data-ch="${esc(c.slug)}" data-title="${safeTitle}">
        <span class="kc-ch-num">${splitChTitle(c.title)}</span>
        <span class="kc-ch-time">${esc(c.date || '')}</span>
      </div>`).join('') + `</div>`;
  } else if (m.latestChapter) {
    chaptersHtml = `<div class="kc-chapters">
      <div class="kc-ch"><span class="kc-ch-num">${esc(m.latestChapter)}</span></div>
    </div>`;
  }

  el.innerHTML = `
    <div class="kc-thumb">
      <img class="kc-img" src="${esc(m.img || '')}" alt="${safeTitle}" loading="lazy"
        onload="this.parentElement.classList.add('loaded')"
        onerror="this.onerror=null;this.parentElement.classList.add('noimg','loaded');this.remove()">
      ${rank}${typeLabel}${score}
      <div class="kc-ov"><div class="kc-play">▶</div></div>
    </div>
    <div class="kc-body">
      <div class="kc-title">${safeTitle || 'Tanpa Judul'}</div>
      ${chaptersHtml}
    </div>`;
  return el;
}

function buildUpdateRow(m, i) {
  const el = document.createElement('div');
  el.className = 'update-row';

  const typeLabel = m.type ? `<span class="up-type-badge t-${esc(m.type.toLowerCase())}">${esc(m.type)}</span>` : '';
  const safeTitle = esc(m.title || '');
  const chapters = (m.chapters || []).slice(0, 3).map(c => `
    <div class="up-ch" data-ch="${esc(c.slug)}" data-title="${safeTitle}">
      <span class="up-ch-num">${esc(c.title)}</span>
      <span class="up-ch-time">${esc(c.date || '')}</span>
    </div>`).join('');

  el.innerHTML = `
    <img class="up-thumb" src="${esc(m.img || '')}" alt="${safeTitle}" loading="lazy"
      onerror="this.onerror=null;this.style.display='none'">
    <div class="up-info">
      ${typeLabel}
      <div class="up-title">${safeTitle}</div>
      <div class="up-chapters">${chapters}</div>
    </div>`;
  el.onclick = () => openDetail(m.slug);
  return el;
}

/** Delegated click handler for chapter shortcuts inside cards */
document.addEventListener('click', e => {
  const ch = e.target.closest('.kc-ch, .up-ch');
  if (!ch) return;
  e.stopPropagation();
  if (ch.dataset.ch) openReader(ch.dataset.ch, ch.dataset.title || '');
});

function renderCards(gridId, items, { emptyMsg = 'Tidak ada komik' } = {}) {
  const g = $(gridId);
  if (!g) return;
  g.innerHTML = '';
  if (!items || !items.length) {
    g.innerHTML = `<div class="empty-box" style="padding:3rem;grid-column:1/-1">
      <div class="ei">😕</div><div class="et">${esc(emptyMsg)}</div></div>`;
    return;
  }
  items.forEach(m => g.appendChild(buildCard(m)));
}

const SKEL_CARD = `<div class="skel-card"><div class="skel-img"></div>
  <div class="kc-body"><div class="skel-line"></div><div class="skel-line s"></div></div></div>`;

function gridLoading(gridId, n = 8) {
  const g = $(gridId);
  if (g) g.innerHTML = SKEL_CARD.repeat(n);
}

/* Smart pagination: 1 … 4 5 [6] 7 8 … 20 */
function paginate(pagerId, curPage, total, fnName) {
  const p = $(pagerId);
  if (!p) return;
  if (total <= 1) { p.innerHTML = ''; return; }

  const parts = [];
  const push = (label, page, opts = {}) => parts.push(
    `<button class="pg-btn${opts.cls ? ' ' + opts.cls : ''}" ${opts.dis ? 'disabled' : ''}
      ${page ? `data-pg="${page}" data-fn="${fnName}"` : ''}>${label}</button>`);

  push('‹', curPage - 1, { dis: curPage <= 1, cls: 'pg-arr' });

  const win = 2;
  let last = 0;
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || Math.abs(i - curPage) <= win) {
      if (last && i - last > 1) parts.push('<span class="pg-dots">…</span>');
      push(i, i, { cls: i === curPage ? 'on' : '' });
      last = i;
    }
  }

  push('›', curPage + 1, { dis: curPage >= total, cls: 'pg-arr' });

  p.innerHTML = parts.join('');
  p.classList.add('ready');
}

// Delegated pagination click
document.addEventListener('click', e => {
  const btn = e.target.closest('.pg-btn[data-pg]');
  if (!btn) return;
  const pg = parseInt(btn.dataset.pg);
  const fn = window[btn.dataset.fn];
  if (pg >= 1 && typeof fn === 'function') fn(pg);
});

/* ─────────────────────────────────────────────────────
   SLIDER
───────────────────────────────────────────────────── */
function initSlider(items) {
  const sl = $('feat-slides');
  const dot = $('feat-dots');
  if (!sl || !items.length) return;

  slideN = items.length;
  sl.innerHTML = items.map((m, i) => `
    <div class="feat-slide" data-i="${i}" data-slug="${esc(m.slug)}">
      <div class="feat-bg" style="background-image:url('${esc(m.banner || m.img || '')}')"></div>
      <div class="feat-overlay"></div>
      <div class="feat-body">
        ${m.img ? `<img class="feat-cover" src="${esc(m.img)}" alt="${esc(m.title || '')}" loading="${i === 0 ? 'eager' : 'lazy'}" onload="this.classList.add('ld')" onerror="this.onerror=null;this.classList.add('ld')">` : ''}
        <div class="feat-info">
          <div class="feat-tags">
            ${m.score ? `<span class="tag t-score">★ ${esc(m.score)}</span>` : ''}
            ${m.type ? `<span class="tag t-${esc(m.type.toLowerCase())}">${esc(m.type)}</span>` : ''}
            ${(m.genres || []).slice(0, 4).map(g => `<span class="tag t-genre">${esc(g)}</span>`).join('')}
          </div>
          <h2 class="feat-title">${esc(m.title || '')}</h2>
          ${m.synopsis ? `<p class="feat-syn">${esc(m.synopsis)}</p>` : ''}
          <div class="feat-btns">
            <button class="btn-primary" data-open="${esc(m.slug)}">📖 Baca Sekarang</button>
          </div>
        </div>
      </div>
    </div>`).join('');

  dot.innerHTML = items.map((_, i) =>
    `<button class="fdot${i === 0 ? ' on' : ''}" data-slide="${i}" aria-label="Slide ${i + 1}"></button>`).join('');

  clearInterval(slideTimer);
  slideIdx = 0;
  slideTimer = setInterval(() => goSlide((slideIdx + 1) % slideN), 5000);
  goSlide(0);
}

function goSlide(i) {
  slideIdx = i;
  const sl = $('feat-slides');
  if (sl) sl.style.transform = `translateX(-${i * 100}%)`;
  $$('.feat-slide').forEach((s, j) => s.classList.toggle('active', j === i));
  $$('.fdot').forEach((d, j) => d.classList.toggle('on', j === i));
}

$('feat-prev').addEventListener('click', () => goSlide((slideIdx - 1 + slideN) % slideN));
$('feat-next').addEventListener('click', () => goSlide((slideIdx + 1) % slideN));

// Slider click delegation (slide / dot / Baca button)
$('feat-slides').addEventListener('click', e => {
  const btn = e.target.closest('[data-open]');
  if (btn) { openDetail(btn.dataset.open); return; }
  const slide = e.target.closest('.feat-slide');
  if (slide?.dataset.slug) openDetail(slide.dataset.slug);
});
$('feat-dots').addEventListener('click', e => {
  const d = e.target.closest('[data-slide]');
  if (d) goSlide(parseInt(d.dataset.slide));
});

/* ─────────────────────────────────────────────────────
   REKOMENDASI SLIDER — state
───────────────────────────────────────────────────── */
let _rekoAll = [];
let _rekoOffset = 0;
let _rekoPerPage = 4;

function renderRekoSlider() {
  const sl = $('reko-slider');
  if (!sl) return;
  const visible = _rekoAll.slice(_rekoOffset, _rekoOffset + _rekoPerPage);
  sl.innerHTML = '';
  if (!visible.length) {
    sl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:2rem;color:var(--txt3);font-size:.85rem">Tidak ada data</div>`;
    return;
  }
  visible.forEach(m => sl.appendChild(buildCard(m)));
}

if ($('reko-prev')) $('reko-prev').addEventListener('click', () => {
  if (_rekoOffset <= 0) return;
  _rekoOffset = Math.max(0, _rekoOffset - _rekoPerPage);
  renderRekoSlider();
});

if ($('reko-next')) $('reko-next').addEventListener('click', () => {
  if (_rekoOffset + _rekoPerPage >= _rekoAll.length) return;
  _rekoOffset += _rekoPerPage;
  renderRekoSlider();
});

async function loadReko(type) {
  const sl = $('reko-slider');
  if (sl) sl.innerHTML = SKEL_CARD.repeat(4);
  _rekoOffset = 0;

  let d;
  if (type === 'all') {
    d = await api(`${PROXY}/api/home`);
    _rekoAll = [...(d?.featured || []), ...(d?.popular || [])];
  } else {
    d = await api(`${PROXY}/api/list?type=${encodeURIComponent(type)}&order=popular&page=1`);
    _rekoAll = d?.items || [];
  }
  const seen = new Set();
  _rekoAll = _rekoAll.filter(m => { if (seen.has(m.slug)) return false; seen.add(m.slug); return true; });

  if (!_rekoAll.length && sl) {
    sl.innerHTML = `<div style="grid-column:1/-1">${retryBox('Rekomendasi gagal dimuat.')}</div>`;
    return;
  }
  renderRekoSlider();
}

// Rekomendasi filter tabs
$$('#reko-blk .filt').forEach(btn => btn.addEventListener('click', () => {
  $$('#reko-blk .filt').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadReko(btn.dataset.reko);
}));

function updateRekoPerPage() {
  if (window.innerWidth <= 480) _rekoPerPage = 2;
  else if (window.innerWidth <= 768) _rekoPerPage = 3;
  else _rekoPerPage = 4;
}

let _resizeT;
window.addEventListener('resize', () => {
  clearTimeout(_resizeT);
  _resizeT = setTimeout(() => { updateRekoPerPage(); renderRekoSlider(); }, 150);
});

/* ─────────────────────────────────────────────────────
   UPDATE TERBARU — card grid + pagination
───────────────────────────────────────────────────── */
async function loadUpdateTerbaru(pg = 1) {
  gridLoading('update-grid');

  let d;
  if (pg === 1) {
    // Parallel: home updates (rich, with chapter badges) + page count
    const [homeData, listData] = await Promise.all([
      api(`${PROXY}/api/home`),
      api(`${PROXY}/api/list?page=1&order=update`)
    ]);
    d = homeData?.updates?.length ? homeData : listData;
    const totalPages = homeData?.updates?.length ? (listData?.totalPages || 1) : (listData?.totalPages || 1);
    renderCards('update-grid', d?.updates || d?.items);
    paginate('update-pager', 1, totalPages, 'loadUpdateTerbaru');
    return;
  }
  d = await api(`${PROXY}/api/list?page=${pg}&order=update`);
  if (!d?.items?.length) { renderCards('update-grid', null); }
  renderCards('update-grid', d?.items);
  paginate('update-pager', pg, d?.totalPages || 1, 'loadUpdateTerbaru');
}
window.loadUpdateTerbaru = loadUpdateTerbaru;

/* ─────────────────────────────────────────────────────
   HOME
───────────────────────────────────────────────────── */
async function loadHome() {
  const d = await api(`${PROXY}/api/home`);
  if (!d) {
    const feat = $('featured');
    if (feat) feat.innerHTML = retryBox('Gagal memuat data utama.');
    showToast('Gagal memuat data. Coba refresh.');
    return;
  }

  // Featured slider + genre strip
  if (d.featured?.length) initSlider(d.featured);
  renderGenreStrip();

  // Rekomendasi
  updateRekoPerPage();
  _rekoAll = [...(d.featured || []), ...(d.popular || [])];
  const seen = new Set();
  _rekoAll = _rekoAll.filter(m => { if (seen.has(m.slug)) return false; seen.add(m.slug); return true; });
  _rekoOffset = 0;
  renderRekoSlider();

  // Update Terbaru + Terakhir Dibaca (parallel)
  renderHistory();
  loadUpdateTerbaru(1);

  // Popular + Manhwa + Manhua (parallel, don't block each other)
  const pg = $('pop-grid');
  if (pg) {
    if (d.popular?.length) {
      pg.innerHTML = '';
      d.popular.forEach((m, i) => pg.appendChild(buildCard(m, { rank: i + 1 })));
    } else {
      pg.innerHTML = `<div style="grid-column:1/-1">${retryBox('Komik populer gagal dimuat.')}</div>`;
    }
  }

  const loadSection = async (gridId, type) => {
    const g = $(gridId);
    if (!g) return;
    const r = await api(`${PROXY}/api/list?type=${type}&order=popular&page=1`);
    if (r?.items?.length) {
      g.innerHTML = '';
      r.items.slice(0, 12).forEach(m => g.appendChild(buildCard(m)));
    } else {
      g.innerHTML = `<div style="grid-column:1/-1">${retryBox(`Komik ${type} gagal dimuat.`)}</div>`;
    }
  };
  loadSection('manhwa-grid', 'Manhwa');
  loadSection('manhua-grid', 'Manhua');

  renderSidebar(d);
}

/* ─────────────────────────────────────────────────────
   HOME SIDEBAR (Popular Series tabs + New Series + Genre)
───────────────────────────────────────────────────── */
let _wpopData = null;

function renderSidebar(d) {
  _wpopData = d?.popularRanked || {};
  renderWpop('weekly');

  const ns = $('ns-list');
  if (ns) {
    if (d?.newSeries?.length) {
      ns.innerHTML = d.newSeries.map(m => `
        <div class="ns-item" data-slug="${esc(m.slug)}">
          <div class="ns-thumb"><img src="${esc(m.img || '')}" alt="${esc(m.title)}" loading="lazy"
            onload="this.parentElement.classList.add('loaded')"
            onerror="this.onerror=null;this.parentElement.classList.add('noimg','loaded');this.remove()"></div>
          <div class="ns-info">
            <div class="ns-title">${esc(m.title)}</div>
            <div class="ns-meta">${(m.genres || []).map(esc).join(' · ')}${m.year ? ` · ${esc(m.year)}` : ''}</div>
          </div>
        </div>`).join('');
    } else {
      ns.innerHTML = `<div class="sw-empty">Series baru tidak tersedia.</div>`;
    }
  }
  adjustSideSticky();
}

function renderWpop(range) {
  const wrap = $('wpop-list');
  if (!wrap) return;
  const list = _wpopData?.[range] || [];
  wrap.innerHTML = list.length
    ? list.map(m => `
      <div class="wpop-item" data-slug="${esc(m.slug)}">
        <div class="wp-rank${m.rank <= 3 ? ' top' : ''}">${m.rank}</div>
        <div class="wp-thumb"><img src="${esc(m.img || '')}" alt="${esc(m.title)}" loading="lazy"
          onload="this.parentElement.classList.add('loaded')"
          onerror="this.onerror=null;this.parentElement.classList.add('noimg','loaded');this.remove()"></div>
        <div class="wp-info">
          <div class="wp-title">${esc(m.title)}</div>
          ${m.genres?.length ? `<div class="wp-genres">${m.genres.map(esc).join(' · ')}</div>` : ''}
          ${m.score ? `
          <div class="wp-rating">
            <div class="wp-bar"><i style="width:${esc(m.pct || Math.round(parseFloat(m.score) * 10))}%"></i></div>
            <span class="wp-score">★ ${esc(m.score)}</span>
          </div>` : ''}
        </div>
      </div>`).join('')
    : `<div class="sw-empty">Data tidak tersedia.</div>`;
}

$('wpop-tabs')?.addEventListener('click', e => {
  const t = e.target.closest('.wtab');
  if (!t) return;
  $$('#wpop-tabs .wtab').forEach(b => b.classList.remove('active'));
  t.classList.add('active');
  renderWpop(t.dataset.range);
});

// Sidebar item click → detail
$('wpop-list')?.addEventListener('click', e => {
  const it = e.target.closest('.wpop-item');
  if (it?.dataset.slug) openDetail(it.dataset.slug);
});
$('ns-list')?.addEventListener('click', e => {
  const it = e.target.closest('.ns-item');
  if (it?.dataset.slug) openDetail(it.dataset.slug);
});

/* Sticky sidebar: if taller than the viewport, anchor its bottom to the
   viewport bottom instead of its top — so the whole sidebar scrolls into
   view first, then sticks (like komikkita). */
function adjustSideSticky() {
  const side = document.querySelector('.home-side');
  if (!side) return;
  if (window.innerWidth <= 1024) { side.style.top = ''; return; }
  const navH = document.querySelector('#navbar')?.offsetHeight || 0;
  const h = side.offsetHeight;
  const gap = 12;
  const top = Math.min(navH + gap, window.innerHeight - h - gap);
  side.style.top = `${top}px`;
}
window.addEventListener('resize', adjustSideSticky);
window.addEventListener('load', adjustSideSticky);

/* ─────────────────────────────────────────────────────
   GENRE QUICK STRIP (below hero, like komikkita)
───────────────────────────────────────────────────── */
async function renderGenreStrip() {
  const wrap = $('genre-strip-inner');
  if (!wrap) return;

  let list = [];
  const d = await api(`${PROXY}/api/genres`);
  if (d?.genres?.length) list = d.genres;
  else list = GENRES_DEFAULT;

  // Compact: only show a curated shortlist to keep the strip tidy
  const HOT = ['action', 'adventure', 'comedy', 'drama', 'fantasy', 'horror', 'mystery',
    'romance', 'sci-fi', 'slice-of-life', 'supernatural', 'psychological', 'martial-arts', 'isekai'];
  const short = HOT.map(s => list.find(g => g.slug === s)).filter(Boolean);
  const finalList = short.length >= 8 ? short : list.slice(0, 16);

  wrap.innerHTML = finalList.map(g =>
    `<button class="gs-chip" data-gslug="${esc(g.slug)}" data-gname="${esc(g.name)}">${esc(g.name)}</button>`
  ).join('');

  // Sidebar genre widget (full list, like komikkita)
  const side = $('side-genres');
  if (side) {
    side.innerHTML = list.map(g =>
      `<button class="sg-link" data-gslug="${esc(g.slug)}" data-gname="${esc(g.name)}">${esc(g.name)}</button>`
    ).join('');
  }
  adjustSideSticky();
}

$('genre-strip-inner')?.addEventListener('click', e => {
  const chip = e.target.closest('.gs-chip');
  if (chip) loadGenre(chip.dataset.gslug, chip.dataset.gname, 1);
});
$('side-genres')?.addEventListener('click', e => {
  const g = e.target.closest('.sg-link');
  if (g) loadGenre(g.dataset.gslug, g.dataset.gname, 1);
});

/* ─────────────────────────────────────────────────────
   HISTORY
───────────────────────────────────────────────────── */
function getHistory() {
  try { return JSON.parse(localStorage.getItem('kz_history')) || []; }
  catch { return []; }
}

function saveHistory(mangaSlug, title, img, chapterSlug, chapterTitle) {
  let h = getHistory();
  h = h.filter(x => x.mangaSlug !== mangaSlug);
  h.unshift({ mangaSlug, title, img, chapterSlug, chapterTitle, time: Date.now() });
  if (h.length > 15) h = h.slice(0, 15);
  try { localStorage.setItem('kz_history', JSON.stringify(h)); } catch { }
}

function clearHistory() {
  localStorage.removeItem('kz_history');
  renderHistory();
}

function renderHistory() {
  const h = getHistory();
  const blk = $('history-blk');
  const row = $('history-row');
  if (!blk || !row) return;

  if (!h.length) { blk.style.display = 'none'; return; }
  blk.style.display = '';
  row.innerHTML = h.map(x => `
    <div class="hist-card" data-ch="${esc(x.chapterSlug)}">
      <img class="hist-img" src="${esc(x.img || '')}" loading="lazy" onerror="this.onerror=null;this.style.display='none'">
      <div class="hist-info">
        <div class="hist-title">${esc(x.title)}</div>
        <div class="hist-ch">${esc(x.chapterTitle)}</div>
        <div class="hist-time">Dibaca pada ${new Date(x.time).toLocaleDateString('id-ID')}</div>
      </div>
    </div>
  `).join('');
}

$('history-row')?.addEventListener('click', e => {
  const c = e.target.closest('.hist-card');
  if (c?.dataset.ch) openReader(c.dataset.ch, '');
});
$('clear-history')?.addEventListener('click', clearHistory);

/* ─────────────────────────────────────────────────────
   EXPLORE
───────────────────────────────────────────────────── */
async function loadExplore(pg = 1) {
  gridLoading('exp-grid');
  let url = `${PROXY}/api/list?page=${pg}&order=${expSort}`;
  if (expType) url += `&type=${encodeURIComponent(expType)}`;
  const d = await api(url);
  if (!d) {
    $('exp-grid').innerHTML = retryBox('Daftar komik gagal dimuat.');
    $('exp-pager').innerHTML = '';
    return;
  }
  renderCards('exp-grid', d.items, { emptyMsg: 'Tidak ada komik dengan filter ini' });
  paginate('exp-pager', pg, d.totalPages || 1, 'loadExplore');
}
window.loadExplore = loadExplore;

$$('#pg-explore .filt').forEach(b => b.addEventListener('click', () => {
  $$('#pg-explore .filt').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); expType = b.dataset.t; loadExplore(1);
}));
$('exp-sort').addEventListener('change', () => { expSort = $('exp-sort').value; loadExplore(1); });

/* ─────────────────────────────────────────────────────
   TOP
───────────────────────────────────────────────────── */
async function loadTop(pg = 1) {
  gridLoading('top-grid');
  let url = `${PROXY}/api/top?page=${pg}`;
  if (topType) url += `&type=${encodeURIComponent(topType)}`;
  const d = await api(url);
  if (!d) {
    $('top-grid').innerHTML = retryBox('Top komik gagal dimuat.');
    $('top-pager').innerHTML = '';
    return;
  }
  renderCards('top-grid', d.items);
  paginate('top-pager', pg, d.totalPages || 1, 'loadTop');
}
window.loadTop = loadTop;

$$('#pg-top .filt').forEach(b => b.addEventListener('click', () => {
  $$('#pg-top .filt').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); topType = b.dataset.t === 'all' ? '' : b.dataset.t; loadTop(1);
}));

/* ─────────────────────────────────────────────────────
   ALL SERIES
───────────────────────────────────────────────────── */
async function loadAllSeries(pg = 1) {
  gridLoading('all-grid');
  const d = await api(`${PROXY}/api/list?page=${pg}&order=update`);
  if (!d) {
    $('all-grid').innerHTML = retryBox('Daftar seri gagal dimuat.');
    $('all-pager').innerHTML = '';
    return;
  }
  renderCards('all-grid', d.items);
  paginate('all-pager', pg, d.totalPages || 1, 'loadAllSeries');
}
window.loadAllSeries = loadAllSeries;

$$('#pg-allseries .filt').forEach(b => b.addEventListener('click', () => {
  $$('#pg-allseries .filt').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); loadAllSeries(1);
}));

/* ─────────────────────────────────────────────────────
   GENRE PAGE
───────────────────────────────────────────────────── */
async function buildGenreTiles() {
  const grid = $('genre-grid');
  if (!grid) return;

  let list = [];
  const d = await api(`${PROXY}/api/genres`);
  if (d?.genres?.length) list = d.genres;
  else list = GENRES_DEFAULT; // offline fallback

  const iconFor = name => (GENRES_DEFAULT.find(g => g.name.toLowerCase() === name.toLowerCase()) || {}).icon || '📚';

  grid.innerHTML = list.map(g => `
    <div class="genre-tile" data-gslug="${esc(g.slug)}" data-gname="${esc(g.name)}">
      <span class="genre-icon">${iconFor(g.name)}</span>
      <span class="genre-name">${esc(g.name)}</span>
    </div>`).join('');

  grid.onclick = e => {
    const t = e.target.closest('.genre-tile');
    if (t) loadGenre(t.dataset.gslug, t.dataset.gname, 1);
  };
}

async function loadGenre(slug, name, pg = 1) {
  navigate('genreview');
  setUrl(`/genre/${slug}`, `Genre ${name}`);
  const ht = $('genre-view-title');
  if (ht) ht.textContent = name;
  gridLoading('genre-view-grid', 12);
  const d = await api(`${PROXY}/api/genre/${encodeURIComponent(slug)}?page=${pg}`);
  if (!d) {
    $('genre-view-grid').innerHTML = retryBox(`Komik genre "${name}" gagal dimuat.`);
    $('genre-view-pager').innerHTML = '';
    return;
  }
  renderCards('genre-view-grid', d.items);
  paginate('genre-view-pager', pg, d.totalPages || 1, 'loadGenreCb');
}
window.loadGenreCb = (pg) => loadGenre(gSlug, gName, pg);

let gSlug = '', gName = '';

/* ─────────────────────────────────────────────────────
   DETAIL PAGE
───────────────────────────────────────────────────── */
async function openDetail(slug) {
  if (!slug) return;
  prevPg = curPg;
  navigate('detail');
  setUrl(`/manga/${slug}`);
  const root = $('detail-root');
  root.innerHTML = `<div class="detail-loading"><div class="spin"></div><p>Memuat detail komik…</p></div>`;

  const d = await api(`${PROXY}/api/manga/${encodeURIComponent(slug)}`);
  if (!d || !d.title) {
    root.innerHTML = `<div class="empty-box" style="padding:5rem">
      <div class="ei">😢</div><div class="et">Gagal memuat komik</div>
      <div class="es">Sumber data mungkin sibuk. Silakan coba lagi.</div>
      <button class="btn-primary" style="margin-top:1rem" onclick="openDetail('${esc(slug)}')">🔄 Coba Lagi</button>
      <button class="btn-primary" style="margin-top:1rem;background:transparent;color:inherit" onclick="goBack()">← Kembali</button>
    </div>`;
    return;
  }

  const scCol = '#a855f7';
  const syn = d.synopsis || 'Sinopsis tidak tersedia.';
  setUrl(`/manga/${slug}`, d.title);

  root.innerHTML = `
    <button class="detail-back" onclick="goBack()">← Kembali</button>

    <div class="d-hero">
      <div class="d-bg" style="background-image:url('${esc(d.img || '')}')"></div>
      <div class="d-fog"></div>
      <div class="d-wrap">
        <img class="d-cover" src="${esc(d.img || '')}" alt="${esc(d.title)}" loading="lazy"
          onerror="this.onerror=null;this.style.display='none'">
        <div class="d-info">
          <h1 class="d-title">${esc(d.title)}</h1>
          ${d.altTitle ? `<div class="d-alt">${esc(d.altTitle)}</div>` : ''}
          <div class="d-tags">
            ${d.type ? `<span class="tag t-${esc(d.type.toLowerCase())}">${esc(d.type)}</span>` : ''}
            ${d.status ? `<span class="tag ${d.status.toLowerCase().includes('ongoing') ? 't-on' : 't-end'}">${esc(d.status)}</span>` : ''}
            ${(d.genres || []).slice(0, 3).map(g => `<span class="tag t-genre">${esc(g)}</span>`).join('')}
          </div>
          <div class="d-stats">
            ${d.score ? `<div class="d-stat"><div class="d-val sc" style="color:${scCol}">★ ${esc(d.score)}</div><div class="d-lbl-s">Score</div></div>` : ''}
            ${(d.chapters || []).length ? `<div class="d-stat"><div class="d-val">${d.chapters.length}</div><div class="d-lbl-s">Chapter</div></div>` : ''}
          </div>
          <div class="d-btns">
            <button class="btn-primary" id="d-read-btn"></button>
            <button class="btn-ghost" id="d-latest-btn">Baca Chapter Terbaru</button>
          </div>
        </div>
      </div>
    </div>

    ${AD_SLOT_LB}

    <div class="d-body">
      <div>
        <div class="d-synopsis"><h3>Sinopsis</h3><p>${esc(syn)}</p></div>
        ${(d.genres || []).length ? `
        <div class="d-genre-tags">
          ${d.genres.map(g => `<span class="d-gtag" data-gslug="${esc(g.toLowerCase().replace(/\s+/g, '-'))}" data-gname="${esc(g)}">${esc(g)}</span>`).join('')}
        </div>` : ''}
      </div>
      <div class="d-card">
        <h3>Informasi</h3>
        ${dRow('Tipe', d.type)}
        ${dRow('Status', d.status)}
        ${dRow('Author', d.author)}
        ${dRow('Score', d.score)}
      </div>
    </div>

    <!-- Slot iklan -->
    ${AD_SLOT_LB}

    <!-- Chapter list -->
    <div class="ch-section" id="ch-section">
      <h3><span>📚 Daftar Chapter</span></h3>
      <div class="ch-list" id="ch-list">
        ${buildChapterList(d.chapters || [], slug)}
      </div>
    </div>`;

  // Wire up interactions
  // Tombol utama: "Lanjut Baca" bila pengunjung punya riwayat, selain itu
  // "Baca Chapter Awal". Tombol kedua selalu "Baca Chapter Terbaru".
  const readBtn = $('d-read-btn');
  const latestBtn = $('d-latest-btn');
  const chaptersArr = d.chapters || [];
  if (!chaptersArr.length) {
    readBtn.textContent = 'Tidak Ada Chapter';
    readBtn.disabled = true;
    readBtn.style.opacity = '.4';
    latestBtn.style.display = 'none';
  } else {
    const hist = getHistory().find(x => x.mangaSlug === slug);
    const hIdx = hist ? chaptersArr.findIndex(c => c.slug === hist.chapterSlug) : -1;
    if (hIdx >= 0) {
      // Chapter terakhir selesai dibaca (sampai bawah) & masih ada yang lebih
      // baru → lanjut ke chapter berikutnya; kalau berhenti di tengah, buka lagi chapter itu
      const target = (hist.done && hIdx > 0) ? hIdx - 1 : hIdx;
      readBtn.textContent = `▶ Lanjut Baca ${chaptersArr[target].title || 'Chapter'}`;
      readBtn.onclick = () => openReader(chaptersArr[target].slug, d.title);
    } else {
      // Daftar chapter terbaru-dulu: chapter awal ada di index terakhir
      readBtn.textContent = '📖 Baca Chapter Awal';
      readBtn.onclick = () => openReader(chaptersArr[chaptersArr.length - 1].slug, d.title);
    }
    latestBtn.onclick = () => openReader(chaptersArr[0].slug, d.title);
  }
  root.querySelectorAll('.d-gtag').forEach(t => t.addEventListener('click', () =>
    loadGenre(t.dataset.gslug, t.dataset.gname, 1)));

  _curChapters = (d.chapters || []).map(c => ({ slug: c.slug, title: c.title, date: c.date }));
  _curTitle = d.title;
  _curImg = d.img;
  _curMangaSlug = slug;
}

function dRow(l, v) {
  if (!v || v === '-') return '';
  return `<div class="d-row"><span class="d-rl">${esc(l)}</span><span class="d-rv">${esc(v)}</span></div>`;
}

/* Slot iklan placeholder (728x90 desktop / 320x50 mobile) */
const AD_SLOT_LB = `<div class="ad-slot">
  <div class="ad-box ad-728">Slot iklan tersedia. <a href="mailto:dknimelol@gmail.com">Hubungi dknimelol@gmail.com</a></div>
</div>`;

// Build chapter list with range tabs (Ch 1–50, 51–100, etc.)
// Server returns newest first, so we reverse to show Ch 1 at top
function buildChapterList(chapters, mangaSlug) {
  if (!chapters.length) return `<div class="ch-empty">📭 Belum ada chapter tersedia.</div>`;

  const key = (mangaSlug || '_cur').replace(/[^a-z0-9-]/gi, '');
  const sorted = [...chapters].reverse(); // oldest → newest

  const renderItem = (c) => `
    <div class="ch-item" data-ch="${esc(c.slug)}">
      <span class="ch-num">${esc(c.title || 'Chapter')}</span>
      <span class="ch-title-txt"></span>
      <span class="ch-date">${esc(c.date || '')}</span>
      <button class="ch-read-btn">📖 Baca</button>
    </div>`;

  const RANGE = 50;
  const totalRanges = Math.ceil(sorted.length / RANGE);

  if (totalRanges <= 1) {
    return `<div class="ch-range-panel" id="chr-${key}-0">${sorted.map(renderItem).join('')}</div>`;
  }

  const tabs = Array.from({ length: totalRanges }, (_, i) => {
    const start = i * RANGE + 1;
    const end = Math.min((i + 1) * RANGE, sorted.length);
    return `<button class="ch-range-btn${i === 0 ? ' active' : ''}" data-rkey="${key}" data-ridx="${i}">Ch ${start}–${end}</button>`;
  }).join('');

  const panels = Array.from({ length: totalRanges }, (_, i) =>
    `<div class="ch-range-panel${i === 0 ? '' : ' hidden'}" id="chr-${key}-${i}">${sorted.slice(i * RANGE, (i + 1) * RANGE).map(renderItem).join('')}</div>`
  ).join('');

  return `<div class="ch-range-tabs" id="chrt-${key}">${tabs}</div>${panels}`;
}

// Delegated: chapter range tabs + chapter items
document.addEventListener('click', e => {
  const tab = e.target.closest('.ch-range-btn');
  if (tab) {
    const key = tab.dataset.rkey, idx = tab.dataset.ridx;
    document.querySelectorAll(`[id^="chr-${key}-"]`).forEach(el => el.classList.add('hidden'));
    $(`chr-${key}-${idx}`)?.classList.remove('hidden');
    const tabBar = document.getElementById(`chrt-${key}`);
    tabBar?.querySelectorAll('.ch-range-btn').forEach((b, i) => b.classList.toggle('active', String(i) === String(idx)));
    return;
  }
  const item = e.target.closest('.ch-item');
  if (item?.dataset.ch) openReader(item.dataset.ch, _curTitle);
});

/* ─────────────────────────────────────────────────────
   READER
───────────────────────────────────────────────────── */
let _curChapters = [];
let _curTitle = '';
let _curImg = '';
let _curMangaSlug = '';
let _rChIdx = 0;
let _chReadCount = parseInt(localStorage.getItem('kz_ch_read') || '0');

/** Tandai chapter terakhir yang dibaca sebagai selesai (scroll sampai bawah).
 *  Dipakai tombol "Lanjut Baca" di halaman detail untuk melompat ke chapter
 *  berikutnya, bukan mengulang chapter yang sudah tamat dibaca. */
function markChapterDone() {
  if (!_curMangaSlug) return;
  const h = getHistory();
  const e = h.find(x => x.mangaSlug === _curMangaSlug);
  if (e && !e.done) {
    e.done = true;
    try { localStorage.setItem('kz_history', JSON.stringify(h)); } catch { }
  }
}

/* Auto-next: saat scroll mentok di paling bawah reader, otomatis lanjut ke
   chapter berikutnya setelah jeda singkat (bisa dibatalkan dengan scroll balik
   ke atas). Tombol next manual tetap ada. */
let _rAutoTimer = null;
let _rMaxScroll = 0;

function readerAutoNext() {
  if (curPg !== 'reader' || _rChIdx <= 0) return; // tidak ada chapter berikutnya
  if (!$('reader-pages').querySelector('.r-page img')) return; // gambar belum termuat
  _rMaxScroll = Math.max(_rMaxScroll, window.scrollY);
  // Butuh scroll sungguhan dulu — mencegah auto-next berantai di chapter pendek
  if (_rMaxScroll <= 200) return;
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
  if (atBottom) {
    if (_rAutoTimer) return;
    showToast('Lanjut ke chapter berikutnya…', 500);
    _rAutoTimer = setTimeout(() => {
      _rAutoTimer = null;
      hideToast(); // hilang tepat saat pindah chapter
      goReaderChapter(-1);
    }, 1500);
  } else if (_rAutoTimer) {
    clearTimeout(_rAutoTimer);
    _rAutoTimer = null;
  }
}

async function openReader(chSlug, title) {
  if (!chSlug) return;
  navigate('reader');
  setUrl(`/chapter/${chSlug}`);

  const pages = $('reader-pages');
  pages.innerHTML = `<div class="reader-loading"><div class="spin"></div><p>Memuat data chapter…</p></div>`;

  // If _curChapters is empty (opened from history/cards without visiting detail),
  // the chapter response carries the manga's chapter list + metadata — no guessing.
  let chData = null;
  if (!_curChapters.length && chSlug) {
    chData = await api(`${PROXY}/api/chapter?slug=${encodeURIComponent(chSlug)}`);
    if (chData?.chapters?.length) {
      _curChapters = chData.chapters.map(c => ({ slug: c.slug, title: c.title, date: c.date }));
      _curMangaSlug = chData.mangaSlug || '';
      if (!_curTitle) _curTitle = chData.mangaTitle || title || '';
      if (!_curImg) _curImg = chData.img || '';
    }
  }

  _rChIdx = _curChapters.findIndex(c => c.slug === chSlug);
  if (_rChIdx < 0) _rChIdx = 0;

  const ch = _curChapters[_rChIdx] || { slug: chSlug, title: 'Chapter' };
  $('r-title').textContent = `${title || _curTitle || ''} — ${ch.title || 'Chapter'}`;
  document.title = `${title || _curTitle || ''} ${ch.title || ''}`.trim() + ' – KomikZone';

  if (_curMangaSlug && ch.slug) {
    saveHistory(_curMangaSlug, _curTitle, _curImg, ch.slug, ch.title || 'Chapter');
  }

  // Counter 15 chapter
  _chReadCount++;
  try { localStorage.setItem('kz_ch_read', _chReadCount.toString()); } catch { }
  if (_chReadCount % 15 === 0) showTrakteerPopup();

  pages.innerHTML = `<div class="reader-loading"><div class="spin"></div><p>Memuat gambar chapter…</p></div>`;

  const d = chData || await api(`${PROXY}/api/chapter?slug=${encodeURIComponent(chSlug)}`);
  const imgs = d?.images || [];

  if (!imgs.length) {
    pages.innerHTML = `<div class="reader-error">
      <span class="ei">😢</span>
      <h3>Gambar tidak tersedia</h3>
      <p>Chapter ini belum bisa dimuat. Coba lagi atau pilih chapter lain.</p>
      <div style="display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap">
        <button class="btn-primary" onclick="openReader('${esc(chSlug)}','${esc(title || _curTitle || '')}')">🔄 Coba Lagi</button>
        <button class="btn-primary" style="background:transparent;color:inherit" onclick="navigate('detail')">← Kembali ke Detail</button>
      </div>
    </div>`;
    return;
  }

  let pagesHtml = '';
  imgs.forEach((src, i) => {
    pagesHtml += `<div class="r-page">
      <img src="${esc(src)}" alt="Halaman ${i + 1}" loading="${i < 3 ? 'eager' : 'lazy'}">
    </div>`;
    // Slot iklan sisipan tiap 12 halaman (jangan tepat di paling akhir)
    if ((i + 1) % 12 === 0 && i < imgs.length - 2) pagesHtml += AD_SLOT_LB;
  });
  pages.innerHTML = pagesHtml;

  // Slot iklan di bawah halaman terakhir
  pages.insertAdjacentHTML('beforeend', AD_SLOT_LB);

  // Placeholder while each image loads; swap to error msg on failure
  let loaded = 0;
  pages.querySelectorAll('.r-page img').forEach(img => {
    const pageEl = img.parentElement;
    img.addEventListener('load', () => { loaded++; img.classList.add('loaded'); });
    img.addEventListener('error', () => {
      img.remove();
      pageEl.innerHTML = `<div class="r-page-err" data-retry="${esc(img.src)}">⚠️ Gagal memuat halaman ini. <span class="r-retry" role="button">Coba lagi</span></div>`;
    });
  });

  updateReaderNav();
  if (_rAutoTimer) { clearTimeout(_rAutoTimer); _rAutoTimer = null; }
  _rMaxScroll = 0;
  window.scrollTo({ top: 0 });
}

function updateReaderNav() {
  const n = _curChapters.length;
  // Tampilkan nomor chapter sebenarnya, bukan posisi index
  // (daftar terbaru-dulu: chapter 1 ada di index terakhir)
  const num = (_curChapters[_rChIdx]?.title || '').match(/[\d.]+/);
  $('r-ch-info').textContent = num ? `${num[0]} / ${n}` : `${_rChIdx + 1} / ${n}`;
  // Daftar chapter terbaru-dulu (idx 0 = chapter terbaru):
  // "Berikutnya" = nomor lebih tinggi = idx-1, "Sebelumnya" = idx+1
  $('r-next-ch').disabled = _rChIdx <= 0;
  $('r-prev-ch').disabled = _rChIdx >= n - 1;
}

function goReaderChapter(delta) {
  const newIdx = _rChIdx + delta;
  if (newIdx < 0 || newIdx >= _curChapters.length) return;
  if (delta < 0) markChapterDone(); // maju ke chapter berikutnya = chapter ini selesai
  _rChIdx = newIdx;
  const ch = _curChapters[_rChIdx];
  openReader(ch.slug, _curTitle);
}

$('r-back').addEventListener('click', () => { if (_navPushed) history.back(); else navigate('detail'); });
$('r-prev-ch').addEventListener('click', () => goReaderChapter(+1));
$('r-next-ch').addEventListener('click', () => goReaderChapter(-1));

// Retry a single failed reader page
$('reader-pages').addEventListener('click', e => {
  const errBox = e.target.closest('.r-page-err');
  if (!errBox) return;
  const src = errBox.dataset.retry;
  errBox.innerHTML = `<img src="${esc(src)}" alt="Halaman">`;
  const img = errBox.querySelector('img');
  img.addEventListener('error', () => {
    errBox.innerHTML = `<div class="r-page-err" data-retry="${esc(src)}">⚠️ Gagal memuat halaman ini. <span class="r-retry" role="button">Coba lagi</span></div>`;
  });
});

let _rFitWide = false;
$('r-fit-toggle').addEventListener('click', () => {
  _rFitWide = !_rFitWide;
  $('reader-pages').classList.toggle('wide', _rFitWide);
  $('r-fit-toggle').classList.toggle('active', _rFitWide);
  $('r-fit-toggle').textContent = _rFitWide ? '⇔ Kompak' : '⇔ Lebar';
});

/* ─────────────────────────────────────────────────────
   SEARCH
───────────────────────────────────────────────────── */
let _st = null;

$('q').addEventListener('input', () => {
  clearTimeout(_st);
  const v = $('q').value.trim();
  if (v.length < 2) { $('search-drop').classList.remove('open'); return; }
  _st = setTimeout(() => doSearch(v), 450);
});

$('q').addEventListener('focus', () => {
  if ($('q').value.trim().length >= 2) $('search-drop').classList.add('open');
});

document.addEventListener('click', e => {
  if (!e.target.closest('.nav-search')) $('search-drop').classList.remove('open');
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault(); $('q').focus(); $('q').select();
  }
  if (e.key === 'Escape') {
    $('search-drop').classList.remove('open');
    $('q').blur();
  }
});

async function doSearch(q) {
  const dd = $('search-drop');
  dd.innerHTML = `<div style="padding:.85rem;text-align:center">
    <div class="spin" style="width:22px;height:22px;margin:0 auto"></div></div>`;
  dd.classList.add('open');

  const d = await api(`${PROXY}/api/search?q=${encodeURIComponent(q)}`);
  if (!d) {
    dd.innerHTML = `<div style="padding:.85rem;text-align:center;font-size:.8rem;color:#555">Pencarian gagal. Coba lagi.</div>`;
    return;
  }
  if (!d.items?.length) {
    dd.innerHTML = `<div style="padding:.85rem;text-align:center;font-size:.8rem;color:#555">Tidak ditemukan</div>`;
    return;
  }
  dd.innerHTML = d.items.map(m => `
    <div class="sd-row" data-slug="${esc(m.slug)}">
      ${m.img ? `<img class="sd-img" src="${esc(m.img)}" alt="${esc(m.title)}">` : '<div class="sd-img"></div>'}
      <div style="flex:1;min-width:0">
        <div class="sd-name">${esc(m.title)}</div>
        <div class="sd-sub">${esc(m.type || '')}</div>
      </div>
      ${m.score ? `<div class="sd-sc">⭐ ${esc(m.score)}</div>` : ''}
    </div>`).join('');

  dd.querySelectorAll('.sd-row').forEach(row => row.addEventListener('click', () => {
    dd.classList.remove('open');
    $('q').value = '';
    openDetail(row.dataset.slug);
  }));
}

/* ─────────────────────────────────────────────────────
   NAVIGATION & PAGES
───────────────────────────────────────────────────── */
const PAGE_CONTENT = {
  'disclaimer': {
    title: 'Disclaimer',
    html: `<p>Semua komik di website ini hanya preview dari komik aslinya, mungkin terdapat banyak kesalahan bahasa, nama tokoh, dan alur cerita. Untuk versi aslinya, silahkan beli komiknya jika sudah tersedia di kotamu.</p><p>KomikZone meng-host semua file dan gambar di server sendiri untuk memberikan pengalaman membaca yang cepat dan stabil.</p>`
  },
  'privacy': {
    title: 'Privacy Policy',
    html: `<p>KomikZone sangat menghargai privasi Anda. Kami tidak mengumpulkan, menyimpan, atau membagikan data pribadi Anda.</p><p>Data riwayat seperti "Terakhir Dibaca" dan preferensi tampilan sepenuhnya disimpan secara lokal di perangkat Anda (Local Storage) dan tidak dikirimkan ke server kami.</p>`
  },
  'about': {
    title: 'About KomikZone',
    html: `<p>KomikZone adalah platform baca komik online (Manga, Manhwa, Manhua) gratis yang dirancang dengan antarmuka yang modern, cepat, dan <b>bebas dari pop-up iklan yang mengganggu</b>.</p><p>Kami berdedikasi untuk memberikan pengalaman membaca komik terbaik bagi pembaca di Indonesia.</p>`
  },
  'kontak': {
    title: 'Kontak Kami',
    html: `<p>Jika Anda memiliki pertanyaan, laporan bug, saran, maupun permohonan takedown terkait hak cipta, jangan ragu untuk menghubungi kami melalui:</p><ul><li>Email: <a href="mailto:dknimelol@gmail.com">dknimelol@gmail.com</a></li></ul><p>Kami akan berusaha merespons dalam waktu 2x24 jam.</p>`
  }
};

function showPage(id) {
  const data = PAGE_CONTENT[id];
  if (!data) return;
  const t = $('text-page-title');
  const c = $('text-page-content');
  if (t) t.textContent = data.title;
  if (c) c.innerHTML = data.html;
  setUrl(`/p/${id}`, data.title);
  navigate('page');
}

function navigate(name) {
  if (name === curPg && name !== 'detail' && name !== 'reader' && name !== 'genreview' && name !== 'page') return;
  $$('.pg').forEach(p => p.classList.remove('active'));
  $(`pg-${name}`)?.classList.add('active');

  const reading = name === 'reader';
  const bnav = document.querySelector('.bnav');
  if (bnav) bnav.style.display = reading ? 'none' : '';
  document.querySelector('.navbar').style.display = reading ? 'none' : '';
  $('main').style.paddingTop = reading ? '0' : '';

  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
  curPg = name;
  window.scrollTo({ top: 0 });
  $('mmenu')?.classList.remove('open');

  // Refresh "Terakhir Dibaca" setiap kali kembali ke home (history tersimpan saat baca)
  if (name === 'home') renderHistory();

  if (name === 'explore' && !$('exp-grid').children.length) loadExplore(1);
  if (name === 'top' && !$('top-grid').children.length) loadTop(1);
  if (name === 'allseries' && !$('all-grid').children.length) loadAllSeries(1);
  if (name === 'genre' && !$('genre-grid').children.length) buildGenreTiles();

  // URL + judul tab untuk halaman utama (detail/reader/genre diatur sendiri)
  if (PAGE_PATHS[name]) setUrl(PAGE_PATHS[name].path, PAGE_PATHS[name].title);
}

document.addEventListener('click', e => {
  const a = e.target.closest('[data-nav]');
  if (!a) return;
  e.preventDefault();
  navigate(a.dataset.nav);
});

$('hamburger').addEventListener('click', () => { $('mmenu').classList.toggle('open'); });

$('notice-close').addEventListener('click', () => { $('notice-bar').classList.add('gone'); });

const isMobile = () => window.innerWidth <= 768;

window.addEventListener('scroll', () => {
  $('navbar').classList.toggle('solid', scrollY > 40);
  if (isMobile()) {
    $('btt').classList.toggle('show', scrollY > 300);
  } else {
    $('btt').classList.remove('show');
  }
  readerAutoNext();
});
$('btt').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

/* ─────────────────────────────────────────────────────
   TRAKTEER POPUP
───────────────────────────────────────────────────── */
function showTrakteerPopup() {
  const popup = $('trakteer-popup');
  if (popup) popup.classList.add('show');
}

function initPopup() {
  const popup = $('trakteer-popup');
  if (!popup) return;

  // Muncul maksimal 1x per 24 jam — overlay full-screen memblokir semua
  // klik (termasuk filter), jadi jangan dimunculkan di setiap load.
  const KEY = 'kz_popup_last';
  const DAY = 24 * 60 * 60 * 1000;
  let last = 0;
  try { last = +(localStorage.getItem(KEY) || 0); } catch {}
  if (Date.now() - last < DAY) return;

  setTimeout(() => {
    showTrakteerPopup();
    try { localStorage.setItem(KEY, String(Date.now())); } catch {}
  }, 3000);

  const hide = () => popup.classList.remove('show');
  $('popup-close')?.addEventListener('click', hide);
  $('popup-btn')?.addEventListener('click', hide);
  popup.addEventListener('click', e => { if (e.target === popup) hide(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
}

/* ─────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────── */
(async () => {
  initPopup();
  // Restore halaman dari URL (direct load / back dari Google / share link)
  routeFromPath();
  try {
    await loadHome();
  } catch (err) {
    console.error('Init error:', err);
    showToast('Gagal memuat data. Coba refresh halaman.');
  }
})();
