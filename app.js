/* =====================================================
   KomikZone – app.js
   Data source: KomikKita.com  via local proxy :3001
   ===================================================== */

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const PROXY = isLocal ? 'http://localhost:3001' : '';

/* ── simple fetch with cache ── */
const _apiCache = new Map();
async function api(url) {
  if (_apiCache.has(url)) return _apiCache.get(url);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    _apiCache.set(url, d);
    return d;
  } catch(e) { console.warn('API err:', url, e); return null; }
}

/* ── DOM helpers ── */
const $  = id => document.getElementById(id);
const $$ = s  => [...document.querySelectorAll(s)];

function showToast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 2800);
}

/* ── State ── */
let curPg  = 'home';
let prevPg = 'home';

let expPage = 1, expSort = 'update', expType = '', expStatus = '';
let topPage = 1, topType = '';
let allPage = 1;
let gSlug = '', gName = '', gPage = 1;

let slideIdx = 0, slideN = 0, slideTimer = null;

/* ── Genre list (from KomikKita) ── */
const GENRES_DEFAULT = [
  { name:'Action',      slug:'action',       icon:'⚔️' },
  { name:'Adventure',   slug:'adventure',    icon:'🗺️' },
  { name:'Comedy',      slug:'comedy',       icon:'😄' },
  { name:'Drama',       slug:'drama',        icon:'🎭' },
  { name:'Fantasy',     slug:'fantasy',      icon:'🧙' },
  { name:'Horror',      slug:'horror',       icon:'👻' },
  { name:'Mystery',     slug:'mystery',      icon:'🔍' },
  { name:'Romance',     slug:'romance',      icon:'💕' },
  { name:'Sci-Fi',      slug:'sci-fi',       icon:'🚀' },
  { name:'Slice of Life',slug:'slice-of-life',icon:'🌸' },
  { name:'Shounen',     slug:'shounen',      icon:'🔥' },
  { name:'Seinen',      slug:'seinen',       icon:'🗡️' },
  { name:'Josei',       slug:'josei',        icon:'💐' },
  { name:'Shoujo',      slug:'shoujo',       icon:'🌷' },
  { name:'Manhwa',      slug:'manhwa',       icon:'🇰🇷' },
  { name:'Manhua',      slug:'manhua',       icon:'🇨🇳' },
  { name:'Isekai',      slug:'isekai',       icon:'🌀' },
  { name:'Martial Arts',slug:'martial-arts', icon:'🥋' },
  { name:'Supernatural',slug:'supernatural', icon:'👁️' },
  { name:'Psychological',slug:'psychological',icon:'🧠' },
];

/* ─────────────────────────────────────────────────────
   CARD BUILDERS
───────────────────────────────────────────────────── */
function buildCard(m) {
  const el = document.createElement('div');
  el.className = 'komik-card';
  el.onclick = () => openDetail(m.slug);

  const typeLabel = m.type ? `<span class="kc-type tag t-${(m.type||'').toLowerCase()}">${m.type}</span>` : '';
  const score     = m.score ? `<div class="kc-score">★ ${m.score}</div>` : '';
  const latCh     = m.latestChapter ? `<div class="kc-vol">${m.latestChapter}</div>` : '';

  el.innerHTML = `
    <div class="kc-thumb">
      <img class="kc-img" src="${m.img||''}" alt="${m.title||''}" loading="lazy"
        onerror="this.src='';this.parentElement.innerHTML='<div class=no-img>📚<br>${(m.title||'').slice(0,12)}</div>'">
      ${typeLabel}${score}
      <div class="kc-ov"><div class="kc-play">▶</div></div>
    </div>
    <div class="kc-body">
      <div class="kc-title">${m.title||'Tanpa Judul'}</div>
      <div class="kc-foot">${latCh}</div>
    </div>`;
  return el;
}

function buildUpdateRow(m, i) {
  const el = document.createElement('div');
  el.className = 'update-row';

  const typeLabel = m.type ? `<span class="up-type-badge t-${(m.type||'').toLowerCase()}">${m.type}</span>` : '';
  const chapters  = (m.chapters||[]).slice(0,3).map(c => `
    <div class="up-ch" onclick="event.stopPropagation();openReader('${c.slug}','${(m.title||'').replace(/'/g,"\\'")}')">
      <span class="up-ch-num">${c.title}</span>
      <span class="up-ch-time">${c.date||''}</span>
    </div>`).join('');

  el.innerHTML = `
    <img class="up-thumb" src="${m.img||''}" alt="${m.title||''}" loading="lazy"
      onerror="this.src='';this.alt='📚'">
    <div class="up-info">
      ${typeLabel}
      <div class="up-title">${m.title||''}</div>
      <div class="up-chapters">${chapters}</div>
    </div>`;
  el.onclick = () => openDetail(m.slug);
  return el;
}

function renderCards(gridId, items) {
  const g = $(gridId);
  if (!g) return;
  g.innerHTML = '';
  if (!items || !items.length) {
    g.innerHTML = `<div class="empty-box" style="padding:3rem">
      <div class="ei">😕</div><div class="et">Tidak ada komik</div></div>`;
    return;
  }
  items.forEach(m => g.appendChild(buildCard(m)));
}

function gridLoading(gridId) {
  const g = $(gridId);
  if (!g) return;
  const skel = `<div class="skel-card"><div class="skel-img"></div>
    <div class="kc-body"><div class="skel-line"></div><div class="skel-line s"></div></div></div>`;
  g.innerHTML = skel.repeat(8);
}

function paginate(pagerId, curPage, total, fn) {
  const p = $(pagerId);
  if (!p) return;
  const pages = [];
  for (let i = 1; i <= Math.min(total, 20); i++) {
    pages.push(`<button class="page-btn${i===curPage?' active':''}" onclick="(${fn.toString()})(${i})">${i}</button>`);
  }
  p.innerHTML = pages.join('');
}

/* ─────────────────────────────────────────────────────
   SLIDER
───────────────────────────────────────────────────── */
function initSlider(items) {
  const sl  = $('feat-slides');
  const dot = $('feat-dots');
  if (!sl || !items.length) return;

  slideN = items.length;
  sl.innerHTML = items.map((m, i) => `
    <div class="feat-slide" data-i="${i}" onclick="openDetail('${m.slug}')">
      <div class="feat-bg" style="background-image:url('${m.img||''}')"></div>
      <div class="feat-overlay"></div>
      <div class="feat-body">
        <img class="feat-cover" src="${m.img||''}" alt="${m.title||''}" loading="${i===0?'eager':'lazy'}">
        <div class="feat-info">
          <div class="feat-tags">${(m.genres||[]).slice(0,3).map(g=>`<span class="tag">${g}</span>`).join('')}</div>
          <h2 class="feat-title">${m.title||''}</h2>
          <div class="feat-btns">
            <button class="btn-primary" onclick="event.stopPropagation();openDetail('${m.slug}')">📖 Baca</button>
          </div>
        </div>
      </div>
    </div>`).join('');

  dot.innerHTML = items.map((_, i) =>
    `<button class="fdot${i===0?' on':''}" onclick="goSlide(${i})"></button>`).join('');

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

/* ─────────────────────────────────────────────────────
   HOME
───────────────────────────────────────────────────── */
async function loadHome() {
  const d = await api(`${PROXY}/api/home`);
  if (!d) { showToast('Gagal memuat data. Coba refresh.'); return; }

  // Featured slider
  if (d.featured?.length) initSlider(d.featured);

  // Update terbaru (max 4)
  const ug = $('update-grid');
  if (ug) {
    ug.innerHTML = '';
    (d.updates || []).slice(0, 4).forEach((m, i) => ug.appendChild(buildUpdateRow(m, i)));
  }

  // Terakhir Dibaca
  renderHistory();

  // Popular
  const pg = $('pop-grid');
  if (pg) {
    pg.innerHTML = '';
    (d.popular || []).forEach(m => pg.appendChild(buildCard(m)));
  }

  // Manhwa / Manhua — load from explore
  const mhw = await api(`${PROXY}/api/list?type=Manhwa&order=popular&page=1`);
  const mhg = $('manhwa-grid');
  if (mhg) { mhg.innerHTML = ''; (mhw?.items||[]).slice(0,8).forEach(m => mhg.appendChild(buildCard(m))); }

  const mhu = await api(`${PROXY}/api/list?type=Manhua&order=popular&page=1`);
  const mug = $('manhua-grid');
  if (mug) { mug.innerHTML = ''; (mhu?.items||[]).slice(0,8).forEach(m => mug.appendChild(buildCard(m))); }
}

/* ─────────────────────────────────────────────────────
   HISTORY
───────────────────────────────────────────────────── */
function getHistory() {
  try { return JSON.parse(localStorage.getItem('kz_history')) || []; }
  catch(e) { return []; }
}

function saveHistory(mangaSlug, title, img, chapterSlug, chapterTitle) {
  let h = getHistory();
  h = h.filter(x => x.mangaSlug !== mangaSlug);
  h.unshift({ mangaSlug, title, img, chapterSlug, chapterTitle, time: Date.now() });
  if (h.length > 15) h = h.slice(0, 15);
  localStorage.setItem('kz_history', JSON.stringify(h));
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
  
  if (!h.length) {
    blk.style.display = 'none';
    return;
  }
  
  blk.style.display = '';
  row.innerHTML = h.map(x => `
    <div class="hist-card" onclick="openReader('${x.chapterSlug}','${x.title.replace(/'/g,"\\'")}')">
      <img class="hist-img" src="${x.img||''}" loading="lazy" onerror="this.src=''">
      <div class="hist-info">
        <div class="hist-title">${x.title}</div>
        <div class="hist-ch">${x.chapterTitle}</div>
        <div class="hist-time">Dibaca pada ${new Date(x.time).toLocaleDateString('id-ID')}</div>
      </div>
    </div>
  `).join('');
}

$('clear-history')?.addEventListener('click', clearHistory);

/* ─────────────────────────────────────────────────────
   EXPLORE
───────────────────────────────────────────────────── */
async function loadExplore(pg = 1) {
  expPage = pg;
  gridLoading('exp-grid');
  let url = `${PROXY}/api/list?page=${pg}&order=${expSort}`;
  if (expType)   url += `&type=${encodeURIComponent(expType)}`;
  if (expStatus) url += `&status=${encodeURIComponent(expStatus)}`;
  const d = await api(url);
  renderCards('exp-grid', d?.items);
  paginate('exp-pager', pg, d?.totalPages||1, p => loadExplore(p));
}

$$('#pg-explore .filt').forEach(b => b.addEventListener('click', () => {
  $$('#pg-explore .filt').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); expType = b.dataset.t; loadExplore(1);
}));
$('exp-sort').addEventListener('change', () => { expSort = $('exp-sort').value; loadExplore(1); });
$('exp-status').addEventListener('change', () => { expStatus = $('exp-status').value; loadExplore(1); });

/* ─────────────────────────────────────────────────────
   TOP
───────────────────────────────────────────────────── */
async function loadTop(pg = 1) {
  topPage = pg;
  gridLoading('top-grid');
  let url = `${PROXY}/api/top?page=${pg}`;
  if (topType) url += `&type=${encodeURIComponent(topType)}`;
  const d = await api(url);
  renderCards('top-grid', d?.items);
  paginate('top-pager', pg, d?.totalPages||1, p => loadTop(p));
}

$$('#pg-top .filt').forEach(b => b.addEventListener('click', () => {
  $$('#pg-top .filt').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); topType = b.dataset.t === 'all' ? '' : b.dataset.t; loadTop(1);
}));

/* ─────────────────────────────────────────────────────
   ALL SERIES
───────────────────────────────────────────────────── */
async function loadAllSeries(pg = 1) {
  allPage = pg;
  gridLoading('all-grid');
  const d = await api(`${PROXY}/api/list?page=${pg}&order=title`);
  renderCards('all-grid', d?.items);
  paginate('all-pager', pg, d?.totalPages||1, p => loadAllSeries(p));
}

$$('#pg-allseries .filt').forEach(b => b.addEventListener('click', () => {
  $$('#pg-allseries .filt').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); loadAllSeries(1);
}));

/* ─────────────────────────────────────────────────────
   GENRE PAGE
───────────────────────────────────────────────────── */
function buildGenreTiles() {
  const grid = $('genre-grid');
  if (!grid) return;
  grid.innerHTML = GENRES_DEFAULT.map(g => `
    <div class="genre-tile" onclick="loadGenre('${g.slug}','${g.name}',1);navigate('genreview')">
      <span class="genre-icon">${g.icon}</span>
      <span class="genre-name">${g.name}</span>
    </div>`).join('');
}

async function loadGenre(slug, name, pg = 1) {
  gSlug = slug; gName = name; gPage = pg;
  navigate('genreview');
  const ht = $('genre-view-title');
  if (ht) ht.textContent = `${name}`;
  gridLoading('genre-view-grid');
  const d = await api(`${PROXY}/api/genre/${slug}?page=${pg}`);
  renderCards('genre-view-grid', d?.items);
  paginate('genre-view-pager', pg, d?.totalPages||1, p => loadGenre(slug, name, p));
}

/* ─────────────────────────────────────────────────────
   DETAIL PAGE
───────────────────────────────────────────────────── */
async function openDetail(slug) {
  prevPg = curPg;
  navigate('detail');
  const root = $('detail-root');
  root.innerHTML = `<div style="display:flex;justify-content:center;padding:5rem"><div class="spin"></div></div>`;

  const d = await api(`${PROXY}/api/manga/${encodeURIComponent(slug)}`);
  if (!d || !d.title) {
    root.innerHTML = `<div class="empty-box" style="padding:5rem">
      <div class="ei">😢</div><div class="et">Gagal memuat komik</div>
      <div class="es">Coba lagi nanti</div></div>`;
    return;
  }

  const scCol = '#a855f7';
  const authors = d.author || '-';
  const syn     = d.synopsis || 'Sinopsis tidak tersedia.';

  root.innerHTML = `
    <button class="detail-back" onclick="navigate('${prevPg}')">← Kembali</button>

    <div class="d-hero">
      <div class="d-bg" style="background-image:url('${d.img}')"></div>
      <div class="d-fog"></div>
      <div class="d-wrap">
        <img class="d-cover" src="${d.img||''}" alt="${d.title}" loading="lazy"
          onerror="this.src='';this.alt='No Image'">
        <div class="d-info">
          <h1 class="d-title">${d.title}</h1>
          ${d.altTitle ? `<div class="d-alt">${d.altTitle}</div>` : ''}
          <div class="d-tags">
            ${d.type ? `<span class="tag t-${(d.type||'').toLowerCase()}">${d.type}</span>` : ''}
            ${d.status ? `<span class="tag ${d.status.toLowerCase().includes('ongoing')?'t-on':'t-end'}">${d.status}</span>` : ''}
            ${(d.genres||[]).slice(0,3).map(g=>`<span class="tag t-genre">${g}</span>`).join('')}
          </div>
          <div class="d-stats">
            ${d.score ? `<div class="d-stat"><div class="d-val sc" style="color:${scCol}">★ ${d.score}</div><div class="d-lbl-s">Score</div></div>` : ''}
            ${(d.chapters||[]).length ? `<div class="d-stat"><div class="d-val">${d.chapters.length}</div><div class="d-lbl-s">Chapter</div></div>` : ''}
          </div>
          <div style="margin-top:12px">
            <button class="btn-primary" id="d-read-btn" onclick="startReadFirst()"
              ${(d.chapters||[]).length ? '' : 'disabled style="opacity:.4"'}>
              📖 ${(d.chapters||[]).length ? 'Baca Chapter Terbaru' : 'Tidak Ada Chapter'}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="d-body">
      <div>
        <div class="d-synopsis"><h3>Sinopsis</h3><p>${syn}</p></div>
        ${(d.genres||[]).length ? `
        <div class="d-genre-tags">
          ${d.genres.map(g=>`<span class="d-gtag"
            onclick="loadGenre('${g.toLowerCase().replace(/\s+/g,'-')}','${g.replace(/'/g,"\\'")}',1)">${g}</span>`).join('')}
        </div>` : ''}
      </div>
      <div class="d-card">
        <h3>Informasi</h3>
        ${dRow('Tipe',    d.type)}
        ${dRow('Status',  d.status)}
        ${dRow('Author',  d.author)}
        ${dRow('Score',   d.score)}
      </div>
    </div>

    <!-- Chapter list -->
    <div class="ch-section" id="ch-section">
      <h3><span>📚 Daftar Chapter <span class="md-badge">KomikKita</span></span></h3>
      <div class="ch-list" id="ch-list">
        ${buildChapterList(d.chapters || [], slug)}
      </div>
    </div>`;

  const clist = $('detail-chapters');
  if (clist) clist.innerHTML = buildChapterList(d.chapters || [], slug);

  _curChapters = (d.chapters || []).map(c => ({ slug: c.slug, title: c.title, date: c.date }));
  _curTitle    = d.title;
  _curImg      = d.img;
  _curMangaSlug = slug;
}

function dRow(l, v) {
  if (!v || v === '-') return '';
  return `<div class="d-row"><span class="d-rl">${l}</span><span class="d-rv">${v}</span></div>`;
}

// Build chapter list with range filter tabs (Ch 1-50, 51-100, etc.)
// Server returns newest first, so we reverse to show Ch 1 at top
function buildChapterList(chapters, mangaSlug) {
  if (!chapters.length) return `<div class="ch-empty">📭 Belum ada chapter tersedia.</div>`;

  const key = mangaSlug || '_cur';
  // Reverse: server sends newest→oldest, we want oldest→newest (Ch 1 first)
  const sorted = [...chapters].reverse();

  const renderItem = (c) => `
    <div class="ch-item" onclick="openReader('${c.slug}','${(_curTitle||'').replace(/'/g,"\\'")}')">
      <span class="ch-num">${c.title||'Chapter'}</span>
      <span class="ch-title-txt"></span>
      <span class="ch-date">${c.date||''}</span>
      <button class="ch-read-btn">📖 Baca</button>
    </div>`;

  const RANGE = 50;
  const totalRanges = Math.ceil(sorted.length / RANGE);

  // If chapters fit in one range (≤50), just render them all without tabs
  if (totalRanges <= 1) {
    return sorted.map(renderItem).join('');
  }

  // Build range tabs
  const tabs = Array.from({ length: totalRanges }, (_, i) => {
    const start = i * RANGE + 1;
    const end   = Math.min((i + 1) * RANGE, sorted.length);
    const label = `Ch ${start}–${end}`;
    return `<button class="ch-range-btn${i === 0 ? ' active' : ''}" onclick="showChapterRange('${key}',${i})">${label}</button>`;
  }).join('');

  // Build content panels per range
  const panels = Array.from({ length: totalRanges }, (_, i) => {
    const rangeItems = sorted.slice(i * RANGE, (i + 1) * RANGE).map(renderItem).join('');
    return `<div class="ch-range-panel${i === 0 ? '' : ' hidden'}" id="chr-${key}-${i}">${rangeItems}</div>`;
  }).join('');

  return `<div class="ch-range-tabs" id="chrt-${key}">${tabs}</div>${panels}`;
}

function showChapterRange(key, idx) {
  // Hide all panels for this manga
  document.querySelectorAll(`[id^="chr-${key}-"]`).forEach(el => el.classList.add('hidden'));
  document.getElementById(`chr-${key}-${idx}`)?.classList.remove('hidden');
  // Update active tab
  const tabBar = document.getElementById(`chrt-${key}`);
  if (tabBar) {
    tabBar.querySelectorAll('.ch-range-btn').forEach((btn, i) => btn.classList.toggle('active', i === idx));
  }
}

/* ─────────────────────────────────────────────────────
   READER
───────────────────────────────────────────────────── */
let _curChapters = [];
let _curTitle    = '';
let _curImg      = '';
let _curMangaSlug= '';
let _rChIdx      = 0;
let _chReadCount = parseInt(localStorage.getItem('kz_ch_read') || '0');

function startReadFirst() {
  if (!_curChapters.length) return;
  // Server sends newest chapter first at index 0
  openReader(_curChapters[0].slug, _curTitle);
}

async function openReader(chSlug, title) {
  navigate('reader');

  // If _curChapters is empty (e.g. opened from history / update-row without visiting detail),
  // try to infer the manga slug from the chapter slug and fetch chapters on-the-fly.
  if (!_curChapters.length && chSlug) {
    const pages = $('reader-pages');
    pages.innerHTML = `<div class="reader-loading"><div class="spin"></div><p>Memuat data chapter…</p></div>`;

    // Chapter slug format: "manga-title-chapter-N" → manga slug = strip last "-chapter-N" part
    const mangaSlugGuess = chSlug.replace(/-chapter-[\d-]+$/i, '');
    try {
      const md = await api(`${PROXY}/api/manga/${encodeURIComponent(mangaSlugGuess)}`);
      if (md && md.chapters && md.chapters.length) {
        _curChapters  = md.chapters.map(c => ({ slug: c.slug, title: c.title, date: c.date }));
        _curTitle     = md.title || title || '';
        _curImg       = md.img || '';
        _curMangaSlug = mangaSlugGuess;
      }
    } catch(e) {
      console.warn('Could not fetch manga for chapter context:', e);
    }
  }

  _rChIdx = _curChapters.findIndex(c => c.slug === chSlug);
  if (_rChIdx < 0) _rChIdx = 0;

  const ch = _curChapters[_rChIdx] || { slug: chSlug, title: 'Chapter' };
  $('r-title').textContent   = `${title||_curTitle||''} — ${ch.title||'Chapter'}`;
  $('r-ch-info').textContent = _curChapters.length ? `${_rChIdx + 1} / ${_curChapters.length}` : '...';

  if (_curMangaSlug && ch.slug) {
    saveHistory(_curMangaSlug, _curTitle, _curImg, ch.slug, ch.title || 'Chapter');
  }

  // Counter 15 chapter
  _chReadCount++;
  localStorage.setItem('kz_ch_read', _chReadCount.toString());
  if (_chReadCount % 15 === 0) {
    showTrakteerPopup();
  }

  const pages = $('reader-pages');
  pages.innerHTML = `<div class="reader-loading"><div class="spin"></div><p>Memuat gambar chapter…</p></div>`;

  // Call proxy to get chapter images
  const d = await fetch(`${PROXY}/api/chapter?slug=${encodeURIComponent(chSlug)}`).then(r => r.json()).catch(() => null);
  const imgs = d?.images || [];

  if (!imgs.length) {
    pages.innerHTML = `<div class="reader-error">
      <span class="ei">😢</span>
      <h3>Gambar tidak tersedia</h3>
      <p>Chapter ini belum bisa dimuat. Coba chapter lain atau kembali ke detail.</p>
      <button class="btn-primary" onclick="navigate('detail')">← Kembali ke Detail</button>
    </div>`;
    return;
  }

  pages.innerHTML = imgs.map((src, i) =>
    `<div class="r-page">
      <img src="${src}" alt="Halaman ${i+1}" loading="${i < 3 ? 'eager' : 'lazy'}"
        onerror="this.parentElement.innerHTML='<div style=padding:2rem;text-align:center;color:#555>Gagal memuat halaman ${i+1}</div>'">
    </div>`
  ).join('');

  updateReaderNav();
  window.scrollTo({ top: 0 });
}

function updateReaderNav() {
  const n = _curChapters.length;
  $('r-ch-info').textContent  = `${_rChIdx + 1} / ${n}`;
  $('r-prev-ch').disabled     = _rChIdx <= 0;
  $('r-next-ch').disabled     = _rChIdx >= n - 1;
  $('rnav-prev').disabled     = _rChIdx <= 0;
  $('rnav-next').disabled     = _rChIdx >= n - 1;
}

function goReaderChapter(delta) {
  const newIdx = _rChIdx + delta;
  if (newIdx < 0 || newIdx >= _curChapters.length) return;
  _rChIdx = newIdx;
  const ch = _curChapters[_rChIdx];
  openReader(ch.slug, _curTitle);
}

$('r-back').addEventListener('click',    () => navigate('detail'));
$('r-prev-ch').addEventListener('click', () => goReaderChapter(-1));
$('r-next-ch').addEventListener('click', () => goReaderChapter(+1));
$('rnav-prev').addEventListener('click', () => goReaderChapter(-1));
$('rnav-next').addEventListener('click', () => goReaderChapter(+1));

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
});

async function doSearch(q) {
  const dd = $('search-drop');
  dd.innerHTML = `<div style="padding:.85rem;text-align:center">
    <div class="spin" style="width:22px;height:22px;margin:0 auto"></div></div>`;
  dd.classList.add('open');

  const d = await api(`${PROXY}/api/search?q=${encodeURIComponent(q)}`);
  if (!d?.items?.length) {
    dd.innerHTML = `<div style="padding:.85rem;text-align:center;font-size:.8rem;color:#555">Tidak ditemukan</div>`;
    return;
  }
  dd.innerHTML = d.items.map(m => `
    <div class="sd-row" onclick="$('search-drop').classList.remove('open');$('q').value='';openDetail('${m.slug}')">
      ${m.img ? `<img class="sd-img" src="${m.img}" alt="${m.title}">` : '<div class="sd-img"></div>'}
      <div style="flex:1;min-width:0">
        <div class="sd-name">${m.title}</div>
        <div class="sd-sub">${m.type||''}</div>
      </div>
      ${m.score ? `<div class="sd-sc">⭐ ${m.score}</div>` : ''}
    </div>`).join('');
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
  navigate('page');
}

function navigate(name) {
  if (name === curPg && name !== 'detail' && name !== 'reader' && name !== 'genreview' && name !== 'page') return;
  $$('.pg').forEach(p => p.classList.remove('active'));
  $(`pg-${name}`)?.classList.add('active');

  const reading = name === 'reader';
  const bnav = document.querySelector('.bnav');
  if (bnav) {
    if (reading) {
      bnav.style.display = 'none';
    } else {
      // Let CSS handle visibility (mobile: flex, desktop: none)
      bnav.style.display = '';
    }
  }
  document.querySelector('.navbar').style.display = reading ? 'none' : '';
  $('main').style.paddingTop = reading ? '0' : '';

  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
  curPg = name;
  window.scrollTo({ top: 0 });
  $('mmenu')?.classList.remove('open');

  if (name === 'explore'   && !$('exp-grid').children.length)   loadExplore(1);
  if (name === 'top'       && !$('top-grid').children.length)   loadTop(1);
  if (name === 'allseries' && !$('all-grid').children.length)   loadAllSeries(1);
  if (name === 'genre'     && !$('genre-grid').children.length) buildGenreTiles();
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
});
$('btt').addEventListener('click', () => window.scrollTo({ top:0, behavior:'smooth' }));

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

  // Muncul setiap refresh/load halaman (delay 3 detik)
  setTimeout(() => showTrakteerPopup(), 3000);

  const hide = () => popup.classList.remove('show');
  $('popup-close')?.addEventListener('click', hide);
  $('popup-btn')?.addEventListener('click', hide);
  popup.addEventListener('click', e => { if (e.target === popup) hide(); });
}

/* ─────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────── */
(async () => {
  initPopup();
  try {
    await loadHome();
  } catch(err) {
    console.error('Init error:', err);
    showToast('Gagal memuat data. Coba refresh halaman.');
  }
})();
