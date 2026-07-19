/* ═══════════════════════════════════════════════════════════════════════════
   ARADIA EDU — Main Application
   ═══════════════════════════════════════════════════════════════════════════ */

const STATE = {
  email: '', pin: '',
  user: null,
  currentPage: 'manuals',
  viewerModule: null,
  viewerChapters: [],
  viewerFlatPages: [],
  viewerPageIndex: 0,
  manuals: [],
  manualsFilter: 'all',
  selectedManual: null,
  videos: [],
  videosFilter: 'all',
  selectedVideo: null,
  favorites: [],
  favoritesFilter: 'all',
  adminModules: [],
  adminManuals: [],
  adminVideos: [],
  adminCategories: [],
  editingModule: null,
  staffList: [],
};

/* ═══════════════════════════════════════════════════════════════════════════
   API
   ═══════════════════════════════════════════════════════════════════════════ */
async function api(endpoint, data = {}) {
  try {
    const r = await fetch('/api/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: STATE.email, pin: STATE.pin, ...data })
    });
    return await r.json();
  } catch (e) {
    console.error('API Error:', e);
    return { ok: false, reason: 'Network error' };
  }
}

async function apiUpload(type, file, extraFields = {}) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('email', STATE.email);
  fd.append('pin', STATE.pin);
  for (const [k, v] of Object.entries(extraFields)) fd.append(k, v);
  const r = await fetch(`/api/admin/upload/${type}`, { method: 'POST', body: fd });
  return await r.json();
}

/* ═══════════════════════════════════════════════════════════════════════════
   THEME
   ═══════════════════════════════════════════════════════════════════════════ */
function toggleTheme() {
  const themes = ['dark', 'light', 'aradia'];
  const current = document.documentElement.getAttribute('data-theme');
  const idx = themes.indexOf(current);
  const next = themes[(idx + 1) % themes.length];
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('edu_theme', next);
}

function applyStoredTheme() {
  const stored = localStorage.getItem('edu_theme');
  if (stored) document.documentElement.setAttribute('data-theme', stored);
}
applyStoredTheme();

/* ═══════════════════════════════════════════════════════════════════════════
   AUTH
   ═══════════════════════════════════════════════════════════════════════════ */
function doLogin() {
  const email = document.getElementById('login_email').value.trim();
  const pin = document.getElementById('login_pin').value.trim();
  if (!email || !pin) return showLoginError('Please enter email and PIN');

  STATE.email = email;
  STATE.pin = pin;

  api('login').then(r => {
    if (!r.ok) return showLoginError(r.reason);
    STATE.user = r.user;
    localStorage.setItem('edu_email', email);
    localStorage.setItem('edu_pin', pin);
    enterApp();
  });
}

function showLoginError(msg) {
  const el = document.getElementById('login_error');
  el.textContent = msg; el.style.display = 'block';
}

function doLogout() {
  STATE.email = ''; STATE.pin = ''; STATE.user = null;
  localStorage.removeItem('edu_email');
  localStorage.removeItem('edu_pin');
  document.getElementById('page_login').style.display = 'flex';
  document.getElementById('app_shell').style.display = 'none';
}

function tryAutoLogin() {
  const email = localStorage.getItem('edu_email');
  const pin = localStorage.getItem('edu_pin');
  if (email && pin) {
    STATE.email = email; STATE.pin = pin;
    api('login').then(r => {
      if (r.ok) { STATE.user = r.user; enterApp(); }
    });
  }
}

// SSO hand-off from the portal: ?sso=<one-time-token>. Exchange it for an edu
// session and store it where the PIN normally lives, so the user is logged in
// without typing anything. Any other query params (video/manual deep links) are
// preserved for enterApp() to act on.
function trySsoLogin() {
  const params = new URLSearchParams(location.search);
  const token = params.get('sso');
  if (!token) return false;
  fetch('/api/sso', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  })
    .then(r => r.json())
    .then(r => {
      // Strip the token from the URL regardless of outcome; keep other params.
      params.delete('sso');
      const clean = location.pathname + (params.toString() ? '?' + params.toString() : '');
      history.replaceState(null, '', clean);
      if (r.ok && r.session) {
        STATE.email = r.user.email;
        STATE.pin = r.session;            // session token stands in for the PIN
        STATE.user = r.user;
        localStorage.setItem('edu_email', STATE.email);
        localStorage.setItem('edu_pin', STATE.pin);
        enterApp();
      } else {
        tryAutoLogin();                   // fall back to stored creds / login screen
      }
    })
    .catch(() => { tryAutoLogin(); });
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  ['login_email', 'login_pin'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });
  });
  if (!trySsoLogin()) tryAutoLogin();
});

function enterApp() {
  document.getElementById('page_login').style.display = 'none';
  document.getElementById('app_shell').style.display = 'flex';

  const avatar = document.getElementById('header_avatar');
  if (STATE.user.profile_pic) {
    avatar.innerHTML = `<img src="${STATE.user.profile_pic}" alt="">`;
  } else {
    avatar.textContent = (STATE.user.name || STATE.user.email).charAt(0).toUpperCase();
  }
  document.getElementById('header_name').textContent = STATE.user.name || STATE.user.email;

  if (STATE.user.isAdmin || STATE.user.isModerator) {
    document.getElementById('nav_admin').style.display = '';
  }

  if (!localStorage.getItem('edu_theme') && STATE.user.preferred_theme) {
    const theme = STATE.user.preferred_theme;
    document.documentElement.setAttribute('data-theme',
      ['dark', 'light', 'aradia'].includes(theme) ? theme : 'dark');
  }

  const params = new URLSearchParams(location.search);
  const videoId = parseInt(params.get('video'), 10);
  const manualId = parseInt(params.get('manual'), 10);
  if (videoId) {
    history.replaceState(null, '', location.pathname);
    go('videos', videoId);
  } else if (manualId) {
    history.replaceState(null, '', location.pathname);
    go('manuals', manualId);
  } else {
    go('manuals');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   NAVIGATION
   ═══════════════════════════════════════════════════════════════════════════ */
async function go(page, openId) {
  if (STATE.currentPage === 'slide_editor' && page !== 'admin' && page !== 'viewer') return;

  if (STATE.currentPage === 'slide_editor' && page !== 'slide_editor') {
    document.querySelector('.app-header').style.display = '';
  }

  // Stop video playback when leaving the videos page so audio doesn't bleed
  // into other tabs (Drive iframes can't be paused from outside).
  if (STATE.currentPage === 'videos' && page !== 'videos' && STATE.selectedVideo) {
    closeVideo();
  }

  STATE.currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.header-nav button').forEach(b => b.classList.remove('active'));

  if (page === 'modules') {
    document.getElementById('page_modules_list').classList.add('active');
    document.querySelector('[data-nav="modules"]').classList.add('active');
    loadModules();
  } else if (page === 'viewer') {
    document.getElementById('page_module_viewer').classList.add('active');
    document.querySelector('[data-nav="modules"]').classList.add('active');
  } else if (page === 'manuals') {
    document.getElementById('page_manuals').classList.add('active');
    document.querySelector('[data-nav="manuals"]').classList.add('active');
    await loadManuals();
    if (openId) selectManual(openId);
  } else if (page === 'videos') {
    document.getElementById('page_videos').classList.add('active');
    document.querySelector('[data-nav="videos"]').classList.add('active');
    await loadVideos();
    if (openId) selectVideo(openId);
  } else if (page === 'favorites') {
    document.getElementById('page_favorites').classList.add('active');
    document.querySelector('[data-nav="favorites"]').classList.add('active');
    loadFavorites();
  } else if (page === 'admin') {
    document.getElementById('page_admin').classList.add('active');
    document.querySelector('[data-nav="admin"]').classList.add('active');
    loadAdminData();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   LEARNING MODULES - LIST
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadModules() {
  const r = await api('getMyModules');
  if (!r.ok) return;

  const grid = document.getElementById('modules_grid');
  const empty = document.getElementById('modules_empty');

  if (r.modules.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = r.modules.map(m => {
    const pct = m.progress && parseInt(m.progress.total) > 0
      ? Math.round((parseInt(m.progress.completed) / parseInt(m.progress.total)) * 100) : 0;
    const isComplete = m.is_completed;

    let badge = '';
    if (isComplete) {
      badge = '<span class="module-card-badge badge-complete">&#10003; Complete</span>';
    } else if (m.due_date) {
      const due = new Date(m.due_date);
      const now = new Date();
      if (due < now) badge = '<span class="module-card-badge badge-overdue">Overdue</span>';
      else badge = `<span class="module-card-badge badge-due">Due ${formatDate(m.due_date)}</span>`;
    }

    return `
      <div class="module-card" onclick="openModule(${m.id})">
        <div class="module-card-cover">
          ${m.cover_image ? `<img src="${m.cover_image}" alt="">` : '<div class="cover-icon">&#128218;</div>'}
          ${badge}
        </div>
        <div class="module-card-body">
          <div class="module-card-title">${esc(m.title)}</div>
          <div class="module-card-desc">${esc(m.description || '').substring(0, 100)}</div>
          <div class="module-card-meta">
            <span>${m.chapter_count || 0} chapters &middot; ${m.page_count || 0} pages</span>
            <span class="module-card-pct">${pct}%</span>
          </div>
          <div class="progress-bar-wrap">
            <div class="progress-bar-fill ${isComplete ? 'complete' : ''}" style="width:${pct}%"></div>
          </div>
        </div>
      </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════════════════════
   LEARNING MODULES - VIEWER
   ═══════════════════════════════════════════════════════════════════════════ */
async function openModule(moduleId) {
  const r = await api('getModule', { module_id: moduleId });
  if (!r.ok) return toast(r.reason, 'error');

  STATE.viewerModule = r.module;
  STATE.viewerChapters = r.chapters;

  STATE.viewerFlatPages = [];
  for (const ch of r.chapters) {
    for (const pg of ch.pages) {
      STATE.viewerFlatPages.push({ ...pg, chapter_title: ch.title, chapter_id: ch.id });
    }
  }

  if (STATE.viewerFlatPages.length === 0) {
    return toast('This module has no content yet', 'error');
  }

  let startIdx = 0;
  for (let i = 0; i < STATE.viewerFlatPages.length; i++) {
    if (!STATE.viewerFlatPages[i].user_completed) { startIdx = i; break; }
  }

  STATE.viewerPageIndex = startIdx;
  go('viewer');
  renderViewer();

  if (startIdx > 0) {
    toast(`Resuming from page ${startIdx + 1}`, 'success');
  }
}

function renderViewer() {
  const mod = STATE.viewerModule;
  const chapters = STATE.viewerChapters;
  const flatPages = STATE.viewerFlatPages;
  const currentPage = flatPages[STATE.viewerPageIndex];

  document.getElementById('viewer_module_title').textContent = mod.title;
  const totalPages = flatPages.length;
  const completedPages = flatPages.filter(p => p.user_completed).length;
  const pct = totalPages > 0 ? Math.round((completedPages / totalPages) * 100) : 0;
  document.getElementById('viewer_progress_text').textContent = `${completedPages} of ${totalPages} pages complete (${pct}%)`;
  document.getElementById('viewer_progress_bar').style.width = pct + '%';
  if (pct === 100) document.getElementById('viewer_progress_bar').classList.add('complete');
  else document.getElementById('viewer_progress_bar').classList.remove('complete');

  const chapEl = document.getElementById('viewer_chapters');
  chapEl.innerHTML = chapters.map(ch => {
    const chPages = ch.pages || [];
    const chComplete = chPages.length > 0 && chPages.every(p => p.user_completed);
    const isExpanded = currentPage && currentPage.chapter_id === ch.id;

    const chDone = chPages.filter(p => p.user_completed).length;
    const chPct = chPages.length > 0 ? Math.round((chDone / chPages.length) * 100) : 0;

    return `
      <div class="chapter-group">
        <div class="chapter-title ${isExpanded ? 'expanded' : ''}" onclick="toggleChapter(this)">
          <span class="ch-icon">&#9654;</span>
          ${esc(ch.title)}
          <span class="ch-meta">
            <span class="ch-count">${chDone}/${chPages.length}</span>
            ${chComplete ? '<span class="ch-check">&#10003;</span>' : ''}
          </span>
        </div>
        <div class="ch-progress-bar">
          <div class="ch-progress-fill ${chComplete ? 'complete' : ''}" style="width:${chPct}%"></div>
        </div>
        <div class="chapter-pages ${isExpanded ? 'expanded' : ''}">
          ${chPages.map((pg, pi) => {
            const flatIdx = flatPages.findIndex(fp => fp.id === pg.id);
            const isActive = flatIdx === STATE.viewerPageIndex;
            return `
              <div class="page-item ${isActive ? 'active' : ''} ${pg.user_completed ? 'completed' : ''}" onclick="goToPage(${flatIdx})">
                ${esc(pg.title || 'Untitled Page')}
                <span class="page-check">&#10003;</span>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');

  renderSlide(currentPage);

  document.getElementById('viewer_nav_info').textContent = '';

  document.getElementById('btn_prev').style.display = STATE.viewerPageIndex > 0 ? '' : 'none';

  const isLast = STATE.viewerPageIndex === totalPages - 1;
  const btnNext = document.getElementById('btn_next');

  if (isLast) {
    btnNext.textContent = currentPage.user_completed ? 'Finish Module' : 'Complete & Finish';
    btnNext.className = 'btn-nav btn-complete';
    btnNext.onclick = () => completePage();
  } else {
    btnNext.textContent = 'Next \u2192';
    btnNext.className = 'btn-nav btn-next';
    btnNext.onclick = () => navNext();

    if (currentPage.video_url && currentPage.video_required && !currentPage.user_video_watched) {
      btnNext.disabled = true;
      btnNext.title = 'Watch the video to continue';
    } else {
      btnNext.disabled = false;
      btnNext.title = '';
    }
  }
}

function renderSlide(page) {
  const container = document.getElementById('viewer_content');
  if (!page) {
    container.innerHTML = '<div class="empty-state"><p>No content</p></div>';
    return;
  }

  const contentData = typeof page.content === 'string' ? JSON.parse(page.content || '{}') : (page.content || {});
  const bgOpacity = contentData.bg_opacity != null ? contentData.bg_opacity / 100 : 1;
  const bgStyle = page.background_image ? `style="background-image:url('${page.background_image}');opacity:${bgOpacity}"` : '';

  let videoHtml = '';
  if (page.video_url) {
    const embedUrl = getEmbedUrl(page.video_url);
    const isYouTube = page.video_url.includes('youtube') || page.video_url.includes('youtu.be');
    const isGDrive = page.video_url.includes('drive.google');

    if (isYouTube) {
      videoHtml = `
        <div class="slide-video">
          <div id="yt_player_wrap">
            <iframe id="yt_iframe" src="${embedUrl}&enablejsapi=1&rel=0&modestbranding=1"
              allowfullscreen allow="autoplay; encrypted-media"></iframe>
          </div>
          ${page.video_required && !page.user_video_watched ? `
            <div class="video-overlay" id="video_overlay">
              <div>&#9654; Watch this video to continue</div>
              <div class="video-progress-bar"><div class="video-progress-fill" id="video_progress_fill"></div></div>
              <div id="video_status_text" style="font-size:12px;opacity:0.7">Play the video to begin</div>
            </div>
          ` : ''}
        </div>`;
    } else if (isGDrive) {
      videoHtml = `<div class="slide-video"><iframe src="${embedUrl}" allowfullscreen></iframe></div>`;
    } else {
      videoHtml = `
        <div class="slide-video">
          <video controls controlslist="noplaybackrate" ${page.video_required ? 'id="local_video"' : ''}>
            <source src="${page.video_url}">
          </video>
        </div>`;
    }
  }

  const bodyHtml = contentData.html || contentData.text || '';

  container.innerHTML = `
    <div class="slide-container ${page.background_image ? 'has-bg' : ''}">
      ${page.background_image ? `<div class="slide-bg" ${bgStyle}></div>` : ''}
      <div class="slide-inner">
        <div class="slide-title">${esc(page.title || '')}</div>
        ${videoHtml}
        <div class="slide-body">${bodyHtml}</div>
      </div>
    </div>`;

  if (page.video_url && page.video_required && !page.user_video_watched) {
    setupVideoTracking(page);
  }
}

function getEmbedUrl(url) {
  if (url.includes('youtube.com/watch')) {
    const vid = new URL(url).searchParams.get('v');
    return `https://www.youtube.com/embed/${vid}?`;
  }
  if (url.includes('youtu.be/')) {
    const vid = url.split('youtu.be/')[1].split('?')[0];
    return `https://www.youtube.com/embed/${vid}?`;
  }
  if (url.includes('youtube.com/embed')) return url;
  if (url.includes('drive.google.com/file/d/')) {
    const fileId = url.match(/\/d\/([^/]+)/)?.[1];
    if (fileId) return `https://drive.google.com/file/d/${fileId}/preview`;
  }
  return url;
}

function setupVideoTracking(page) {
  const iframe = document.getElementById('yt_iframe');
  if (iframe) {
    let elapsed = 0;
    const minWatchTime = 30;
    const overlay = document.getElementById('video_overlay');
    const statusText = document.getElementById('video_status_text');
    const progressFill = document.getElementById('video_progress_fill');

    const checkInterval = setInterval(() => {
      elapsed++;
      const pct = Math.min(100, (elapsed / minWatchTime) * 100);
      if (progressFill) progressFill.style.width = pct + '%';
      if (statusText) statusText.textContent = elapsed < minWatchTime
        ? `Watching... ${minWatchTime - elapsed}s remaining` : 'Video complete!';

      if (elapsed >= minWatchTime) {
        clearInterval(checkInterval);
        if (overlay) overlay.classList.add('hidden');
        markVideoWatched(page);
      }
    }, 1000);

    STATE._videoInterval = checkInterval;
  }

  const localVideo = document.getElementById('local_video');
  if (localVideo) {
    let lastTime = 0;
    localVideo.addEventListener('timeupdate', () => {
      if (localVideo.currentTime > lastTime + 2) localVideo.currentTime = lastTime;
      lastTime = localVideo.currentTime;
    });
    localVideo.addEventListener('ended', () => markVideoWatched(page));
  }
}

async function markVideoWatched(page) {
  const currentFlat = STATE.viewerFlatPages[STATE.viewerPageIndex];
  currentFlat.user_video_watched = true;

  for (const ch of STATE.viewerChapters) {
    for (const pg of (ch.pages || [])) {
      if (pg.id === page.id) pg.user_video_watched = true;
    }
  }

  await api('markVideoWatched', {
    page_id: page.id,
    module_id: STATE.viewerModule.id,
    chapter_id: currentFlat.chapter_id
  });

  const btnNext = document.getElementById('btn_next');
  btnNext.disabled = false;
  btnNext.title = '';
}

function toggleChapter(el) {
  el.classList.toggle('expanded');
  // Find the chapter-pages within the same chapter-group parent
  const group = el.closest('.chapter-group');
  if (group) {
    const pages = group.querySelector('.chapter-pages');
    if (pages) pages.classList.toggle('expanded');
  }
}

function goToPage(idx) {
  if (STATE._videoInterval) clearInterval(STATE._videoInterval);
  STATE.viewerPageIndex = idx;
  renderViewer();
}

function navPrev() {
  if (STATE.viewerPageIndex > 0) {
    if (STATE._videoInterval) clearInterval(STATE._videoInterval);
    STATE.viewerPageIndex--;
    renderViewer();
  }
}

async function navNext() {
  const current = STATE.viewerFlatPages[STATE.viewerPageIndex];
  if (!current.user_completed) await markPageComplete(current);

  if (STATE.viewerPageIndex < STATE.viewerFlatPages.length - 1) {
    if (STATE._videoInterval) clearInterval(STATE._videoInterval);
    STATE.viewerPageIndex++;
    renderViewer();
  }
}

async function completePage() {
  const current = STATE.viewerFlatPages[STATE.viewerPageIndex];
  if (!current.user_completed) {
    const r = await markPageComplete(current);
    if (r && r.moduleComplete) { showCompletion(); return; }
  }

  const allDone = STATE.viewerFlatPages.every(p => p.user_completed);
  if (allDone) showCompletion();
  else go('modules');
}

async function markPageComplete(page) {
  page.user_completed = true;
  for (const ch of STATE.viewerChapters) {
    for (const pg of (ch.pages || [])) {
      if (pg.id === page.id) pg.user_completed = true;
    }
  }

  const r = await api('markPageComplete', {
    page_id: page.id,
    module_id: STATE.viewerModule.id,
    chapter_id: page.chapter_id,
    video_watched: page.user_video_watched || false
  });

  renderViewer();
  return r;
}

function showCompletion() {
  document.getElementById('completion_title').textContent = STATE.viewerModule.title + ' Complete!';
  const overlay = document.getElementById('completion_overlay');
  overlay.style.display = 'flex';
  overlay.classList.add('show-confetti');
}

function exitViewer() {
  if (STATE._previewMode) {
    STATE._previewMode = false;
    go('admin');
    editModule(STATE.viewerModule.id);
  } else {
    go('modules');
  }
}

function closeCompletion() {
  const overlay = document.getElementById('completion_overlay');
  overlay.style.display = 'none';
  overlay.classList.remove('show-confetti');
  if (STATE._previewMode) {
    STATE._previewMode = false;
    go('admin');
    editModule(STATE.viewerModule.id);
  } else {
    go('modules');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MANUALS
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadManuals() {
  const r = await api('getManuals');
  if (!r.ok) return;
  STATE.manuals = r.manuals;
  renderManualFilters();
  renderManualsList();
}

// Category names for an item, preferring the multi-category list and falling
// back to the single text category.
function catNames(item) {
  if (item && item.category_names && item.category_names.length) return item.category_names;
  return item && item.category ? [item.category] : [];
}

function renderManualFilters() {
  const categories = ['All', ...new Set(STATE.manuals.flatMap(catNames))];
  const el = document.getElementById('manuals_filter');
  el.innerHTML = categories.map(c => {
    const key = c === 'All' ? 'all' : c;
    return `<button class="filter-btn ${STATE.manualsFilter === key ? 'active' : ''}"
      onclick="setManualFilter('${key}')">${c}</button>`;
  }).join('');
}

function setManualFilter(filter) {
  STATE.manualsFilter = filter;
  renderManualFilters();
  renderManualsList();
}

function filterManuals() { renderManualsList(); }

function renderManualsList() {
  const search = (document.getElementById('manuals_search').value || '').toLowerCase();
  let filtered = STATE.manuals;

  if (STATE.manualsFilter !== 'all') filtered = filtered.filter(m => catNames(m).includes(STATE.manualsFilter));
  if (search) {
    filtered = filtered.filter(m =>
      m.title.toLowerCase().includes(search) ||
      m.description.toLowerCase().includes(search) ||
      catNames(m).join(' ').toLowerCase().includes(search)
    );
  }

  filtered.sort((a, b) => {
    if (a.is_favorite && !b.is_favorite) return -1;
    if (!a.is_favorite && b.is_favorite) return 1;
    return 0;
  });

  const el = document.getElementById('manuals_list');
  if (filtered.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No manuals found</p></div>';
    return;
  }

  el.innerHTML = filtered.map(m => `
    <div class="manual-item ${STATE.selectedManual === m.id ? 'active' : ''}" onclick="selectManual(${m.id})">
      <div class="manual-icon">${m.file_type === 'pdf' ? '&#128196;' : '&#128195;'}</div>
      <div class="manual-info">
        <div class="manual-title">${esc(m.title)}</div>
        <div class="manual-category">${esc(catNames(m).join(' · '))}</div>
      </div>
      <button class="manual-fav ${m.is_favorite ? 'favorited' : ''}" onclick="event.stopPropagation();toggleFavorite(${m.id})">
        ${m.is_favorite ? '&#9733;' : '&#9734;'}
      </button>
    </div>
  `).join('');
}

function selectManual(id) {
  STATE.selectedManual = id;
  const manual = STATE.manuals.find(m => m.id === id);
  if (!manual) return;

  const viewer = document.getElementById('manuals_viewer');
  const pdfPane = manual.file_type === 'pdf'
    ? `<iframe class="manual-frame" src="${manual.file_path}"></iframe>`
    : `<div style="padding:40px;text-align:center;color:var(--text2)">
         <div style="font-size:48px;margin-bottom:16px">&#128196;</div>
         <p>${esc(manual.title)}</p>
         <a href="${manual.file_path}" download class="btn-primary" style="display:inline-block;margin-top:16px">
           Download File
         </a>
       </div>`;

  const relatedVideos = manual.videos || [];
  const relatedBar = relatedVideos.length ? `
    <div class="manual-related-bar" style="flex:0 0 auto;position:relative;padding:8px 12px;border-bottom:1px solid var(--border)">
      <button class="btn-secondary" style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px" onclick="toggleRelatedVideos()">
        <span>&#127909; Related videos (${relatedVideos.length})</span>
        <span id="related_caret" style="transition:transform .15s">&#9662;</span>
      </button>
      <div id="related_videos_panel" style="display:none;position:absolute;left:12px;right:12px;top:100%;z-index:30;margin-top:4px;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.35);overflow:hidden">
        <input id="related_search" type="text" placeholder="Search videos…" oninput="filterRelatedVideos()"
          style="width:100%;box-sizing:border-box;padding:10px 14px;border:none;border-bottom:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:14px;outline:none">
        <div id="related_videos_scroll" style="max-height:48vh;overflow-y:auto">
          ${relatedVideos.map(v => `
            <button class="related-video-item" data-search="${esc((v.title || '').toLowerCase())}" onclick="playRelatedVideo(${manual.id}, ${v.id})"
              style="display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:10px 14px;background:none;border:none;border-bottom:1px solid var(--border);color:var(--text);font-size:14px;cursor:pointer">
              <span style="color:var(--accent)">&#9654;</span> ${esc(v.title)}
            </button>`).join('')}
          <div id="related_no_match" style="display:none;padding:12px 14px;color:var(--text3);font-size:13px">No videos match.</div>
        </div>
      </div>
    </div>` : '';

  const bookmarksBar = manual.file_type === 'pdf' ? `
    <div class="manual-related-bar" style="flex:0 0 auto;position:relative;padding:8px 12px;border-bottom:1px solid var(--border);display:flex;gap:8px">
      <button class="btn-secondary" style="flex:1;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px" onclick="toggleBookmarks()">
        <span>&#128278; Bookmarks (<span id="bm_count">0</span>)</span>
        <span id="bm_caret" style="transition:transform .15s">&#9662;</span>
      </button>
      <button class="btn-secondary" style="font-size:13px;white-space:nowrap" onclick="addManualBookmark(${manual.id})">+ Add here</button>
      <div id="bookmarks_panel" style="display:none;position:absolute;left:12px;right:12px;top:100%;z-index:30;margin-top:4px;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.35);overflow:hidden">
        <div id="bookmarks_list" style="max-height:48vh;overflow-y:auto"></div>
      </div>
    </div>` : '';

  viewer.innerHTML = `
    <button class="manual-back-btn" onclick="closeManual()" aria-label="Back to list">&larr;</button>
    <div class="manual-pane" style="flex-direction:column">
      ${relatedBar}
      ${bookmarksBar}
      <div style="flex:1;min-height:0;width:100%;display:flex">${pdfPane}</div>
    </div>
    <aside class="manual-notes" id="manual_notes_panel">
      <div class="manual-notes-header">
        <span>My Notes</span>
        <span class="manual-notes-status" id="manual_notes_status"></span>
        <button class="manual-notes-close" onclick="toggleManualNotes(false)" aria-label="Close notes">&times;</button>
      </div>
      <textarea id="manual_notes_textarea"
        placeholder="Private notes for this manual — only you see these.&#10;Auto-saves when you click away."
        onblur="saveManualNote(${manual.id})"></textarea>
    </aside>
    <button class="manual-notes-fab" onclick="toggleManualNotes(true)" aria-label="Open notes">
      &#128221;
    </button>`;

  document.getElementById('page_manuals').classList.add('viewing-manual');
  loadManualNote(manual.id);
  if (manual.file_type === 'pdf') loadManualBookmarks(manual.id);
  renderManualsList();
}

function toggleBookmarks() {
  const panel = document.getElementById('bookmarks_panel');
  const caret = document.getElementById('bm_caret');
  if (!panel) return;
  const open = panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  if (caret) caret.style.transform = open ? 'rotate(180deg)' : '';
}

async function loadManualBookmarks(manual_id) {
  const r = await api('getManualBookmarks', { manual_id });
  const list = document.getElementById('bookmarks_list');
  const count = document.getElementById('bm_count');
  if (!list) return;
  const bms = r.ok ? r.bookmarks : [];
  if (count) count.textContent = bms.length;
  if (!bms.length) {
    list.innerHTML = '<div style="padding:12px 14px;color:var(--text3);font-size:13px">No bookmarks yet. Open the page you want, then tap "+ Add here".</div>';
    return;
  }
  list.innerHTML = bms.map(b => `
    <div class="related-video-item" style="display:flex;align-items:center;gap:8px;padding:8px 10px 8px 14px;border-bottom:1px solid var(--border)">
      <button onclick="jumpToBookmark(${b.page})" style="flex:1;display:flex;align-items:center;gap:10px;text-align:left;background:none;border:none;color:var(--text);font-size:14px;cursor:pointer">
        <span style="min-width:44px;font-size:12px;font-weight:700;color:var(--accent)">p.${b.page}</span>
        <span>${esc(b.label || 'Bookmark')}</span>
      </button>
      <button onclick="deleteManualBookmark(${b.id}, ${manual_id})" aria-label="Delete bookmark"
        style="background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:4px 8px">&times;</button>
    </div>`).join('');
}

async function addManualBookmark(manual_id) {
  const pageStr = prompt('Which page number are you bookmarking?');
  if (pageStr === null) return;
  const page = Math.max(1, parseInt(pageStr, 10) || 0);
  if (!page) return toast('Enter a valid page number', 'error');
  const label = (prompt('Label for this bookmark (optional):') || '').trim();
  const r = await api('addManualBookmark', { manual_id, page, label });
  if (r.ok) { toast('Bookmark added', 'success'); loadManualBookmarks(manual_id); }
  else toast(r.reason || 'Failed to add bookmark', 'error');
}

async function deleteManualBookmark(bookmark_id, manual_id) {
  const r = await api('deleteManualBookmark', { bookmark_id });
  if (r.ok) { toast('Bookmark removed', 'success'); loadManualBookmarks(manual_id); }
}

// Jump the manual iframe to a page. Works for app-hosted PDFs via #page=N;
// Drive-embedded PDFs ignore it, so we tell the user the page to flip to.
function jumpToBookmark(page) {
  const manual = STATE.manuals.find(m => m.id === STATE.selectedManual);
  const frame = document.querySelector('#manuals_viewer .manual-frame');
  if (!manual || !frame) return;
  const base = manual.file_path.split('#')[0];
  const isDrive = /drive\.google\.com/.test(base);
  frame.src = base + '#page=' + page;
  toggleBookmarks();
  if (isDrive) toast(`Flip to page ${page} — Drive PDFs don't auto-jump`, 'success');
}

function closeManual() {
  STATE.selectedManual = null;
  document.getElementById('page_manuals').classList.remove('viewing-manual');
  const viewer = document.getElementById('manuals_viewer');
  viewer.innerHTML = `
    <div class="manuals-viewer-empty">
      <div class="empty-icon">&#128196;</div>
      <p>Select a manual to view</p>
    </div>`;
  renderManualsList();
}

// Plays a video that's attached to a manual, in a modal, without leaving the
// manual. Looks the video up from the manual payload so it works even if the
// video isn't in the user's (category-filtered) Videos list.
function toggleRelatedVideos() {
  const panel = document.getElementById('related_videos_panel');
  const caret = document.getElementById('related_caret');
  if (!panel) return;
  const open = panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  if (caret) caret.style.transform = open ? 'rotate(180deg)' : '';
  if (open) {
    const s = document.getElementById('related_search');
    if (s) setTimeout(() => s.focus(), 50);
  }
}

// Filter the related-videos dropdown as the user types.
function filterRelatedVideos() {
  const q = (document.getElementById('related_search').value || '').toLowerCase().trim();
  let shown = 0;
  document.querySelectorAll('#related_videos_scroll .related-video-item').forEach(it => {
    const match = !q || (it.getAttribute('data-search') || '').includes(q);
    it.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  const none = document.getElementById('related_no_match');
  if (none) none.style.display = shown === 0 ? 'block' : 'none';
}

function playRelatedVideo(manualId, videoId) {
  const panel = document.getElementById('related_videos_panel');
  if (panel) { panel.style.display = 'none'; }
  const caret = document.getElementById('related_caret');
  if (caret) caret.style.transform = '';
  const m = STATE.manuals.find(x => x.id === manualId);
  const v = m && (m.videos || []).find(x => x.id === videoId);
  if (!v) return;
  showModal(`
    <h3 style="margin-bottom:12px">${esc(v.title)}</h3>
    <div style="position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;overflow:hidden">
      <iframe src="${v.file_path}" allow="autoplay" allowfullscreen
        style="position:absolute;inset:0;width:100%;height:100%;border:none"></iframe>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Close</button>
    </div>
  `);
}

function toggleManualNotes(open) {
  const panel = document.getElementById('manual_notes_panel');
  if (!panel) return;
  panel.classList.toggle('open', open);
  if (open) {
    const ta = document.getElementById('manual_notes_textarea');
    if (ta) setTimeout(() => ta.focus(), 200);
  }
}

async function loadManualNote(manual_id) {
  const ta = document.getElementById('manual_notes_textarea');
  if (!ta) return;
  ta.value = '';
  ta.disabled = true;
  const r = await api('getManualNote', { manual_id });
  ta.disabled = false;
  if (r.ok) ta.value = r.notes || '';
}

async function saveManualNote(manual_id) {
  const ta = document.getElementById('manual_notes_textarea');
  const status = document.getElementById('manual_notes_status');
  if (!ta) return;
  const notes = ta.value;
  if (status) status.textContent = 'Saving…';
  const r = await api('saveManualNote', { manual_id, notes });
  if (!status) return;
  if (r.ok) {
    status.textContent = 'Saved';
    setTimeout(() => { if (status.textContent === 'Saved') status.textContent = ''; }, 1500);
  } else {
    status.textContent = 'Save failed';
  }
}

async function toggleFavorite(id) {
  const r = await api('toggleManualFavorite', { manual_id: id });
  if (r.ok) {
    const manual = STATE.manuals.find(m => m.id === id);
    if (manual) manual.is_favorite = r.favorited;
    renderManualsList();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   VIDEOS (parallel to manuals — Drive-hosted)
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadVideos() {
  const r = await api('getVideos');
  if (!r.ok) return;
  STATE.videos = r.videos;
  renderVideoFilters();
  renderVideosList();
}

function renderVideoFilters() {
  const categories = ['All', ...new Set(STATE.videos.flatMap(catNames))];
  const el = document.getElementById('videos_filter');
  el.innerHTML = categories.map(c => {
    const key = c.toLowerCase();
    return `<button class="filter-btn ${STATE.videosFilter === key ? 'active' : ''}"
      onclick="setVideoFilter('${key}')">${c}</button>`;
  }).join('');
}

function setVideoFilter(filter) {
  STATE.videosFilter = filter;
  renderVideoFilters();
  renderVideosList();
}

function filterVideos() { renderVideosList(); }

function renderVideosList() {
  const search = (document.getElementById('videos_search').value || '').toLowerCase();
  let filtered = STATE.videos;
  if (STATE.videosFilter !== 'all') filtered = filtered.filter(v => catNames(v).some(cn => cn.toLowerCase() === STATE.videosFilter));
  if (search) filtered = filtered.filter(v =>
    v.title.toLowerCase().includes(search) || (v.description || '').toLowerCase().includes(search) ||
    catNames(v).join(' ').toLowerCase().includes(search)
  );

  const el = document.getElementById('videos_list');
  if (filtered.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No videos found</p></div>';
    return;
  }

  el.innerHTML = filtered.map(v => `
    <div class="manual-item ${STATE.selectedVideo === v.id ? 'active' : ''}" onclick="selectVideo(${v.id})">
      <div class="manual-icon">&#127909;</div>
      <div class="manual-info">
        <div class="manual-title">${esc(v.title)}</div>
        <div class="manual-category">${esc(catNames(v).join(' · '))}</div>
      </div>
      <button class="manual-fav ${v.is_favorite ? 'favorited' : ''}" onclick="event.stopPropagation();toggleVideoFav(${v.id})">
        &#9733;
      </button>
    </div>`).join('');
}

function selectVideo(id) {
  STATE.selectedVideo = id;
  const video = STATE.videos.find(v => v.id === id);
  if (!video) return;

  const viewer = document.getElementById('videos_viewer');
  const playerPane = `<iframe class="manual-frame" src="${video.file_path}" allow="autoplay" allowfullscreen></iframe>`;

  const inManuals = video.manuals || [];
  const manualsBar = inManuals.length ? `
    <div class="manual-related-bar" style="flex:0 0 auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--border)">
      <span style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.04em">&#128196; In manuals</span>
      ${inManuals.map(m => `
        <button class="btn-secondary" style="font-size:13px;padding:6px 12px" onclick="go('manuals', ${m.id})">
          ${esc(m.title)}
        </button>`).join('')}
    </div>` : '';

  viewer.innerHTML = `
    <button class="manual-back-btn" onclick="closeVideo()" aria-label="Back to list">&larr;</button>
    <div class="manual-pane" style="flex-direction:column">
      ${manualsBar}
      <div style="flex:1;min-height:0;width:100%;display:flex">${playerPane}</div>
    </div>
    <aside class="manual-notes" id="video_notes_panel">
      <div class="manual-notes-header">
        <span>My Notes</span>
        <span class="manual-notes-status" id="video_notes_status"></span>
        <button class="manual-notes-close" onclick="toggleVideoNotes(false)" aria-label="Close notes">&times;</button>
      </div>
      <textarea id="video_notes_textarea"
        placeholder="Private notes for this video — only you see these.&#10;Auto-saves when you click away."
        onblur="saveVideoNote(${video.id})"></textarea>
    </aside>
    <button class="manual-notes-fab" onclick="toggleVideoNotes(true)" aria-label="Open notes">
      &#128221;
    </button>`;

  document.getElementById('page_videos').classList.add('viewing-manual');
  loadVideoNote(video.id);
  renderVideosList();
}

function closeVideo() {
  STATE.selectedVideo = null;
  document.getElementById('page_videos').classList.remove('viewing-manual');
  const viewer = document.getElementById('videos_viewer');
  viewer.innerHTML = `
    <div class="manuals-viewer-empty">
      <div class="empty-icon">&#127909;</div>
      <p>Select a video to play</p>
    </div>`;
  renderVideosList();
}

function toggleVideoNotes(open) {
  const panel = document.getElementById('video_notes_panel');
  if (!panel) return;
  panel.classList.toggle('open', open);
  if (open) {
    const ta = document.getElementById('video_notes_textarea');
    if (ta) setTimeout(() => ta.focus(), 200);
  }
}

async function loadVideoNote(video_id) {
  const ta = document.getElementById('video_notes_textarea');
  if (!ta) return;
  ta.value = '';
  ta.disabled = true;
  const r = await api('getVideoNote', { video_id });
  ta.disabled = false;
  if (r.ok) ta.value = r.notes || '';
}

async function saveVideoNote(video_id) {
  const ta = document.getElementById('video_notes_textarea');
  const status = document.getElementById('video_notes_status');
  if (!ta) return;
  const notes = ta.value;
  if (status) status.textContent = 'Saving…';
  const r = await api('saveVideoNote', { video_id, notes });
  if (!status) return;
  if (r.ok) {
    status.textContent = 'Saved';
    setTimeout(() => { if (status.textContent === 'Saved') status.textContent = ''; }, 1500);
  } else {
    status.textContent = 'Save failed';
  }
}

async function toggleVideoFav(id) {
  const r = await api('toggleVideoFavorite', { video_id: id });
  if (r.ok) {
    const video = STATE.videos.find(v => v.id === id);
    if (video) video.is_favorite = r.favorited;
    renderVideosList();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   FAVORITES (combined view of starred manuals + videos)
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadFavorites() {
  const [mr, vr] = await Promise.all([api('getManuals'), api('getVideos')]);
  const m = (mr.ok ? mr.manuals : []).filter(x => x.is_favorite).map(x => ({...x, _type: 'manual'}));
  const v = (vr.ok ? vr.videos : []).filter(x => x.is_favorite).map(x => ({...x, _type: 'video'}));
  STATE.favorites = [...m, ...v];
  renderFavoritesFilters();
  renderFavoritesList();
}

function renderFavoritesFilters() {
  const types = ['All', 'Manuals', 'Videos'];
  const el = document.getElementById('favorites_filter');
  el.innerHTML = types.map(t => {
    const key = t.toLowerCase();
    return `<button class="filter-btn ${STATE.favoritesFilter === key ? 'active' : ''}"
      onclick="setFavoritesFilter('${key}')">${t}</button>`;
  }).join('');
}

function setFavoritesFilter(filter) {
  STATE.favoritesFilter = filter;
  renderFavoritesFilters();
  renderFavoritesList();
}

function renderFavoritesList() {
  const search = (document.getElementById('favorites_search').value || '').toLowerCase();
  let filtered = STATE.favorites;
  if (STATE.favoritesFilter === 'manuals') filtered = filtered.filter(f => f._type === 'manual');
  else if (STATE.favoritesFilter === 'videos') filtered = filtered.filter(f => f._type === 'video');
  if (search) filtered = filtered.filter(f =>
    f.title.toLowerCase().includes(search) || (f.description || '').toLowerCase().includes(search)
  );

  const el = document.getElementById('favorites_list');
  if (filtered.length === 0) {
    el.innerHTML = `<div class="empty-state"><p>No favorites yet — tap the &#9733; on any manual or video to add one.</p></div>`;
    return;
  }

  el.innerHTML = filtered.map(f => {
    const icon = f._type === 'manual' ? '&#128196;' : '&#127909;';
    const typeLabel = f._type === 'manual' ? 'Manual' : 'Video';
    return `
      <div class="manual-item" onclick="openFavorite('${f._type}', ${f.id})">
        <div class="manual-icon">${icon}</div>
        <div class="manual-info">
          <div class="manual-title">${esc(f.title)}</div>
          <div class="manual-category">${typeLabel} &middot; ${esc(catNames(f).join(' · ') || f.category || '')}</div>
        </div>
        <button class="manual-fav favorited" onclick="event.stopPropagation();unfavoriteFromList('${f._type}', ${f.id})">
          &#9733;
        </button>
      </div>`;
  }).join('');
}

function openFavorite(type, id) {
  if (type === 'manual') go('manuals', id);
  else go('videos', id);
}

async function unfavoriteFromList(type, id) {
  if (type === 'manual') await api('toggleManualFavorite', { manual_id: id });
  else await api('toggleVideoFavorite', { video_id: id });
  STATE.favorites = STATE.favorites.filter(f => !(f._type === type && f.id === id));
  renderFavoritesList();
}

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN
   ═══════════════════════════════════════════════════════════════════════════ */
function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('admin_' + tab).classList.add('active');

  if (tab === 'progress' || tab === 'assignments') populateModuleSelects();
  if (tab === 'manuals') loadAdminManuals();
  if (tab === 'videos') loadAdminVideos();
  if (tab === 'categories') loadAdminCategories();
}

async function loadAdminData() {
  const r = await api('admin/getModules');
  if (!r.ok) { STATE.adminModules = []; }
  else STATE.adminModules = r.modules;
  renderAdminModuleList();
  populateModuleSelects();

  const sr = await api('admin/getStaff');
  if (sr.ok) STATE.staffList = sr.staff;
}

function populateModuleSelects() {
  ['progress_module_select', 'assign_module_select'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const val = el.value;
    el.innerHTML = '<option value="">-- Select Module --</option>' +
      STATE.adminModules.map(m => `<option value="${m.id}">${esc(m.title)}</option>`).join('');
    el.value = val;
  });
}

function renderAdminModuleList() {
  const el = document.getElementById('admin_modules_list');
  document.getElementById('admin_module_list_view').style.display = '';
  document.getElementById('admin_module_editor').className = 'module-editor';

  if (STATE.adminModules.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">&#128218;</div><p>No modules yet. Create your first module!</p></div>';
    return;
  }

  el.innerHTML = STATE.adminModules.map(m => `
    <div class="admin-module-row">
      <div class="admin-module-info">
        <div class="admin-module-name">${esc(m.title)}</div>
        <div class="admin-module-meta">
          ${m.chapter_count || 0} chapters &middot; ${m.page_count || 0} pages &middot;
          ${m.assigned_count || 0} assigned &middot;
          ${m.is_published ? '<span style="color:var(--success)">Published</span>' : '<span style="color:var(--text3)">Draft</span>'}
        </div>
      </div>
      <div class="admin-module-actions">
        <div class="toggle-row" style="padding:0">
          <label class="admin-toggle">
            <input type="checkbox" ${m.is_published ? 'checked' : ''} onchange="togglePublish(${m.id}, this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <button onclick="event.stopPropagation();openSlideEditor(${m.id})" class="btn-secondary" style="color:var(--accent);border-color:var(--accent-bg2);background:var(--accent-bg)">Edit Slides</button>
        <button class="btn-secondary" onclick="editModule(${m.id})">Settings</button>
        <button class="btn-danger" onclick="deleteModule(${m.id})">Delete</button>
      </div>
    </div>`).join('');
}

function showCreateModuleModal() {
  showModal(`
    <h3>Create New Module</h3>
    <div class="form-group">
      <label class="form-label">Module Title</label>
      <input class="form-input" id="new_module_title" placeholder="e.g., Beginner Pole Technique">
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea class="form-input" id="new_module_desc" placeholder="Brief description of this module..."></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="createModule()">Create Module</button>
    </div>
  `);
}

async function createModule() {
  const title = document.getElementById('new_module_title').value.trim();
  if (!title) return toast('Enter a title', 'error');

  const r = await api('admin/createModule', {
    title,
    description: document.getElementById('new_module_desc').value.trim()
  });

  if (r.ok) {
    hideModal();
    toast('Module created! Opening editor...', 'success');
    // Go straight to slide editor
    openSlideEditor(r.module.id);
  }
}

async function togglePublish(id, published) {
  await api('admin/updateModule', { module_id: id, is_published: published });
  const m = STATE.adminModules.find(x => x.id === id);
  if (m) m.is_published = published;
  renderAdminModuleList();
}

async function deleteModule(id) {
  if (!confirm('Delete this module and all its content? This cannot be undone.')) return;
  const r = await api('admin/deleteModule', { module_id: id });
  if (r.ok) { toast('Module deleted', 'success'); loadAdminData(); }
}

async function editModule(moduleId) {
  const r = await api('getModule', { module_id: moduleId });
  if (!r.ok) return toast(r.reason, 'error');

  STATE.editingModule = r.module;
  STATE.editingChapters = r.chapters;
  const chapters = r.chapters;

  document.getElementById('admin_module_list_view').style.display = 'none';
  const editor = document.getElementById('admin_module_editor');
  editor.className = 'module-editor active';

  editor.innerHTML = `
    <div class="editor-header">
      <button class="btn-secondary" onclick="renderAdminModuleList()">&#8592; Back</button>
      <h3 style="flex:1;margin:0">${esc(r.module.title)}</h3>
      <button onclick="openSlideEditor(${r.module.id})" class="btn-secondary" style="color:var(--accent);border-color:var(--accent-bg2);background:var(--accent-bg)">Slide Editor</button>
      <button onclick="previewModule(${r.module.id})" class="btn-secondary">Preview</button>
      <button onclick="publishModule(${r.module.id}, ${!r.module.is_published})" class="btn-primary">${r.module.is_published ? 'Unpublish' : 'Publish Module'}</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div class="form-group">
        <label class="form-label">Module Title</label>
        <input class="form-input" id="edit_module_title" value="${esc(r.module.title)}" onchange="saveModuleField()">
      </div>
      <div class="form-group">
        <label class="form-label">Cover Image</label>
        <div style="display:flex;gap:8px">
          <input class="form-input" id="edit_module_cover" value="${esc(r.module.cover_image || '')}" onchange="saveModuleField()" placeholder="URL or upload" style="flex:1">
          <label class="btn-secondary" style="cursor:pointer;display:flex;align-items:center">
            Upload
            <input type="file" accept="image/*" style="display:none" onchange="uploadCoverImage(this)">
          </label>
        </div>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea class="form-input" id="edit_module_desc" onchange="saveModuleField()" style="min-height:60px">${esc(r.module.description || '')}</textarea>
    </div>

    <div class="page-edit-section" style="margin-bottom:24px">
      <h4>Import Content from File</h4>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px">Upload a .pdf or .doc - each PDF page becomes a separate slide.</p>
      <label class="btn-primary" style="cursor:pointer;display:inline-flex;align-items:center;gap:8px">
        Upload .pdf / .doc
        <input type="file" accept=".pdf,.doc,.docx" style="display:none" onchange="importModuleFile(this)">
      </label>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h3 style="font-family:var(--font-display);font-size:18px;font-weight:600;margin:0">Chapters</h3>
      <button class="btn-primary" onclick="addChapter()">+ Add Chapter</button>
    </div>
    <div id="chapter_editor_list" class="chapter-editor-list">
      ${chapters.length === 0 ? '<div class="empty-state" style="padding:32px"><p>No chapters yet. Add a chapter or import a file above.</p></div>' : chapters.map(ch => renderChapterEditor(ch)).join('')}
    </div>
  `;
}

function renderChapterEditor(ch) {
  const pages = ch.pages || [];
  const allChapters = STATE.editingChapters || [];
  const otherChapters = allChapters.filter(c => c.id !== ch.id);

  return `
    <div class="chapter-editor-item" data-chapter-id="${ch.id}">
      <div class="chapter-editor-header" onclick="this.nextElementSibling.classList.toggle('expanded')">
        <h4>${esc(ch.title)}</h4>
        <span style="font-size:12px;color:var(--text3)">${pages.length} pages</span>
        <button class="btn-secondary" style="margin-left:auto;margin-right:8px" onclick="event.stopPropagation();renameChapter(${ch.id},'${esc(ch.title)}')">Rename</button>
        <button class="btn-danger" onclick="event.stopPropagation();deleteChapter(${ch.id})">Delete</button>
      </div>
      <div class="chapter-editor-body">
        ${pages.map((pg, idx) => `
          <div class="page-editor-row">
            <div style="display:flex;flex-direction:column;gap:2px;margin-right:4px">
              ${idx > 0 ? `<button onclick="movePageOrder(${pg.id}, ${ch.id}, 'up')" style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:11px;padding:1px 4px;line-height:1" title="Move up">&#9650;</button>` : '<span style="width:16px"></span>'}
              ${idx < pages.length - 1 ? `<button onclick="movePageOrder(${pg.id}, ${ch.id}, 'down')" style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:11px;padding:1px 4px;line-height:1" title="Move down">&#9660;</button>` : ''}
            </div>
            <span class="page-title">${esc(pg.title || 'Untitled')}</span>
            <span class="page-type">${pg.video_url ? '&#127909; Video' : '&#128196; Text'}</span>
            ${otherChapters.length > 0 ? `
              <select onchange="movePageToChapter(${pg.id}, this.value)" style="padding:4px 8px;border-radius:var(--radius-full);background:var(--surface2);color:var(--text2);font-size:11px;border:1px solid var(--border);cursor:pointer;max-width:120px">
                <option value="">Move to...</option>
                ${otherChapters.map(oc => `<option value="${oc.id}">${esc(oc.title)}</option>`).join('')}
              </select>
            ` : ''}
            <button class="btn-secondary" onclick="editPageModal(${ch.id}, ${pg.id})">Edit</button>
            <button class="btn-danger" onclick="deletePage(${pg.id})">&#10005;</button>
          </div>
        `).join('')}
        <button onclick="addPage(${ch.id})" class="btn-primary" style="width:100%;margin-top:10px">+ Add Page</button>
      </div>
    </div>`;
}

async function previewModule(moduleId) {
  try {
    const r = await api('getModule', { module_id: moduleId });
    if (!r.ok) return toast(r.reason, 'error');

    STATE.viewerModule = r.module;
    STATE.viewerChapters = r.chapters;

    STATE.viewerFlatPages = [];
    for (const ch of r.chapters) {
      if (!ch.pages) ch.pages = [];
      for (const pg of ch.pages) {
        pg.user_completed = false;
        pg.user_video_watched = false;
        STATE.viewerFlatPages.push({ ...pg, chapter_title: ch.title, chapter_id: ch.id, user_completed: false, user_video_watched: false });
      }
    }

    if (STATE.viewerFlatPages.length === 0) {
      return toast('No pages to preview', 'error');
    }

    STATE.viewerPageIndex = 0;
    STATE._previewMode = true;

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.header-nav button').forEach(b => b.classList.remove('active'));
    document.getElementById('page_module_viewer').classList.add('active');
    STATE.currentPage = 'viewer';

    renderViewer();
  } catch(e) {
    console.error('Preview error:', e);
    toast('Preview failed', 'error');
  }
}

async function publishModule(moduleId, publish) {
  await api('admin/updateModule', { module_id: moduleId, is_published: publish });
  toast(publish ? 'Module published!' : 'Module unpublished', 'success');
  const sr = await api('admin/getModules');
  if (sr.ok) STATE.adminModules = sr.modules;
  editModule(moduleId);
}

async function saveModuleField() {
  const id = STATE.editingModule.id;
  await api('admin/updateModule', {
    module_id: id,
    title: document.getElementById('edit_module_title').value.trim(),
    description: document.getElementById('edit_module_desc').value.trim(),
    cover_image: document.getElementById('edit_module_cover').value.trim()
  });
}

async function uploadCoverImage(input) {
  if (!input.files[0]) return;
  const r = await apiUpload('backgrounds', input.files[0]);
  if (r.ok) {
    document.getElementById('edit_module_cover').value = r.filePath;
    saveModuleField();
    toast('Cover image uploaded', 'success');
  }
}

async function addChapter() {
  const title = prompt('Chapter title:');
  if (!title) return;
  const r = await api('admin/createChapter', { module_id: STATE.editingModule.id, title });
  if (r.ok) { toast('Chapter added', 'success'); editModule(STATE.editingModule.id); }
}

async function renameChapter(id, current) {
  const title = prompt('Chapter title:', current);
  if (!title || title === current) return;
  await api('admin/updateChapter', { chapter_id: id, title });
  editModule(STATE.editingModule.id);
}

async function deleteChapter(id) {
  if (!confirm('Delete this chapter and all its pages?')) return;
  await api('admin/deleteChapter', { chapter_id: id });
  toast('Chapter deleted', 'success');
  editModule(STATE.editingModule.id);
}

async function addPage(chapterId) {
  showModal(`
    <h3>Add Page</h3>
    <div class="page-edit-sections">
      <div class="form-group">
        <label class="form-label">Page Title</label>
        <input class="form-input" id="page_title" placeholder="Page title">
      </div>
      <div class="page-edit-section">
        <h4>Video (optional)</h4>
        <div class="form-group">
          <label class="form-label">YouTube or Google Drive Link</label>
          <input class="form-input" id="page_video" placeholder="https://youtube.com/watch?v=...">
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Video must be watched to continue</span>
          <label class="admin-toggle">
            <input type="checkbox" id="page_video_req" checked>
            <span class="slider"></span>
          </label>
        </div>
      </div>
      <div class="page-edit-section">
        <h4>Page Content</h4>
        <div class="editor-toolbar">
          <button onclick="execRich('bold')"><b>B</b></button>
          <button onclick="execRich('italic')"><i>I</i></button>
          <button onclick="execRich('underline')"><u>U</u></button>
          <button onclick="execRich('insertUnorderedList')">&#8226; List</button>
          <button onclick="execRich('insertOrderedList')">1. List</button>
          <button onclick="execRich('formatBlock','H2')">H2</button>
          <button onclick="execRich('formatBlock','H3')">H3</button>
        </div>
        <div class="rich-editor" id="page_content" contenteditable="true" style="border-top:none;border-radius:0 0 var(--radius-sm) var(--radius-sm)"></div>
      </div>
      <div class="page-edit-section">
        <h4>Background Image (optional)</h4>
        <input type="file" accept="image/*" id="page_bg_upload">
        <input class="form-input" id="page_bg_url" placeholder="Or enter image URL" style="margin-top:8px">
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="savePage(${chapterId})">Save Page</button>
    </div>
  `);
}

function execRich(cmd, val) {
  document.execCommand(cmd, false, val || null);
  document.getElementById('page_content').focus();
}

async function savePage(chapterId, pageId) {
  const title = document.getElementById('page_title').value.trim();
  const html = document.getElementById('page_content').innerHTML;
  const videoUrl = document.getElementById('page_video').value.trim();
  const videoReq = document.getElementById('page_video_req').checked;
  let bgImage = document.getElementById('page_bg_url').value.trim();

  const bgFile = document.getElementById('page_bg_upload').files[0];
  if (bgFile) {
    const r = await apiUpload('backgrounds', bgFile);
    if (r.ok) bgImage = r.filePath;
  }

  const data = {
    chapter_id: chapterId, title, content_type: 'rich_text',
    content: { html }, video_url: videoUrl,
    video_required: videoReq, background_image: bgImage
  };

  let r;
  if (pageId) { data.page_id = pageId; r = await api('admin/updatePage', data); }
  else r = await api('admin/createPage', data);

  if (r.ok) { hideModal(); toast(pageId ? 'Page updated' : 'Page added', 'success'); editModule(STATE.editingModule.id); }
}

async function editPageModal(chapterId, pageId) {
  const modR = await api('getModule', { module_id: STATE.editingModule.id });
  if (!modR.ok) return;

  let page = null;
  for (const ch of modR.chapters) {
    for (const pg of (ch.pages || [])) {
      if (pg.id === pageId) { page = pg; break; }
    }
    if (page) break;
  }
  if (!page) return toast('Page not found', 'error');

  const contentData = typeof page.content === 'string' ? JSON.parse(page.content || '{}') : (page.content || {});
  const chapterOptions = modR.chapters.map(ch =>
    `<option value="${ch.id}" ${ch.id === chapterId ? 'selected' : ''}>${esc(ch.title)}</option>`
  ).join('');

  showModal(`
    <h3>Edit Page</h3>
    <div class="page-edit-sections">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label class="form-label">Page Title</label>
          <input class="form-input" id="page_title" value="${esc(page.title || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Chapter</label>
          <select class="form-input" id="page_chapter_select">${chapterOptions}</select>
        </div>
      </div>
      <div class="page-edit-section">
        <h4>Video</h4>
        <div class="form-group">
          <label class="form-label">YouTube or Google Drive Link</label>
          <input class="form-input" id="page_video" value="${esc(page.video_url || '')}" placeholder="https://youtube.com/watch?v=...">
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Video must be watched to continue</span>
          <label class="admin-toggle">
            <input type="checkbox" id="page_video_req" ${page.video_required ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
      </div>
      <div class="page-edit-section">
        <h4>Page Content</h4>
        <div class="editor-toolbar">
          <button onclick="execRich('bold')"><b>B</b></button>
          <button onclick="execRich('italic')"><i>I</i></button>
          <button onclick="execRich('underline')"><u>U</u></button>
          <button onclick="execRich('insertUnorderedList')">&#8226; List</button>
          <button onclick="execRich('insertOrderedList')">1. List</button>
          <button onclick="execRich('formatBlock','H2')">H2</button>
          <button onclick="execRich('formatBlock','H3')">H3</button>
        </div>
        <div class="rich-editor" id="page_content" contenteditable="true" style="border-top:none;border-radius:0 0 var(--radius-sm) var(--radius-sm)">${contentData.html || ''}</div>
      </div>
      <div class="page-edit-section">
        <h4>Background Image</h4>
        <input type="file" accept="image/*" id="page_bg_upload">
        <input class="form-input" id="page_bg_url" value="${esc(page.background_image || '')}" placeholder="Image URL" style="margin-top:8px">
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="savePage(document.getElementById('page_chapter_select').value, ${pageId})">Update Page</button>
    </div>
  `);
}

async function deletePage(pageId) {
  if (!confirm('Delete this page?')) return;
  await api('admin/deletePage', { page_id: pageId });
  toast('Page deleted', 'success');
  editModule(STATE.editingModule.id);
}

async function loadAdminManuals() {
  const r = await api('getManuals');
  if (!r.ok) return;
  STATE.adminManuals = r.manuals;

  const el = document.getElementById('admin_manuals_list');
  if (r.manuals.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No manuals uploaded yet</p></div>';
    return;
  }

  el.innerHTML = r.manuals.map(m => `
    <div class="admin-module-row">
      <div class="admin-module-info">
        <div class="admin-module-name">${esc(m.title)}</div>
        <div class="admin-module-meta">${esc(catNames(m).join(' · ') || 'No category')} &middot; ${m.file_type.toUpperCase()}</div>
      </div>
      <div class="admin-module-actions">
        <button class="btn-secondary" onclick="editManualModal(${m.id}, '${esc(m.title)}', '${esc(m.description || '')}', '${esc(m.category)}')">Edit</button>
        <button class="btn-danger" onclick="deleteManual(${m.id})">Delete</button>
      </div>
    </div>`).join('');
}

async function uploadManual(input) {
  if (!input.files[0]) return;
  const file = input.files[0];
  const ext = file.name.split('.').pop().toLowerCase();

  const r = await apiUpload('manuals', file);
  if (!r.ok) return toast('Upload failed', 'error');

  const defaultTitle = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');

  showModal(`
    <h3>Manual Details</h3>
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="manual_title" value="${esc(defaultTitle)}">
    </div>
    <div class="form-group">
      <label class="form-label">Category</label>
      <input class="form-input" id="manual_category" value="General" placeholder="e.g., Pole, Aerial, Flexibility">
    </div>
    <div class="form-group">
      <label class="form-label">Description (optional)</label>
      <textarea class="form-input" id="manual_description" placeholder="Brief description..."></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="saveManualDetails('${r.filePath}', '${ext}')">Save Manual</button>
    </div>
  `);
}

async function saveManualDetails(filePath, fileType) {
  const r = await api('admin/createManual', {
    title: document.getElementById('manual_title').value.trim(),
    description: document.getElementById('manual_description').value.trim(),
    category: document.getElementById('manual_category').value.trim() || 'General',
    file_path: filePath,
    file_type: fileType === 'pdf' ? 'pdf' : 'doc'
  });
  if (r.ok) { hideModal(); toast('Manual uploaded!', 'success'); loadAdminManuals(); }
}

async function editManualModal(id, title, desc, category) {
  const manual = (STATE.adminManuals || []).find(m => m.id === id);
  const selVideoIds = manual ? (manual.video_ids || []) : [];
  // Need the full videos list to build the picker; reuse the cached admin list,
  // otherwise fetch it.
  let videos = STATE.adminVideos;
  if (!videos || !videos.length) {
    const vr = await api('getVideos');
    videos = vr.ok ? vr.videos : [];
    STATE.adminVideos = videos;
  }
  const vidCats = [...new Set(videos.flatMap(catNames))].sort();
  showModal(`
    <h3>Edit Manual</h3>
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="edit_manual_title" value="${title}">
    </div>
    <div class="form-group">
      <label class="form-label">Categories</label>
      <div id="edit_manual_cats" style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:2px 12px"><div style="padding:8px;color:var(--text3);font-size:13px">Loading…</div></div>
      <button type="button" class="btn-secondary" style="margin-top:6px;font-size:13px" onclick="addChecklistCategory('edit_manual_cats','manual')">+ New category</button>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea class="form-input" id="edit_manual_desc">${desc}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Attached Videos</label>
      ${/pole\s*[1-5]/i.test(title) ? `
      <button type="button" class="btn-primary" style="width:100%;margin-bottom:8px" onclick="autoSelectManualVideos()">
        &#10024; Auto-select videos taught in this manual
      </button>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <select class="form-input" id="mv_bulk_cat" style="flex:1;min-width:140px">
          <option value="__ALL__">All videos</option>
          ${vidCats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
        </select>
        <button type="button" class="btn-secondary" style="padding:8px 12px;white-space:nowrap" onclick="mvBulkSelect(true)">Select all</button>
        <button type="button" class="btn-secondary" style="padding:8px 12px;white-space:nowrap" onclick="mvBulkSelect(false)">Clear</button>
      </div>
      <div id="manual_videos_picker" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:2px 12px">
        ${renderLinkPicker(videos, selVideoIds, 'mv-check', 'No videos yet — add one first.')}
      </div>
      <div class="upload-hint" style="margin-top:6px;color:var(--text3);font-size:12px">
        Pick a category and hit "Select all" to attach every video in it, then Save.
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="updateManual(${id})">Save</button>
    </div>
  `);
  populateCategoryChecklist('edit_manual_cats', 'manual', manual ? catNames(manual) : (category ? [category] : []));
}

// The videos each POLE manual (levels 1-5) teaches, extracted from the manual
// PDFs (every video is referenced as "<Move Name> Video"). Used by the manual
// editor's "Auto-select" button to tick the matching videos in one tap.
const POLE_LEVEL_VIDEOS = {
  1: ["Body Walk Down", "Basic Get Down", "Cat Get Down", "Push Ups", "Cat Push Ups", "Cat Spirals", "Rocking Cats", "Kneeling & Travelling Hip Circles", "One Legged & Two Legged Clock", "Crickets", "Leg Splay", "Mud Flap", "Peek A Boos", "Sexy Bicycle", "Sensual Get Up", "Tuck To Peel Up", "Assisted Pole Ups", "Body Waves", "Cupid Crunches", "Squat with back to pole", "Step Kick Squat", "Backwards Spin", "Big Dip", "Chair Spin", "Fankick", "Firefighter Spin", "Front Hook Spin", "L Turns", "Pole Over", "Pole Slide", "Pole Turns", "Side to Side", "Walking around the pole", "Pole 1 Routine"],
  2: ["Aradia Push Ups", "Reverse Crunch to Splay", "Shoulder stand", "Backwards Shoulder Roll", "Floor Fankicks", "Cartwheel Get Up", "Lunge Sweep Get Up", "Mini Firefighter Get Up", "Split Grip Get Up", "Baseball Climb", "Basic Inversion", "Climb Prep Squats - on the floor", "Inversion Preps - Laying Down", "Inversion preps from seated and knees", "Pole Hold", "Pole Sit - Crossed Leg", "Pole Sit - Straight Leg", "Shoulder Mount Prep - Kneeling", "Shoulder Mount Prep - Laying Down", "Shoulder Mount Preps- Standing", "Split Grip Preps", "Static Diamond", "Static Boomerang", "Static Corkscrew", "Upright Crucifix", "Cupid Crunches", "Jump & Hold", "Jump & Spin", "Pole Burpees", "Ballerina Spin", "Straight Leg Ballerina Spin", "Big Dip to Backwards Spin", "Boomerang Spin", "Chair to Front Hook Spin", "Cross Leg Chair Spin", "Kneeling Chair Spin", "Passe Chair Spin", "Compass Spin", "Corkscrew Spin", "Diamond Spin", "1 handed Front Hook Spin", "Attitude Firefighter", "Firefighter Martini Spin", "Straight Leg Firefighter Spin", "One Hand Firefighter Spin", "Pole Over Spin", "Advanced Pole Over Spin", "Side Spin", "Backwards Sunwheel Spin", "Sunwheel Spin", "Switcharoo Spin", "Body Walk Down with the Pole", "Half Moons", "Figure 8's", "Pirouettes", "S Steps"],
  3: ["Aerial Invert Preps", "Exploding V", "Flag Preps", "Handstand Preps", "Helicopter Preps", "Side Strength Hold", "Static Sunwheel", "Forearm Climb", "Side Climb", "Fankick to Crossed Leg Pole Sit", "Fankick to Pole Sit Layout", "Fankick to Straight Leg Pole Sit", "Martini Sit", "Pole Sit Layout", "Scissor Sit", "Chair - 1 handed", "Chimney Sweep Spin", "Fairy Walks", "Foldover Ballerina", "Juliette Spin", "Spiral Spin", "Butterfly", "Descending Angel", "Helicopter", "Inverted Crucifix", "Invert To Cartwheel", "Invert to Snake Out", "Invert to Superman Legs Out", "Invert to Twist Out", "Outside Leg knee Hook", "Upside down Chair", "Birds Nest from the Floor", "Bow and Arrow", "Genie from the Floor", "Hood Ornament", "Jamilla", "Jasmine from the floor", "Straight Leg Jasmine"],
  4: ["Aerial Boomerang Hold", "Aerial Invert", "Caterpillar Bodywaves", "Flag", "Side Split Prep", "Shoulder Mount Inversion", "Reiko", "Reverse Shoulder Mount", "Superman Preps", "No Leg Climb", "Swing Climb", "Ball Sit", "Remi Sit", "Russian Sit", "Scissor Sit Switches", "Twisted Wrist Seat", "Wrist Seat", "Backdrop", "Cobra", "Hawaii", "Pretzel", "Rockstar", "Spiral to Chair", "Birds Nest", "Butterfly to Bow and Arrow", "Butterfly to Inverted Split", "Croissant", "Cross Ankle Release", "Cupid", "Dragonfly", "Extended Butterfly", "Flatline Scorpio", "Genie", "Hip Hold Pike & Straddle", "Inside Leg Hand", "Inverted D", "Martini Sit", "Outside Leg Hang", "Sleeping Beauty", "Stargazer", "Superman from Jasmine"],
  5: ["Aerial Shoulder Mount", "Body Switch", "Funny Grip Fankick", "Iguana Deadlift", "Jade Split from the Floor", "Baby & Machine Gun", "Reiko to Step Up", "Shoulder Mount Grip Variations", "Twisted Grip Pole Handstand", "Upright Elbow Pit Boomerang & Diamond", "Caterpillar Body waves & Climb", "Circus Climb", "Devils Point Shuffle", "No Leg Climb", "Backwards Spin to Invert", "Oona Spin", "Rockstar Spin", "Allegra", "Archer", "Ayesha grip variations", "Ball Drop", "Brass Monkey From Ayesha", "Brass Monkey from Croissant", "Brass Monkey from Kick Up", "Gargoyle", "Holly Drop from Jasmine", "Iguana Deadlift/Kick Up", "Jade & Dutchess", "Knee Hold", "Leg Switches", "Pegasus", "Reverse Ayesha", "Russian Layback", "Seahorse", "Side Saddle Superman", "Skittles Drop", "Superman From Jasmine"],
};

// Normalize a name for fuzzy matching: lowercase, punctuation → spaces, drop a
// trailing "video", collapse whitespace.
function _normVideoName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')      // strip a file extension
    .replace(/\bvideo\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tick every video in the manual editor whose title matches a move taught by
// this manual's pole level (detected from the title). Reports what it matched.
function autoSelectManualVideos() {
  const titleEl = document.getElementById('edit_manual_title');
  const title = titleEl ? titleEl.value : '';
  const m = title.match(/pole\s*([1-5])/i);
  if (!m) {
    return toast('Auto-select only works on manuals titled "Pole 1"–"Pole 5"', 'error');
  }
  const level = parseInt(m[1], 10);
  const moves = (POLE_LEVEL_VIDEOS[level] || []).map(_normVideoName).filter(Boolean);
  const boxes = document.querySelectorAll('#manual_videos_picker input.mv-check');
  const matchedMoves = new Set();
  let ticked = 0;
  boxes.forEach(b => {
    const vt = _normVideoName(b.getAttribute('data-title'));
    if (!vt) return;
    const hit = moves.find(mv => mv === vt ||
      (mv.length >= 4 && vt.length >= 4 && (vt.includes(mv) || mv.includes(vt))));
    if (hit) { b.checked = true; ticked++; matchedMoves.add(hit); }
  });
  const missing = moves.length - matchedMoves.size;
  toast(`Pole ${level}: ticked ${ticked} video${ticked === 1 ? '' : 's'}` +
    (missing > 0 ? ` · ${missing} taught move${missing === 1 ? '' : 's'} had no matching video` : '') +
    ' — review, then Save', 'success');
}

// Check/uncheck every video row in the manual editor that matches the chosen
// category (or all of them). Lets you attach a whole level's videos in one tap.
function mvBulkSelect(check) {
  const catEl = document.getElementById('mv_bulk_cat');
  const cat = catEl ? catEl.value : '__ALL__';
  const boxes = document.querySelectorAll('#manual_videos_picker input.mv-check');
  let n = 0;
  boxes.forEach(b => {
    const cats = (b.getAttribute('data-cat') || '').split('|');
    if (cat === '__ALL__' || cats.includes(cat)) { b.checked = check; n++; }
  });
  toast(`${check ? 'Selected' : 'Cleared'} ${n} video${n === 1 ? '' : 's'} — hit Save to apply`, 'success');
}

async function updateManual(id) {
  const categoryIds = checklistCheckedIds('edit_manual_cats');
  const videoIds = Array.from(
    document.querySelectorAll('#manual_videos_picker input.mv-check:checked')
  ).map(c => parseInt(c.value, 10));
  await api('admin/updateManual', {
    manual_id: id,
    title: document.getElementById('edit_manual_title').value.trim(),
    description: document.getElementById('edit_manual_desc').value.trim()
  });
  await api('admin/setManualCategories', { manual_id: id, category_ids: categoryIds });
  await api('admin/setManualVideos', { manual_id: id, video_ids: videoIds });
  hideModal(); toast('Manual updated', 'success'); loadAdminManuals();
}

async function deleteManual(id) {
  if (!confirm('Delete this manual?')) return;
  const r = await api('admin/deleteManual', { manual_id: id });
  if (r.ok) { toast('Manual deleted', 'success'); loadAdminManuals(); }
}

function extractDriveFileId(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  let m = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  m = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  m = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

// Renders a checklist (toggle rows) of all categories for a surface, checking
// those whose NAME is in selectedNames (works for both join-backed and
// text-fallback categories). Checkboxes carry value=id and data-name.
async function populateCategoryChecklist(containerId, surface, selectedNames) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const r = await api('getCategories', { for: surface });
  const cats = r.ok ? r.categories : [];
  const sel = new Set((selectedNames || []).map(n => String(n).toLowerCase()));
  el.innerHTML = cats.length ? cats.map(c => `
    <div class="toggle-row">
      <span>${esc(c.name)}</span>
      <label class="admin-toggle">
        <input type="checkbox" value="${c.id}" data-name="${esc(c.name)}" ${sel.has(c.name.toLowerCase()) ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
    </div>`).join('') : '<div style="color:var(--text3);padding:8px 2px;font-size:13px">No categories yet — add one below.</div>';
}

function checklistCheckedIds(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`))
    .map(c => parseInt(c.value, 10));
}
function checklistCheckedNames(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`))
    .map(c => c.getAttribute('data-name'));
}

// Add a brand-new category from within a checklist, preserving current picks.
async function addChecklistCategory(containerId, surface) {
  const name = prompt('New category name:');
  if (!name || !name.trim()) return;
  // Inline categories are general-purpose so they always show in the editor
  // you made them from (and the other one too).
  const r = await api('admin/createCategory', { name: name.trim(), applies_to: 'both' });
  if (!r.ok) return toast(r.reason || 'Failed to add category', 'error');
  const keep = checklistCheckedNames(containerId);
  keep.push(r.category.name);
  await populateCategoryChecklist(containerId, surface, keep);
  toast(r.existed ? 'Category already existed' : 'Category added', 'success');
}

async function populateCategorySelect(elementId, surface, selectedName) {
  const sel = document.getElementById(elementId);
  if (!sel) return;
  const r = await api('getCategories', { for: surface });
  const cats = r.ok ? r.categories : [];
  sel.innerHTML = `
    <option value="">— Select category —</option>
    ${cats.map(c => `<option value="${esc(c.name)}" ${selectedName && c.name === selectedName ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    <option value="__ADD_NEW__">+ Add new category…</option>
  `;
}

async function handleCategoryChange(selectEl, surface) {
  if (selectEl.value !== '__ADD_NEW__') return;
  const name = prompt('New category name:');
  if (!name || !name.trim()) { selectEl.value = ''; return; }
  const trimmed = name.trim();
  const r = await api('admin/createCategory', { name: trimmed, applies_to: surface });
  if (!r.ok) {
    toast(r.reason || 'Failed to add category', 'error');
    selectEl.value = '';
    return;
  }
  const opt = document.createElement('option');
  opt.value = r.category.name;
  opt.textContent = r.category.name;
  const addNewOpt = selectEl.querySelector('option[value="__ADD_NEW__"]');
  selectEl.insertBefore(opt, addNewOpt);
  selectEl.value = r.category.name;
  toast(r.existed ? 'Category already existed' : 'Category added', 'success');
}

function addDriveManualModal() {
  showModal(`
    <h3>Add Manual from Google Drive</h3>
    <div class="form-group">
      <label class="form-label">Google Drive link</label>
      <input class="form-input" id="drive_url" placeholder="https://drive.google.com/file/d/.../view">
      <div class="upload-hint" style="margin-top:6px;color:var(--text3);font-size:12px">
        PDF must be shared as "Anyone with the link can view"
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="drive_title" placeholder="e.g. Pole 101 Manual">
    </div>
    <div class="form-group">
      <label class="form-label">Category</label>
      <select class="form-input" id="drive_category" onchange="handleCategoryChange(this, 'manual')">
        <option>Loading categories…</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Description (optional)</label>
      <textarea class="form-input" id="drive_description" placeholder="Brief description..."></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="saveDriveManual()">Save</button>
    </div>
  `);
  populateCategorySelect('drive_category', 'manual');
}

async function saveDriveManual() {
  const url = document.getElementById('drive_url').value;
  const title = document.getElementById('drive_title').value.trim();
  const catSel = document.getElementById('drive_category').value;
  const category = (catSel && catSel !== '__ADD_NEW__') ? catSel : 'General';
  const description = document.getElementById('drive_description').value.trim();

  const fileId = extractDriveFileId(url);
  if (!fileId) return toast('That doesn\'t look like a Google Drive link', 'error');
  if (!title) return toast('Please enter a title', 'error');

  const file_path = `https://drive.google.com/file/d/${fileId}/preview`;
  const r = await api('admin/createManual', {
    title, description, category, file_path, file_type: 'pdf'
  });
  if (r.ok) {
    hideModal();
    toast('Manual added from Drive', 'success');
    loadAdminManuals();
  } else {
    toast(r.reason || 'Failed to add manual', 'error');
  }
}

/* ─── Admin: Videos ─── */
async function loadAdminVideos() {
  const r = await api('getVideos');
  if (!r.ok) return;
  STATE.adminVideos = r.videos;

  const el = document.getElementById('admin_videos_list');
  if (r.videos.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No videos added yet</p></div>';
    return;
  }

  el.innerHTML = r.videos.map(v => `
    <div class="admin-module-row">
      <div class="admin-module-info">
        <div class="admin-module-name">${esc(v.title)}</div>
        <div class="admin-module-meta">${esc(catNames(v).join(' · ') || 'No category')}</div>
      </div>
      <div class="admin-module-actions">
        <button class="btn-secondary" onclick="editVideoModal(${v.id}, '${esc(v.title)}', '${esc(v.description || '')}', '${esc(v.category)}')">Edit</button>
        <button class="btn-danger" onclick="deleteVideo(${v.id})">Delete</button>
      </div>
    </div>`).join('');
}

// Upload a video file straight to Bunny Stream (primary path). Shows an upload
// progress bar; on success it creates the edu_videos row via createVideo with
// the Bunny embed URL as file_path, so every iframe player just works.
function uploadBunnyVideoModal() {
  showModal(`
    <h3>Upload a Video</h3>
    <div class="form-group">
      <label class="form-label">Video file</label>
      <input class="form-input" type="file" id="bv_file" accept="video/*">
      <div class="upload-hint" style="margin-top:6px;color:var(--text3);font-size:12px">
        MP4, MOV or WebM. Uploads to your Bunny video library and encodes automatically.
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="bv_title" placeholder="e.g. Aerial Hoop Beat Drop">
    </div>
    <div class="form-group">
      <label class="form-label">Category</label>
      <select class="form-input" id="bv_category" onchange="handleCategoryChange(this, 'video')">
        <option>Loading categories…</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Description (optional)</label>
      <textarea class="form-input" id="bv_description" placeholder="Brief description..."></textarea>
    </div>
    <div id="bv_progress" style="display:none;margin-bottom:12px">
      <div style="height:8px;background:var(--accent-bg2,#333);border-radius:4px;overflow:hidden">
        <div id="bv_bar" style="height:100%;width:0;background:var(--accent,#e8465a);transition:width .2s"></div>
      </div>
      <div id="bv_pct" style="font-size:12px;color:var(--text3);margin-top:6px">Uploading… 0%</div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" id="bv_save" onclick="saveBunnyVideo()">Upload</button>
    </div>
  `);
  populateCategorySelect('bv_category', 'video');
}

function saveBunnyVideo() {
  const fileEl = document.getElementById('bv_file');
  const file = fileEl && fileEl.files[0];
  const title = document.getElementById('bv_title').value.trim();
  const catSel = document.getElementById('bv_category').value;
  const category = (catSel && catSel !== '__ADD_NEW__') ? catSel : 'General';
  const description = document.getElementById('bv_description').value.trim();

  if (!file) return toast('Please choose a video file', 'error');
  if (!title) return toast('Please enter a title', 'error');

  const saveBtn = document.getElementById('bv_save');
  const prog = document.getElementById('bv_progress');
  const bar = document.getElementById('bv_bar');
  const pct = document.getElementById('bv_pct');
  saveBtn.disabled = true; saveBtn.textContent = 'Uploading…';
  prog.style.display = 'block';

  const fd = new FormData();
  fd.append('file', file);
  fd.append('email', STATE.email);
  fd.append('pin', STATE.pin);
  fd.append('title', title);

  // XHR (not fetch) so we can show real upload progress for large files.
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/admin/uploadVideoBunny');
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const p = Math.round((e.loaded / e.total) * 100);
    bar.style.width = p + '%';
    pct.textContent = p >= 100 ? 'Processing on Bunny…' : `Uploading… ${p}%`;
  };
  xhr.onload = async () => {
    let resp; try { resp = JSON.parse(xhr.responseText); } catch (_) { resp = null; }
    if (!resp || !resp.ok) {
      saveBtn.disabled = false; saveBtn.textContent = 'Upload';
      prog.style.display = 'none';
      return toast((resp && resp.reason) || 'Upload failed', 'error');
    }
    const r = await api('admin/createVideo', {
      title, description, category,
      file_path: resp.file_path, file_type: resp.file_type || 'bunny_video'
    });
    if (r.ok) { hideModal(); toast('Video uploaded', 'success'); loadAdminVideos(); }
    else {
      saveBtn.disabled = false; saveBtn.textContent = 'Upload';
      toast(r.reason || 'Failed to save video', 'error');
    }
  };
  xhr.onerror = () => {
    saveBtn.disabled = false; saveBtn.textContent = 'Upload';
    prog.style.display = 'none';
    toast('Network error during upload', 'error');
  };
  xhr.send(fd);
}

function addDriveVideoModal() {
  showModal(`
    <h3>Add Video from Google Drive</h3>
    <div class="form-group">
      <label class="form-label">Google Drive link</label>
      <input class="form-input" id="dv_url" placeholder="https://drive.google.com/file/d/.../view">
      <div class="upload-hint" style="margin-top:6px;color:var(--text3);font-size:12px">
        Video must be shared as "Anyone with the link can view"
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="dv_title" placeholder="e.g. Aerial Hoop Beat Drop">
    </div>
    <div class="form-group">
      <label class="form-label">Category</label>
      <select class="form-input" id="dv_category" onchange="handleCategoryChange(this, 'video')">
        <option>Loading categories…</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Description (optional)</label>
      <textarea class="form-input" id="dv_description" placeholder="Brief description..."></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="saveDriveVideo()">Save</button>
    </div>
  `);
  populateCategorySelect('dv_category', 'video');
}

async function saveDriveVideo() {
  const url = document.getElementById('dv_url').value;
  const title = document.getElementById('dv_title').value.trim();
  const catSel = document.getElementById('dv_category').value;
  const category = (catSel && catSel !== '__ADD_NEW__') ? catSel : 'General';
  const description = document.getElementById('dv_description').value.trim();

  const fileId = extractDriveFileId(url);
  if (!fileId) return toast('That doesn\'t look like a Google Drive link', 'error');
  if (!title) return toast('Please enter a title', 'error');

  const file_path = `https://drive.google.com/file/d/${fileId}/preview`;
  const r = await api('admin/createVideo', {
    title, description, category, file_path, file_type: 'drive_video'
  });
  if (r.ok) {
    hideModal();
    toast('Video added from Drive', 'success');
    loadAdminVideos();
  } else {
    toast(r.reason || 'Failed to add video', 'error');
  }
}

// Renders a scrollable list of toggle rows for linking manuals⇄videos.
// `items` is [{id,title,category}], `selectedIds` pre-checks matching rows.
function renderLinkPicker(items, selectedIds, checkClass, emptyLabel) {
  const sel = new Set((selectedIds || []).map(Number));
  if (!items || !items.length) {
    return `<div style="color:var(--text3);padding:8px 2px;font-size:13px">${esc(emptyLabel)}</div>`;
  }
  return items.map(it => {
    const cats = catNames(it);
    return `
    <div class="toggle-row">
      <span>${esc(it.title)}${cats.length ? ` <span style="color:var(--text3);font-size:12px">· ${esc(cats.join(', '))}</span>` : ''}</span>
      <label class="admin-toggle">
        <input type="checkbox" class="${checkClass}" value="${it.id}" data-cat="${esc(cats.join('|'))}" data-title="${esc(it.title || '')}" ${sel.has(Number(it.id)) ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
    </div>`;
  }).join('');
}

async function importDriveFolderModal() {
  showModal(`
    <h3>Import a Drive Folder</h3>
    <div class="form-group">
      <label class="form-label">Google Drive folder link</label>
      <input class="form-input" id="folder_url" placeholder="https://drive.google.com/drive/folders/...">
      <div class="upload-hint" style="margin-top:6px;color:var(--text3);font-size:12px">
        Folder must be shared as "Anyone with the link can view". Every video file
        inside is added; the file name becomes the title.
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Category for all imported videos</label>
      <select class="form-input" id="folder_category" onchange="handleCategoryChange(this, 'video')">
        <option>Loading categories…</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" id="folder_import_btn" onclick="runDriveFolderImport()">Import</button>
    </div>
  `);
  populateCategorySelect('folder_category', 'video');
}

async function runDriveFolderImport() {
  const folder_url = document.getElementById('folder_url').value.trim();
  const catSel = document.getElementById('folder_category').value;
  const category = (catSel && catSel !== '__ADD_NEW__') ? catSel : 'General';
  if (!folder_url) return toast('Paste a Drive folder link', 'error');

  const btn = document.getElementById('folder_import_btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  const r = await api('admin/importDriveFolder', { folder_url, category });
  if (!r.ok) {
    if (btn) { btn.disabled = false; btn.textContent = 'Import'; }
    return toast(r.reason || 'Import failed', 'error');
  }
  const t = r.totals;
  let msg = `Imported ${t.inserted} video${t.inserted === 1 ? '' : 's'}`;
  if (t.skipped) msg += `, skipped ${t.skipped} already there`;
  if (t.nonVideoFiles) msg += `, ignored ${t.nonVideoFiles} non-video file${t.nonVideoFiles === 1 ? '' : 's'}`;
  hideModal();
  toast(msg, 'success');
  loadAdminVideos();
}

async function editVideoModal(id, title, desc, category) {
  const video = (STATE.adminVideos || []).find(v => v.id === id);
  const selManualIds = video ? (video.manual_ids || []) : [];
  // Need the full manuals list to build the picker; reuse the cached admin
  // list, otherwise fetch it.
  let manuals = STATE.adminManuals;
  if (!manuals || !manuals.length) {
    const mr = await api('getManuals');
    manuals = mr.ok ? mr.manuals : [];
    STATE.adminManuals = manuals;
  }
  showModal(`
    <h3>Edit Video</h3>
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="edit_video_title" value="${title}">
    </div>
    <div class="form-group">
      <label class="form-label">Categories</label>
      <div id="edit_video_cats" style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:2px 12px"><div style="padding:8px;color:var(--text3);font-size:13px">Loading…</div></div>
      <button type="button" class="btn-secondary" style="margin-top:6px;font-size:13px" onclick="addChecklistCategory('edit_video_cats','video')">+ New category</button>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea class="form-input" id="edit_video_desc">${desc}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Attach to Manuals</label>
      <div id="video_manuals_picker" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:2px 12px">
        ${renderLinkPicker(manuals, selManualIds, 'vm-check', 'No manuals yet — upload one first.')}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="updateVideo(${id})">Save</button>
    </div>
  `);
  populateCategoryChecklist('edit_video_cats', 'video', video ? catNames(video) : (category ? [category] : []));
}

async function updateVideo(id) {
  const categoryIds = checklistCheckedIds('edit_video_cats');
  const manualIds = Array.from(
    document.querySelectorAll('#video_manuals_picker input.vm-check:checked')
  ).map(c => parseInt(c.value, 10));
  await api('admin/updateVideo', {
    video_id: id,
    title: document.getElementById('edit_video_title').value.trim(),
    description: document.getElementById('edit_video_desc').value.trim()
  });
  await api('admin/setVideoCategories', { video_id: id, category_ids: categoryIds });
  await api('admin/setVideoManuals', { video_id: id, manual_ids: manualIds });
  hideModal(); toast('Video updated', 'success'); loadAdminVideos();
}

async function deleteVideo(id) {
  if (!confirm('Delete this video?')) return;
  const r = await api('admin/deleteVideo', { video_id: id });
  if (r.ok) { toast('Video deleted', 'success'); loadAdminVideos(); }
}

/* ── Category manager (Admin → Categories) ── */
const APPLIES_LABEL = { both: 'Manuals & Videos', manual: 'Manuals only', video: 'Videos only' };

async function loadAdminCategories() {
  const r = await api('admin/getAllCategories');
  if (!r.ok) return;
  STATE.adminCategories = r.categories;
  renderAdminCategories();
}

function renderAdminCategories() {
  const el = document.getElementById('admin_categories_list');
  const cats = STATE.adminCategories || [];
  if (!cats.length) {
    el.innerHTML = '<div class="empty-state"><p>No categories yet — add one above.</p></div>';
    return;
  }
  el.innerHTML = cats.map(c => {
    const mc = parseInt(c.manual_count, 10) || 0;
    const vc = parseInt(c.video_count, 10) || 0;
    const usage = (mc + vc) === 0 ? 'Unused'
      : `${mc} manual${mc === 1 ? '' : 's'} · ${vc} video${vc === 1 ? '' : 's'}`;
    return `
      <div class="admin-module-row">
        <div class="admin-module-info">
          <div class="admin-module-name">${esc(c.name)}</div>
          <div class="admin-module-meta">${esc(APPLIES_LABEL[c.applies_to] || c.applies_to)} &middot; ${usage}</div>
        </div>
        <div class="admin-module-actions">
          <button class="btn-secondary" onclick="editAdminCategory(${c.id})">Edit</button>
          <button class="btn-danger" onclick="deleteAdminCategory(${c.id})">Delete</button>
        </div>
      </div>`;
  }).join('');
}

function editAdminCategory(id) {
  const c = (STATE.adminCategories || []).find(x => x.id === id);
  if (!c) return;
  const opt = (val, label) => `<option value="${val}" ${c.applies_to === val ? 'selected' : ''}>${label}</option>`;
  showModal(`
    <h3>Edit Category</h3>
    <div class="form-group">
      <label class="form-label">Name</label>
      <input class="form-input" id="edit_category_name" value="${esc(c.name)}">
    </div>
    <div class="form-group">
      <label class="form-label">Shows in</label>
      <select class="form-input" id="edit_category_applies">
        ${opt('both', 'Manuals &amp; Videos')}${opt('manual', 'Manuals only')}${opt('video', 'Videos only')}
      </select>
    </div>
    <div class="upload-hint" style="color:var(--text3);font-size:12px;margin-bottom:12px">
      Renaming also updates every manual and video currently using this category.
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="updateAdminCategory(${id})">Save</button>
    </div>
  `);
}

async function updateAdminCategory(id) {
  const name = document.getElementById('edit_category_name').value.trim();
  const applies_to = document.getElementById('edit_category_applies').value;
  if (!name) return toast('Enter a category name', 'error');
  const r = await api('admin/updateCategory', { category_id: id, name, applies_to });
  if (!r.ok) return toast(r.reason || 'Failed to update', 'error');
  hideModal();
  toast('Category updated', 'success');
  loadAdminCategories();
}

async function addAdminCategory() {
  const nameEl = document.getElementById('new_category_name');
  const name = nameEl.value.trim();
  const applies_to = document.getElementById('new_category_applies').value;
  if (!name) return toast('Enter a category name', 'error');
  const r = await api('admin/createCategory', { name, applies_to });
  if (!r.ok) return toast(r.reason || 'Failed to add category', 'error');
  nameEl.value = '';
  toast(r.existed ? 'Category already existed' : 'Category added', 'success');
  loadAdminCategories();
}

async function deleteAdminCategory(id) {
  const c = (STATE.adminCategories || []).find(x => x.id === id);
  if (!c) return;
  const usage = (parseInt(c.manual_count, 10) || 0) + (parseInt(c.video_count, 10) || 0);
  let msg = `Delete the "${c.name}" category?`;
  if (usage > 0) msg += `\n\n${usage} manual(s)/video(s) use this label — they keep the label, but it won't show in the category dropdowns anymore.`;
  if (!confirm(msg)) return;
  const r = await api('admin/deleteCategory', { category_id: id });
  if (r.ok) { toast('Category deleted', 'success'); loadAdminCategories(); }
  else toast(r.reason || 'Failed to delete', 'error');
}

async function runLinkCheck(kind) {
  const label = kind === 'manual' ? 'manuals' : 'videos';
  showModal(`<h3>Checking ${label}…</h3><p style="color:var(--text3);font-size:14px">Pinging every link — this can take a moment.</p>`);
  const r = await api('admin/checkLinks', { kind });
  if (!r.ok) return showModal(`<h3>Check failed</h3><p>${esc(r.reason || 'Error')}</p>
    <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">Close</button></div>`);
  const t = r.totals;
  const problems = r.problems || [];
  const rows = problems.length ? problems.map(p => `
    <div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-weight:600">${esc(p.title)}</div>
        <div style="font-size:12px;color:var(--text3)">${p.type} · ${esc(p.reason)}</div>
      </div>
      <span style="font-size:11px;font-weight:700;white-space:nowrap;color:${p.status === 'broken' ? 'var(--accent)' : 'var(--text3)'}">${p.status === 'broken' ? 'BROKEN' : 'UNKNOWN'}</span>
    </div>`).join('') : '<p style="color:var(--text2);padding:8px 0">&#9989; Every link is healthy.</p>';
  showModal(`
    <h3>Link check — ${label}</h3>
    <p style="font-size:13px;color:var(--text3);margin-bottom:12px">
      Checked ${t.checked} · <b style="color:var(--text)">${t.ok} ok</b> · ${t.broken} broken${t.unknown ? ` · ${t.unknown} unknown` : ''}
    </p>
    <div style="max-height:50vh;overflow-y:auto">${rows}</div>
    <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">Close</button></div>
  `);
}

async function deleteAllVideos() {
  const count = (STATE.adminVideos || []).length;
  if (!count) return toast('There are no videos to delete', 'error');
  if (!confirm(`Delete ALL ${count} videos? This can't be undone.`)) return;
  if (!confirm('Are you absolutely sure? Every video will be permanently removed.')) return;
  const r = await api('admin/deleteAllVideos', { confirm: 'DELETE_ALL' });
  if (r.ok) {
    toast(`Deleted ${r.deleted} video${r.deleted === 1 ? '' : 's'}`, 'success');
    loadAdminVideos();
  } else {
    toast(r.reason || 'Failed to delete videos', 'error');
  }
}

async function loadProgress() {
  const moduleId = document.getElementById('progress_module_select').value;
  const wrap = document.getElementById('progress_table_wrap');
  if (!moduleId) { wrap.innerHTML = ''; return; }

  const r = await api('admin/getProgress', { module_id: parseInt(moduleId) });
  if (!r.ok) return;

  if (r.progress.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><p>No staff assigned to this module</p></div>';
    return;
  }

  wrap.innerHTML = `
    <table class="progress-table">
      <thead>
        <tr><th>Staff Member</th><th>Progress</th><th>Due Date</th><th>Status</th><th>Completed</th></tr>
      </thead>
      <tbody>
        ${r.progress.map(p => {
          const pct = parseInt(p.total_pages) > 0 ? Math.round((parseInt(p.completed_pages) / parseInt(p.total_pages)) * 100) : 0;
          const isComplete = p.module_completed_at;
          const isOverdue = p.due_date && new Date(p.due_date) < new Date() && !isComplete;
          return `
            <tr>
              <td>${esc(p.user_name || p.user_email)}</td>
              <td>
                <div style="display:flex;align-items:center;gap:10px">
                  <div class="progress-bar-wrap" style="flex:1">
                    <div class="progress-bar-fill ${isComplete ? 'complete' : ''}" style="width:${pct}%"></div>
                  </div>
                  <span style="font-size:12px;color:var(--text3);font-weight:600">${pct}%</span>
                </div>
              </td>
              <td>${p.due_date ? formatDate(p.due_date) : '<span style="color:var(--text3)">Open-ended</span>'}</td>
              <td>${isComplete ? '<span style="color:var(--success)">&#10003; Complete</span>'
                : isOverdue ? '<span style="color:var(--danger)">Overdue</span>'
                : '<span style="color:var(--warning)">In Progress</span>'}</td>
              <td>${isComplete ? formatDate(p.module_completed_at) : '-'}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function loadAssignments() {
  const moduleId = document.getElementById('assign_module_select').value;
  const wrap = document.getElementById('assignments_list');
  if (!moduleId) { wrap.innerHTML = ''; return; }

  const r = await api('admin/getAssignments', { module_id: parseInt(moduleId) });
  if (!r.ok) return;

  if (r.assignments.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><p>No staff assigned yet</p></div>';
    return;
  }

  wrap.innerHTML = r.assignments.map(a => `
    <div class="admin-module-row">
      <div class="admin-module-info">
        <div class="admin-module-name">${esc(a.user_name || a.user_email)}</div>
        <div class="admin-module-meta">
          Assigned ${formatDate(a.assigned_at)}
          ${a.due_date ? ` &middot; Due ${formatDate(a.due_date)}` : ' &middot; Open-ended'}
        </div>
      </div>
      <button class="btn-danger" onclick="unassignModule(${a.module_id}, '${esc(a.user_email)}')">Remove</button>
    </div>`).join('');
}

function showAssignModal() {
  const moduleId = document.getElementById('assign_module_select').value;
  if (!moduleId) return toast('Select a module first', 'error');

  showModal(`
    <h3>Assign Staff</h3>
    <div class="form-group">
      <label class="form-label">Staff Member</label>
      <select class="form-input" id="assign_user">
        <option value="">-- Select --</option>
        ${STATE.staffList.map(s => `<option value="${s.email}">${esc(s.name || s.email)}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Due Date (optional)</label>
      <input class="form-input" id="assign_due" type="date">
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="assignStaff()">Assign</button>
    </div>
  `);
}

async function assignStaff() {
  const moduleId = document.getElementById('assign_module_select').value;
  const email = document.getElementById('assign_user').value;
  const due = document.getElementById('assign_due').value;
  if (!email) return toast('Select a staff member', 'error');

  const r = await api('admin/assignModule', {
    module_id: parseInt(moduleId), user_email: email,
    due_date: due || null
  });
  if (r.ok) { hideModal(); toast('Staff assigned!', 'success'); loadAssignments(); }
}

async function unassignModule(moduleId, email) {
  if (!confirm('Remove this assignment?')) return;
  await api('admin/unassignModule', { module_id: moduleId, user_email: email });
  toast('Assignment removed', 'success');
  loadAssignments();
}

/* ═══════════════════════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════════════════════ */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function showModal(html) {
  const overlay = document.getElementById('modal_overlay');
  overlay.innerHTML = `<div class="modal">${html}</div>`;
  overlay.classList.remove('hidden');
  overlay.onclick = e => { if (e.target === overlay) hideModal(); };
}

function hideModal() {
  document.getElementById('modal_overlay').classList.add('hidden');
  document.getElementById('modal_overlay').innerHTML = '';
}

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = (type === 'success' ? '\u2713 ' : '\u2717 ') + msg;
  el.className = `toast ${type} show`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

// Drag and drop + click for manual upload zone
document.addEventListener('DOMContentLoaded', () => {
  const uploadZone = document.getElementById('manual_upload_zone');
  if (uploadZone) {
    uploadZone.addEventListener('click', () => {
      document.getElementById('manual_file_input').click();
    });
    ['dragenter', 'dragover'].forEach(evt => {
      uploadZone.addEventListener(evt, e => {
        e.preventDefault();
        uploadZone.style.borderColor = 'var(--accent)';
        uploadZone.style.background = 'var(--accent-bg)';
      });
    });
    uploadZone.addEventListener('dragleave', e => {
      e.preventDefault();
      uploadZone.style.borderColor = '';
      uploadZone.style.background = '';
    });
    uploadZone.addEventListener('drop', e => {
      e.preventDefault();
      uploadZone.style.borderColor = '';
      uploadZone.style.background = '';
      const file = e.dataTransfer.files[0];
      if (file) {
        const input = document.getElementById('manual_file_input');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        uploadManual(input);
      }
    });
  }
});
