/* ═══════════════════════════════════════════════════════════════════════════
   ARADIA EDU — Main Application
   ═══════════════════════════════════════════════════════════════════════════ */

const STATE = {
  email: '', pin: '',
  user: null,
  currentPage: 'modules',
  viewerModule: null,
  viewerChapters: [],
  viewerFlatPages: [],
  viewerPageIndex: 0,
  manuals: [],
  manualsFilter: 'all',
  selectedManual: null,
  adminModules: [],
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

document.addEventListener('DOMContentLoaded', () => {
  ['login_email', 'login_pin'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });
  });
  tryAutoLogin();
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

  go('modules');
}

/* ═══════════════════════════════════════════════════════════════════════════
   NAVIGATION
   ═══════════════════════════════════════════════════════════════════════════ */
function go(page) {
  if (STATE.currentPage === 'slide_editor' && page !== 'admin' && page !== 'viewer') return;

  if (STATE.currentPage === 'slide_editor' && page !== 'slide_editor') {
    document.querySelector('.app-header').style.display = '';
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
    loadManuals();
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
                <span class="page-num">${pi + 1}</span>
                ${esc(pg.title || 'Untitled Page')}
                <span class="page-check">&#10003;</span>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');

  renderSlide(currentPage);

  document.getElementById('viewer_nav_info').textContent =
    `Page ${STATE.viewerPageIndex + 1} of ${totalPages}`;

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

function renderManualFilters() {
  const categories = ['All', ...new Set(STATE.manuals.map(m => m.category))];
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

  if (STATE.manualsFilter !== 'all') filtered = filtered.filter(m => m.category === STATE.manualsFilter);
  if (search) {
    filtered = filtered.filter(m =>
      m.title.toLowerCase().includes(search) ||
      m.description.toLowerCase().includes(search) ||
      m.category.toLowerCase().includes(search)
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
        <div class="manual-category">${esc(m.category)}</div>
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
  if (manual.file_type === 'pdf') {
    viewer.innerHTML = `<iframe class="manual-frame" src="${manual.file_path}"></iframe>`;
  } else {
    viewer.innerHTML = `
      <div style="padding:40px;text-align:center;color:var(--text2)">
        <div style="font-size:48px;margin-bottom:16px">&#128196;</div>
        <p>${esc(manual.title)}</p>
        <a href="${manual.file_path}" download class="btn-primary" style="display:inline-block;margin-top:16px">
          Download File
        </a>
      </div>`;
  }
  renderManualsList();
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
   ADMIN
   ═══════════════════════════════════════════════════════════════════════════ */
function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('admin_' + tab).classList.add('active');

  if (tab === 'progress' || tab === 'assignments') populateModuleSelects();
  if (tab === 'manuals') loadAdminManuals();
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

  const el = document.getElementById('admin_manuals_list');
  if (r.manuals.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No manuals uploaded yet</p></div>';
    return;
  }

  el.innerHTML = r.manuals.map(m => `
    <div class="admin-module-row">
      <div class="admin-module-info">
        <div class="admin-module-name">${esc(m.title)}</div>
        <div class="admin-module-meta">${esc(m.category)} &middot; ${m.file_type.toUpperCase()}</div>
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

function editManualModal(id, title, desc, category) {
  showModal(`
    <h3>Edit Manual</h3>
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="edit_manual_title" value="${title}">
    </div>
    <div class="form-group">
      <label class="form-label">Category</label>
      <input class="form-input" id="edit_manual_category" value="${category}">
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea class="form-input" id="edit_manual_desc">${desc}</textarea>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="updateManual(${id})">Save</button>
    </div>
  `);
}

async function updateManual(id) {
  await api('admin/updateManual', {
    manual_id: id,
    title: document.getElementById('edit_manual_title').value.trim(),
    description: document.getElementById('edit_manual_desc').value.trim(),
    category: document.getElementById('edit_manual_category').value.trim()
  });
  hideModal(); toast('Manual updated', 'success'); loadAdminManuals();
}

async function deleteManual(id) {
  if (!confirm('Delete this manual?')) return;
  const r = await api('admin/deleteManual', { manual_id: id });
  if (r.ok) { toast('Manual deleted', 'success'); loadAdminManuals(); }
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
