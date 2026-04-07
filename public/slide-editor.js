/* ═══════════════════════════════════════════════════════════════════════════
   SLIDE EDITOR — Aradia EDU
   Full-featured slide editor with PDF import, rich text, drag-and-drop
   ═══════════════════════════════════════════════════════════════════════════ */

const SE = { moduleId: null, chapters: [], flatPages: [], currentIdx: 0, saveTimer: null };

// ─── Reload helper (DRY up repeated reload pattern) ────────────────────────
async function seReload(targetPageId) {
  const mr = await api('getModule', { module_id: SE.moduleId });
  if (!mr.ok) return;
  SE.chapters = mr.chapters;
  SE.flatPages = [];
  for (const ch of mr.chapters) {
    for (const pg of (ch.pages || [])) {
      SE.flatPages.push({ ...pg, _chapterId: ch.id, _chapterTitle: ch.title });
    }
  }
  if (targetPageId != null) {
    const idx = SE.flatPages.findIndex(fp => fp.id === targetPageId);
    if (idx >= 0) { seLoadSlide(idx); return; }
  }
  SE.currentIdx = Math.min(SE.currentIdx, Math.max(0, SE.flatPages.length - 1));
  if (SE.flatPages.length > 0) seLoadSlide(SE.currentIdx);
  else seRenderSidebar();
}

// ─── Open / Close ──────────────────────────────────────────────────────────
async function openSlideEditor(moduleId) {
  try {
    const r = await api('getModule', { module_id: moduleId });
    if (!r.ok) return toast(r.reason, 'error');

    SE.moduleId = moduleId;
    SE.module = r.module;
    SE.chapters = r.chapters;
    SE._loading = true;

    // Also set STATE.editingModule so import functions work from within the editor
    STATE.editingModule = r.module;
    STATE.editingChapters = r.chapters;

    SE.flatPages = [];
    for (const ch of r.chapters) {
      for (const pg of (ch.pages || [])) {
        SE.flatPages.push({ ...pg, _chapterId: ch.id, _chapterTitle: ch.title });
      }
    }

    SE.currentIdx = 0;

    document.querySelector('.app-header').style.display = 'none';
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.header-nav button').forEach(b => b.classList.remove('active'));
    document.getElementById('page_slide_editor').classList.add('active');
    STATE.currentPage = 'slide_editor';

    document.getElementById('se_module_title').textContent = r.module.title;
    document.getElementById('se_publish_btn').textContent = r.module.is_published ? 'Unpublish' : 'Publish';

    seRenderSidebar();
    if (SE.flatPages.length > 0) seLoadSlide(0);
    else seShowEmptyState();

    SE._loading = false;
  } catch(e) {
    console.error('openSlideEditor error:', e);
    toast('Failed to open editor', 'error');
    document.querySelector('.app-header').style.display = '';
  }
}

function closeSlideEditor() {
  document.querySelector('.app-header').style.display = '';
  go('admin');
  loadAdminData();
}

function seShowEmptyState() {
  const canvas = document.getElementById('se_canvas');
  const content = document.getElementById('se_content');
  const title = document.getElementById('se_slide_title');
  title.value = '';
  content.innerHTML = `
    <div style="text-align:center;padding:60px 20px;color:var(--text3)">
      <div style="font-size:48px;margin-bottom:16px;opacity:0.2">&#128196;</div>
      <div style="font-size:18px;font-weight:600;color:var(--text2);margin-bottom:8px;font-family:var(--font-display)">No slides yet</div>
      <div style="font-size:13px;margin-bottom:24px">Import a PDF slide deck or add slides manually</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <label style="padding:10px 24px;border-radius:50px;background:var(--gradient-accent);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font-display)">
          Import PDF
          <input type="file" accept=".pdf" style="display:none" onchange="seImportPdf(this)">
        </label>
        <button onclick="seAddSlide()" style="padding:10px 24px;border-radius:50px;background:var(--surface2);color:var(--text);font-size:13px;font-weight:500;cursor:pointer;border:1px solid var(--border);font-family:var(--font-display)">+ Add Blank Slide</button>
      </div>
    </div>`;
}

async function seImportPdf(input) {
  if (!input.files[0]) return;
  const file = input.files[0];
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext !== 'pdf') return toast('Please select a PDF file', 'error');

  // Make sure STATE.editingModule is set for importModuleFile
  STATE.editingModule = SE.module;
  STATE.editingChapters = SE.chapters;

  // Store the module ID so after import we reopen the editor
  SE._importReturnToEditor = true;

  // Use the existing import flow
  await importModuleFile(input);
}

// ─── Sidebar Rendering with Drag-and-Drop ──────────────────────────────────
function seRenderSidebar() {
  const list = document.getElementById('se_slides_list');
  let html = '';
  let slideNum = 0;

  for (const ch of SE.chapters) {
    html += `<div class="se-ch-group" data-chapter-id="${ch.id}">
      <div class="se-ch-label" data-chapter-id="${ch.id}">
        <span class="se-ch-label-text" ondblclick="seRenameChapter(${ch.id}, this)">${esc(ch.title)}</span>
        <div class="se-ch-actions">
          <button class="se-ch-delete" onclick="seDeleteChapter(${ch.id})" title="Delete chapter">&times;</button>
        </div>
      </div>`;
    for (const pg of (ch.pages || [])) {
      const idx = SE.flatPages.findIndex(fp => fp.id === pg.id);
      const isActive = idx === SE.currentIdx;
      slideNum++;
      html += `
        <div class="se-thumb ${isActive ? 'active' : ''}" onclick="seLoadSlide(${idx})"
             draggable="true" data-page-id="${pg.id}" data-chapter-id="${ch.id}" data-idx="${idx}"
             title="${esc(pg.title || 'Untitled')}">
          <span class="se-thumb-num">${slideNum}</span>
          ${pg.video_url ? '<span class="se-thumb-vid">&#127909;</span>' : ''}
          <div class="se-thumb-label">${esc(pg.title || 'Untitled')}</div>
        </div>`;
    }
    html += '</div>';
  }

  if (SE.flatPages.length === 0) {
    html = `<div style="padding:20px;text-align:center;font-size:12px;color:var(--text3)">
      No slides yet.<br><br>
      <button class="se-btn" onclick="seAddSlide()" style="width:100%;justify-content:center;background:var(--accent-bg);color:var(--accent);border:1px solid var(--accent-bg2);margin-bottom:6px">+ Add Slide</button>
      <label class="se-btn" style="width:100%;justify-content:center;background:var(--surface2);border:1px solid var(--border);cursor:pointer">
        Import PDF
        <input type="file" accept=".pdf" style="display:none" onchange="seImportPdf(this)">
      </label>
    </div>`;
  }

  list.innerHTML = html;

  // Attach drag-and-drop listeners
  seInitDragAndDrop();

  // Update chapter select in props
  const sel = document.getElementById('se_chapter_select');
  sel.innerHTML = SE.chapters.map(ch => `<option value="${ch.id}">${esc(ch.title)}</option>`).join('');

  // Update footer
  document.getElementById('se_footer_info').textContent = SE.flatPages.length > 0
    ? `Slide ${SE.currentIdx + 1} of ${SE.flatPages.length}` : 'No slides';
}

// ─── Drag and Drop ─────────────────────────────────────────────────────────
function seInitDragAndDrop() {
  const list = document.getElementById('se_slides_list');
  let draggedId = null;
  let draggedChapterId = null;

  list.querySelectorAll('.se-thumb').forEach(thumb => {
    thumb.addEventListener('dragstart', e => {
      draggedId = parseInt(thumb.dataset.pageId);
      draggedChapterId = parseInt(thumb.dataset.chapterId);
      thumb.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedId);
    });

    thumb.addEventListener('dragend', () => {
      thumb.classList.remove('dragging');
      list.querySelectorAll('.se-thumb').forEach(t => {
        t.classList.remove('drop-above', 'drop-below');
      });
      draggedId = null;
    });

    thumb.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = thumb.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        thumb.classList.add('drop-above');
        thumb.classList.remove('drop-below');
      } else {
        thumb.classList.add('drop-below');
        thumb.classList.remove('drop-above');
      }
    });

    thumb.addEventListener('dragleave', () => {
      thumb.classList.remove('drop-above', 'drop-below');
    });

    thumb.addEventListener('drop', async e => {
      e.preventDefault();
      thumb.classList.remove('drop-above', 'drop-below');

      const targetPageId = parseInt(thumb.dataset.pageId);
      const targetChapterId = parseInt(thumb.dataset.chapterId);
      if (draggedId === targetPageId) return;

      const rect = thumb.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const insertBefore = e.clientY < midY;

      // If moving to a different chapter, update the chapter first
      if (draggedChapterId !== targetChapterId) {
        await api('admin/updatePage', { page_id: draggedId, chapter_id: targetChapterId });
      }

      // Now reorder within the target chapter
      const ch = SE.chapters.find(c => c.id === targetChapterId);
      if (!ch) return;

      // Reload to get fresh state after chapter move
      const mr = await api('getModule', { module_id: SE.moduleId });
      if (!mr.ok) return;
      const freshCh = mr.chapters.find(c => c.id === targetChapterId);
      if (!freshCh) return;

      const pages = freshCh.pages || [];
      const targetIdx = pages.findIndex(p => p.id === targetPageId);
      const sourceIdx = pages.findIndex(p => p.id === draggedId);

      // Build new order
      const filtered = pages.filter(p => p.id !== draggedId);
      let insertIdx = filtered.findIndex(p => p.id === targetPageId);
      if (!insertBefore) insertIdx++;
      filtered.splice(insertIdx, 0, pages.find(p => p.id === draggedId) || { id: draggedId });

      const order = filtered.map((p, i) => ({ id: p.id, sort_order: i }));
      await api('admin/reorderPages', { order });

      await seReload(draggedId);
      toast('Slide moved', 'success');
    });
  });

  // Allow dropping on chapter labels (move to end of chapter)
  list.querySelectorAll('.se-ch-label').forEach(label => {
    label.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      label.style.background = 'var(--accent-bg)';
    });
    label.addEventListener('dragleave', () => {
      label.style.background = '';
    });
    label.addEventListener('drop', async e => {
      e.preventDefault();
      label.style.background = '';
      const targetChapterId = parseInt(label.dataset.chapterId);
      if (!draggedId) return;

      await api('admin/updatePage', { page_id: draggedId, chapter_id: targetChapterId });
      await seReload(draggedId);
      toast('Slide moved', 'success');
    });
  });
}

// ─── Slide Loading ─────────────────────────────────────────────────────────
function seLoadSlide(idx) {
  try {
    if (idx < 0 || idx >= SE.flatPages.length) return;
    SE.currentIdx = idx;
    const pg = SE.flatPages[idx];
    let contentData = {};
    try { contentData = typeof pg.content === 'string' ? JSON.parse(pg.content || '{}') : (pg.content || {}); }
    catch(e) { contentData = { html: String(pg.content || '') }; }

    document.getElementById('se_slide_title').value = pg.title || '';
    document.getElementById('se_content').innerHTML = contentData.html || '';
    document.getElementById('se_video_url').value = pg.video_url || '';
    document.getElementById('se_video_req').checked = !!pg.video_required;
    document.getElementById('se_bg_url').value = pg.background_image || '';
    document.getElementById('se_chapter_select').value = pg._chapterId;

    const vbar = document.getElementById('se_video_bar');
    if (pg.video_url) {
      vbar.classList.add('has-video');
      document.getElementById('se_video_label').textContent = pg.video_url;
    } else {
      vbar.classList.remove('has-video');
      document.getElementById('se_video_label').textContent = 'Click to add video (YouTube / Google Drive)';
    }

    const bgEl = document.getElementById('se_canvas_bg');
    if (pg.background_image) {
      bgEl.style.backgroundImage = `url('${pg.background_image}')`;
      bgEl.style.display = '';
    } else {
      bgEl.style.backgroundImage = '';
      bgEl.style.display = 'none';
    }

    seRenderSidebar();
  } catch(e) { console.error('seLoadSlide error:', e); }
}

// ─── Auto-save ─────────────────────────────────────────────────────────────
function seEditVideo() {
  document.getElementById('se_video_url').focus();
}

function seDebounceSave() {
  if (SE._loading) return;
  if (SE.saveTimer) clearTimeout(SE.saveTimer);
  SE.saveTimer = setTimeout(() => seSaveCurrent(), 800);
}

async function seSaveCurrent() {
  if (SE.flatPages.length === 0) return;
  const pg = SE.flatPages[SE.currentIdx];

  const title = document.getElementById('se_slide_title').value.trim();
  const html = document.getElementById('se_content').innerHTML;
  const videoUrl = document.getElementById('se_video_url').value.trim();
  const videoReq = document.getElementById('se_video_req').checked;
  const bgImage = document.getElementById('se_bg_url').value.trim();

  pg.title = title;
  pg.content = { html };
  pg.video_url = videoUrl;
  pg.video_required = videoReq;
  pg.background_image = bgImage;

  const vbar = document.getElementById('se_video_bar');
  if (videoUrl) {
    vbar.classList.add('has-video');
    document.getElementById('se_video_label').textContent = videoUrl;
  } else {
    vbar.classList.remove('has-video');
    document.getElementById('se_video_label').textContent = 'Click to add video (YouTube / Google Drive)';
  }

  const bgEl = document.getElementById('se_canvas_bg');
  if (bgImage) { bgEl.style.backgroundImage = `url('${bgImage}')`; bgEl.style.display = ''; }
  else { bgEl.style.backgroundImage = ''; bgEl.style.display = 'none'; }

  await api('admin/updatePage', {
    page_id: pg.id, chapter_id: pg._chapterId, title, content_type: 'rich_text',
    content: { html }, video_url: videoUrl, video_required: videoReq, background_image: bgImage
  });

  seRenderSidebar();
}

// ─── Slide CRUD ────────────────────────────────────────────────────────────
async function seAddSlide() {
  let chapterId;
  if (SE.flatPages.length > 0) {
    chapterId = SE.flatPages[SE.currentIdx]._chapterId;
  } else if (SE.chapters.length > 0) {
    chapterId = SE.chapters[0].id;
  } else {
    const cr = await api('admin/createChapter', { module_id: SE.moduleId, title: 'Chapter 1' });
    if (!cr.ok) return toast('Failed to create chapter', 'error');
    chapterId = cr.chapter.id;
  }

  const r = await api('admin/createPage', {
    chapter_id: chapterId, title: 'New Slide', content_type: 'rich_text',
    content: { html: '' }, video_url: '', video_required: false, background_image: ''
  });

  if (r.ok) {
    // Insert after current slide by reordering
    const mr = await api('getModule', { module_id: SE.moduleId });
    if (mr.ok) {
      const ch = mr.chapters.find(c => c.id === chapterId);
      if (ch && ch.pages) {
        const currentPage = SE.flatPages.length > 0 ? SE.flatPages[SE.currentIdx] : null;
        const currentLocalIdx = currentPage ? ch.pages.findIndex(p => p.id === currentPage.id) : -1;
        const newPageIdx = ch.pages.findIndex(p => p.id === r.page.id);

        // Move new page to right after current
        if (currentLocalIdx >= 0 && newPageIdx > currentLocalIdx + 1) {
          const pages = [...ch.pages];
          const newPage = pages.splice(newPageIdx, 1)[0];
          pages.splice(currentLocalIdx + 1, 0, newPage);
          const order = pages.map((p, i) => ({ id: p.id, sort_order: i }));
          await api('admin/reorderPages', { order });
        }
      }
    }
    await seReload(r.page.id);
  }
}

async function seDuplicateSlide() {
  if (SE.flatPages.length === 0) return;
  const pg = SE.flatPages[SE.currentIdx];

  let contentData = {};
  try { contentData = typeof pg.content === 'string' ? JSON.parse(pg.content || '{}') : (pg.content || {}); }
  catch(e) { contentData = { html: '' }; }

  const r = await api('admin/createPage', {
    chapter_id: pg._chapterId,
    title: (pg.title || 'Untitled') + ' (copy)',
    content_type: 'rich_text',
    content: contentData,
    video_url: pg.video_url || '',
    video_required: pg.video_required || false,
    background_image: pg.background_image || ''
  });

  if (r.ok) {
    // Position right after original
    const mr = await api('getModule', { module_id: SE.moduleId });
    if (mr.ok) {
      const ch = mr.chapters.find(c => c.id === pg._chapterId);
      if (ch && ch.pages) {
        const origIdx = ch.pages.findIndex(p => p.id === pg.id);
        const newIdx = ch.pages.findIndex(p => p.id === r.page.id);
        if (origIdx >= 0 && newIdx > origIdx + 1) {
          const pages = [...ch.pages];
          const newPage = pages.splice(newIdx, 1)[0];
          pages.splice(origIdx + 1, 0, newPage);
          const order = pages.map((p, i) => ({ id: p.id, sort_order: i }));
          await api('admin/reorderPages', { order });
        }
      }
    }
    await seReload(r.page.id);
    toast('Slide duplicated', 'success');
  }
}

async function seDeleteSlide() {
  if (SE.flatPages.length === 0) return;
  if (!confirm('Delete this slide?')) return;

  const pg = SE.flatPages[SE.currentIdx];
  await api('admin/deletePage', { page_id: pg.id });
  await seReload();
  toast('Slide deleted', 'success');
}

// ─── Chapter Management ────────────────────────────────────────────────────
async function seAddChapter() {
  const title = prompt('Chapter name:');
  if (!title) return;
  await api('admin/createChapter', { module_id: SE.moduleId, title });
  await seReload();
  toast('Chapter added', 'success');
}

function seRenameChapter(chapterId, el) {
  const currentTitle = el.textContent;
  const input = document.createElement('input');
  input.className = 'se-ch-rename-input';
  input.value = currentTitle;
  input.style.cssText = 'width:100%;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;background:var(--input-bg);border:1px solid var(--accent);color:var(--text);padding:2px 6px;border-radius:4px;outline:none;';
  el.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle) {
      await api('admin/updateChapter', { chapter_id: chapterId, title: newTitle });
      // Update local state
      const ch = SE.chapters.find(c => c.id === chapterId);
      if (ch) ch.title = newTitle;
      SE.flatPages.forEach(fp => { if (fp._chapterId === chapterId) fp._chapterTitle = newTitle; });
    }
    seRenderSidebar();
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
  });
}

async function seDeleteChapter(chapterId) {
  const ch = SE.chapters.find(c => c.id === chapterId);
  const pageCount = ch?.pages?.length || 0;
  const msg = pageCount > 0
    ? `Delete chapter "${ch.title}" and its ${pageCount} slides?`
    : `Delete empty chapter "${ch.title}"?`;
  if (!confirm(msg)) return;

  await api('admin/deleteChapter', { chapter_id: chapterId });
  await seReload();
  toast('Chapter deleted', 'success');
}

async function seMoveToChapter(newChapterId) {
  if (SE.flatPages.length === 0 || !newChapterId) return;
  const pg = SE.flatPages[SE.currentIdx];
  if (parseInt(newChapterId) === pg._chapterId) return;

  await api('admin/updatePage', { page_id: pg.id, chapter_id: parseInt(newChapterId) });
  await seReload(pg.id);
  toast('Slide moved', 'success');
}

async function seMoveSlide(direction) {
  if (SE.flatPages.length === 0) return;
  const pg = SE.flatPages[SE.currentIdx];
  const ch = SE.chapters.find(c => c.id === pg._chapterId);
  if (!ch) return;

  const pages = ch.pages || [];
  const localIdx = pages.findIndex(p => p.id === pg.id);
  const swapIdx = direction === 'up' ? localIdx - 1 : localIdx + 1;
  if (swapIdx < 0 || swapIdx >= pages.length) return;

  const order = pages.map((p, i) => ({ id: p.id, sort_order: i }));
  order[localIdx].sort_order = swapIdx;
  order[swapIdx].sort_order = localIdx;

  await api('admin/reorderPages', { order });
  await seReload(pg.id);
}

// ─── Rich Text Toolbar ────────────────────────────────────────────────────
function seExec(cmd, val) {
  document.execCommand(cmd, false, val || null);
  document.getElementById('se_content').focus();
}

function seSetFontSize(size) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  // execCommand fontSize uses 1-7 scale, so we use insertHTML with a span
  if (sel.toString().length > 0) {
    const range = sel.getRangeAt(0);
    const span = document.createElement('span');
    span.style.fontSize = size + 'px';
    range.surroundContents(span);
    seDebounceSave();
  }
  document.getElementById('se_content').focus();
}

function seSetFontColor(color) {
  document.execCommand('foreColor', false, color);
  document.getElementById('se_content').focus();
  seDebounceSave();
}

function seInsertLink() {
  const url = prompt('Enter URL:');
  if (!url) return;
  document.execCommand('createLink', false, url);
  document.getElementById('se_content').focus();
  seDebounceSave();
}

async function seInsertImage(input) {
  if (!input.files[0]) return;
  const r = await apiUpload('backgrounds', input.files[0]);
  if (r.ok) {
    document.getElementById('se_content').focus();
    document.execCommand('insertHTML', false,
      `<img src="${r.filePath}" style="max-width:100%;height:auto;border-radius:8px;margin:8px 0" alt="Slide image">`
    );
    seDebounceSave();
    toast('Image inserted', 'success');
  }
  input.value = '';
}

function seClearFormat() {
  document.execCommand('removeFormat');
  document.getElementById('se_content').focus();
}

// ─── Background Upload ────────────────────────────────────────────────────
async function seUploadBg(input) {
  if (!input.files[0]) return;
  const r = await apiUpload('backgrounds', input.files[0]);
  if (r.ok) {
    document.getElementById('se_bg_url').value = r.filePath;
    seSaveCurrent();
    toast('Background uploaded', 'success');
  }
}

// ─── Preview / Publish ─────────────────────────────────────────────────────
function sePreview() {
  closeSlideEditor();
  previewModule(SE.moduleId);
}

async function sePublishToggle() {
  const newState = !SE.module.is_published;
  await api('admin/updateModule', { module_id: SE.moduleId, is_published: newState });
  SE.module.is_published = newState;
  document.getElementById('se_publish_btn').textContent = newState ? 'Unpublish' : 'Publish';
  toast(newState ? 'Module published!' : 'Module unpublished', 'success');
}

/* ═══════════════════════════════════════════════════════════════════════════
   PDF IMPORT with PDF.js
   ═══════════════════════════════════════════════════════════════════════════ */

async function importModuleFile(input) {
  if (!input.files[0]) return;
  const file = input.files[0];
  const ext = file.name.split('.').pop().toLowerCase();

  toast('Uploading file...', 'success');

  const r = await apiUpload('modules', file);
  if (!r.ok) return toast('Upload failed', 'error');

  const baseTitle = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');

  if (ext === 'pdf') {
    let pageCount = 1;
    // Try PDF.js first for accurate page count
    if (typeof pdfjsLib !== 'undefined') {
      try {
        const pdf = await pdfjsLib.getDocument(r.filePath).promise;
        pageCount = pdf.numPages;
        // Store the pdf object for later rendering
        STATE._pdfDoc = pdf;
      } catch(e) {
        console.error('PDF.js page count error, falling back to server:', e);
      }
    }
    // Fallback to server-side detection
    if (pageCount <= 1) {
      try {
        const countR = await api('admin/getPdfPageCount', { file_path: r.filePath });
        if (countR.ok && countR.pageCount > 0) pageCount = countR.pageCount;
      } catch(e) { console.error('Page count error:', e); }
    }

    STATE._importData = { filePath: r.filePath, pageCount, baseTitle };
    showImportSplitModal(pageCount, baseTitle);
    return;
  } else {
    const cr = await api('admin/createChapter', { module_id: STATE.editingModule.id, title: baseTitle });
    if (cr.ok) {
      await api('admin/createPage', {
        chapter_id: cr.chapter.id, title: baseTitle,
        content_type: 'rich_text',
        content: { html: `<p>Imported from <strong>${esc(file.name)}</strong></p><p style="margin-top:16px"><a href="${r.filePath}" download style="display:inline-block;padding:10px 24px;background:#e8465a;color:#fff;border-radius:50px;font-weight:600;text-decoration:none">Download Original File</a></p>` },
        video_url: '', video_required: false, background_image: ''
      });
    }
    toast('File imported!', 'success');
    if (SE._importReturnToEditor || STATE.currentPage === 'slide_editor') {
      SE._importReturnToEditor = false;
      openSlideEditor(STATE.editingModule.id);
    } else {
      editModule(STATE.editingModule.id);
    }
  }
}

function showImportSplitModal(pageCount, baseTitle) {
  STATE._importChapters = [{ title: 'Chapter 1', from: 1, to: pageCount }];

  showModal(`
    <h3>Split PDF into Chapters</h3>
    <div style="padding:12px 16px;background:var(--accent-bg);border-radius:var(--radius-sm);margin-bottom:16px;font-size:13px;color:var(--accent);font-weight:500">
      Detected <strong>${pageCount} pages</strong> in this PDF
    </div>
    <div class="form-group">
      <label class="form-label">Total Pages in PDF</label>
      <input type="number" class="form-input" id="import_page_count" value="${pageCount}" min="1" style="width:120px" onchange="updateImportPageCount(parseInt(this.value))">
      <span style="font-size:12px;color:var(--text3);margin-left:8px">Edit if detection was wrong</span>
    </div>
    <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
    <p style="font-size:13px;color:var(--text2);margin-bottom:12px"><strong>Define your chapters below.</strong> Each chapter gets a name and a page range. Each PDF page becomes a slide that you can then edit individually.</p>
    <div id="import_chapter_rows"></div>
    <button onclick="addImportChapter()" style="padding:8px 18px;border-radius:50px;background:var(--surface2);color:var(--text);font-size:13px;cursor:pointer;border:1px solid var(--border);margin-bottom:20px;width:100%;text-align:center">+ Add Another Chapter</button>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button onclick="executeImportSplit()" style="padding:10px 24px;border-radius:50px;background:#e8465a;color:#fff;font-family:'Outfit',sans-serif;font-size:13.5px;font-weight:600;cursor:pointer;border:none">Build Module</button>
    </div>
  `);
  renderImportChapterRows();
}

function updateImportPageCount(count) {
  STATE._importData.pageCount = count;
  const last = STATE._importChapters[STATE._importChapters.length - 1];
  if (last) last.to = count;
  renderImportChapterRows();
}

function renderImportChapterRows() {
  const rows = document.getElementById('import_chapter_rows');
  if (!rows) return;
  const pc = STATE._importData.pageCount;
  rows.innerHTML = STATE._importChapters.map((ch, i) => `
    <div style="margin-bottom:10px;padding:14px;background:var(--input-bg);border:1px solid var(--border);border-radius:var(--radius-sm)">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">
        <span style="font-size:12px;font-weight:700;color:var(--accent);min-width:20px">${i+1}.</span>
        <input class="form-input" value="${esc(ch.title)}" placeholder="Chapter name (e.g. Overview, Values, etc.)" onchange="STATE._importChapters[${i}].title=this.value" style="flex:1">
        ${STATE._importChapters.length > 1 ? `<button onclick="removeImportChapter(${i})" style="padding:6px 14px;border-radius:50px;background:var(--danger-bg);color:var(--danger);font-size:12px;cursor:pointer;border:none">Remove</button>` : ''}
      </div>
      <div style="display:flex;gap:8px;align-items:center;padding-left:30px">
        <label style="font-size:12px;color:var(--text2);font-weight:600">Pages</label>
        <input type="number" class="form-input" value="${ch.from}" min="1" max="${pc}" style="width:70px;text-align:center" onchange="STATE._importChapters[${i}].from=parseInt(this.value);renderImportChapterRows()">
        <span style="color:var(--text3);font-size:13px">to</span>
        <input type="number" class="form-input" value="${ch.to}" min="1" max="${pc}" style="width:70px;text-align:center" onchange="STATE._importChapters[${i}].to=parseInt(this.value);renderImportChapterRows()">
        <span style="font-size:12px;color:var(--text3);font-weight:500">(${Math.max(0, ch.to - ch.from + 1)} slides)</span>
      </div>
    </div>
  `).join('');
}

function addImportChapter() {
  const pc = STATE._importData.pageCount;
  const last = STATE._importChapters[STATE._importChapters.length - 1];
  const nextFrom = last ? last.to + 1 : 1;
  if (nextFrom > pc) return toast('All pages are assigned - adjust ranges above or increase page count', 'error');
  STATE._importChapters.push({ title: `Chapter ${STATE._importChapters.length + 1}`, from: nextFrom, to: pc });
  renderImportChapterRows();
}

function removeImportChapter(idx) {
  STATE._importChapters.splice(idx, 1);
  renderImportChapterRows();
}

async function executeImportSplit() {
  const { filePath, pageCount, baseTitle } = STATE._importData;
  const chapters = STATE._importChapters;

  for (const ch of chapters) {
    if (!ch.title.trim()) return toast('All chapters need a title', 'error');
    if (ch.from < 1 || ch.to > pageCount || ch.from > ch.to) return toast('Invalid page range', 'error');
  }

  const totalSlides = chapters.reduce((sum, ch) => sum + (ch.to - ch.from + 1), 0);
  const usePdfJs = typeof pdfjsLib !== 'undefined';

  // Show progress modal
  hideModal();
  showModal(`
    <h3>Importing PDF</h3>
    <div style="margin:20px 0">
      <div style="font-size:13px;color:var(--text2);margin-bottom:12px" id="import_progress_text">Preparing...</div>
      <div style="height:6px;background:var(--input-bg);border-radius:3px;overflow:hidden">
        <div id="import_progress_bar" style="height:100%;width:0%;background:linear-gradient(90deg,#e8465a,#ff8c6b);border-radius:3px;transition:width 0.3s ease"></div>
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:8px" id="import_progress_detail"></div>
    </div>
  `);

  let pdfDoc = STATE._pdfDoc || null;
  if (usePdfJs && !pdfDoc) {
    try {
      pdfDoc = await pdfjsLib.getDocument(filePath).promise;
    } catch(e) {
      console.error('PDF.js load error:', e);
    }
  }

  let slidesDone = 0;

  for (const ch of chapters) {
    const cr = await api('admin/createChapter', { module_id: STATE.editingModule.id, title: ch.title.trim() });
    if (!cr.ok) { toast('Failed to create chapter: ' + ch.title, 'error'); continue; }

    for (let p = ch.from; p <= ch.to; p++) {
      slidesDone++;
      const pctDone = Math.round((slidesDone / totalSlides) * 100);
      document.getElementById('import_progress_text').textContent = `Rendering page ${slidesDone} of ${totalSlides}...`;
      document.getElementById('import_progress_bar').style.width = pctDone + '%';
      document.getElementById('import_progress_detail').textContent = `Chapter: ${ch.title} - Page ${p}`;

      let bgImage = '';

      // Try to render with PDF.js
      if (usePdfJs && pdfDoc) {
        try {
          const page = await pdfDoc.getPage(p);
          const viewport = page.getViewport({ scale: 2 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport }).promise;

          // Convert to blob and upload
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
          const file = new File([blob], `page-${p}.jpg`, { type: 'image/jpeg' });
          const uploadR = await apiUpload('backgrounds', file);
          if (uploadR.ok) bgImage = uploadR.filePath;
        } catch(e) {
          console.error(`PDF.js render error for page ${p}:`, e);
        }
      }

      // Create the page - if PDF.js worked, use background image; otherwise fallback to iframe
      const content = bgImage
        ? { html: '' }
        : { html: `<iframe src="${filePath}#page=${p}" style="width:100%;height:650px;border:none;border-radius:8px"></iframe>` };

      await api('admin/createPage', {
        chapter_id: cr.chapter.id,
        title: `Page ${p}`,
        content_type: 'rich_text',
        content,
        video_url: '', video_required: false,
        background_image: bgImage
      });
    }
  }

  STATE._pdfDoc = null;
  hideModal();
  toast(`Imported! ${chapters.length} chapters, ${totalSlides} slides created.`, 'success');

  // If we were in the slide editor, go back to it; otherwise go to settings
  if (SE._importReturnToEditor || STATE.currentPage === 'slide_editor') {
    SE._importReturnToEditor = false;
    openSlideEditor(STATE.editingModule.id);
  } else {
    editModule(STATE.editingModule.id);
  }
}

// ─── Admin module editor helpers (used outside slide editor) ───────────────
async function movePageToChapter(pageId, newChapterId) {
  if (!newChapterId) return;
  await api('admin/updatePage', { page_id: pageId, chapter_id: parseInt(newChapterId) });
  toast('Page moved', 'success');
  editModule(STATE.editingModule.id);
}

async function movePageOrder(pageId, chapterId, direction) {
  const ch = (STATE.editingChapters || []).find(c => c.id === chapterId);
  if (!ch || !ch.pages) return;

  const idx = ch.pages.findIndex(p => p.id === pageId);
  if (idx < 0) return;

  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= ch.pages.length) return;

  const order = ch.pages.map((p, i) => ({ id: p.id, sort_order: i }));
  order[idx].sort_order = swapIdx;
  order[swapIdx].sort_order = idx;

  await api('admin/reorderPages', { order });
  editModule(STATE.editingModule.id);
}
