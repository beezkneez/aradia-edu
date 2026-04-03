require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3400;

// ─── Database ───────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads'));

// ─── File upload config ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.params.type || 'modules';
    const dir = path.join(__dirname, 'public', 'uploads', type);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

// ─── Auth helper (shared with aradia-time DB) ───────────────────────────────
async function getAuthorizedUser(email, pin) {
  try {
    const r = await pool.query(
      `SELECT id, email, name, type, username, is_active, profile_pic, preferred_theme,
              COALESCE(admin_permissions, '{}') as admin_permissions
       FROM users WHERE (LOWER(email)=LOWER($1) OR LOWER(username)=LOWER($1)) AND pin=$2 AND is_active=TRUE`,
      [email, pin]
    );
    if (r.rows.length === 0) return null;
    const u = r.rows[0];
    return {
      id: u.id, email: u.email, name: u.name, type: u.type,
      username: u.username, profile_pic: u.profile_pic,
      preferred_theme: u.preferred_theme,
      isAdmin: u.type === 'admin' || u.username === 'admin',
      isModerator: u.type === 'moderator',
      admin_permissions: u.admin_permissions
    };
  } catch (e) { console.error('Auth error:', e); return null; }
}

function isAdminOrMod(user) {
  return user && (user.isAdmin || user.isModerator);
}

// ─── Database initialization ────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`

      -- Modules (courses)
      CREATE TABLE IF NOT EXISTS edu_modules (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        cover_image TEXT DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        is_published BOOLEAN DEFAULT FALSE,
        sort_order INT DEFAULT 0
      );

      -- Chapters within a module
      CREATE TABLE IF NOT EXISTS edu_chapters (
        id SERIAL PRIMARY KEY,
        module_id INT REFERENCES edu_modules(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Pages within a chapter (slides)
      CREATE TABLE IF NOT EXISTS edu_pages (
        id SERIAL PRIMARY KEY,
        chapter_id INT REFERENCES edu_chapters(id) ON DELETE CASCADE,
        title TEXT DEFAULT '',
        content_type TEXT DEFAULT 'rich_text',
        content JSONB DEFAULT '{}',
        background_image TEXT DEFAULT '',
        video_url TEXT DEFAULT '',
        video_required BOOLEAN DEFAULT FALSE,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Assignments (who has access to what modules)
      CREATE TABLE IF NOT EXISTS edu_assignments (
        id SERIAL PRIMARY KEY,
        module_id INT REFERENCES edu_modules(id) ON DELETE CASCADE,
        user_email TEXT NOT NULL,
        assigned_by TEXT NOT NULL,
        due_date DATE,
        assigned_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(module_id, user_email)
      );

      -- Progress tracking
      CREATE TABLE IF NOT EXISTS edu_progress (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        module_id INT REFERENCES edu_modules(id) ON DELETE CASCADE,
        chapter_id INT REFERENCES edu_chapters(id) ON DELETE CASCADE,
        page_id INT REFERENCES edu_pages(id) ON DELETE CASCADE,
        completed BOOLEAN DEFAULT FALSE,
        video_watched BOOLEAN DEFAULT FALSE,
        completed_at TIMESTAMPTZ,
        UNIQUE(user_email, page_id)
      );

      -- Module completion tracking
      CREATE TABLE IF NOT EXISTS edu_module_completions (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        module_id INT REFERENCES edu_modules(id) ON DELETE CASCADE,
        completed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_email, module_id)
      );

      -- Manuals
      CREATE TABLE IF NOT EXISTS edu_manuals (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        category TEXT DEFAULT 'General',
        file_path TEXT NOT NULL,
        file_type TEXT DEFAULT 'pdf',
        uploaded_by TEXT NOT NULL,
        uploaded_at TIMESTAMPTZ DEFAULT NOW(),
        sort_order INT DEFAULT 0
      );

      -- Manual favorites
      CREATE TABLE IF NOT EXISTS edu_manual_favorites (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        manual_id INT REFERENCES edu_manuals(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_email, manual_id)
      );
    `);
    console.log('EDU tables initialized');
  } catch (e) {
    console.error('DB init error:', e);
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Auth ───────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, pin } = req.body;
  const user = await getAuthorizedUser(email, pin);
  if (!user) return res.json({ ok: false, reason: 'Invalid credentials' });

  // Check if user has any edu assignments or is admin
  const assignments = await pool.query(
    'SELECT COUNT(*) as count FROM edu_assignments WHERE LOWER(user_email)=LOWER($1)', [user.email]
  );

  res.json({ ok: true, user, hasAccess: isAdminOrMod(user) || parseInt(assignments.rows[0].count) > 0 });
});

// ─── Modules: List (for assigned user) ──────────────────────────────────────
app.post('/api/getMyModules', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });

  let modules;
  if (isAdminOrMod(user)) {
    modules = await pool.query(
      `SELECT m.*,
        (SELECT COUNT(*) FROM edu_chapters WHERE module_id=m.id) as chapter_count,
        (SELECT COUNT(*) FROM edu_pages p JOIN edu_chapters c ON p.chapter_id=c.id WHERE c.module_id=m.id) as page_count
       FROM edu_modules m WHERE m.is_published=TRUE ORDER BY m.sort_order, m.title`
    );
  } else {
    modules = await pool.query(
      `SELECT m.*, a.due_date, a.assigned_at,
        (SELECT COUNT(*) FROM edu_chapters WHERE module_id=m.id) as chapter_count,
        (SELECT COUNT(*) FROM edu_pages p JOIN edu_chapters c ON p.chapter_id=c.id WHERE c.module_id=m.id) as page_count
       FROM edu_modules m
       JOIN edu_assignments a ON a.module_id=m.id AND LOWER(a.user_email)=LOWER($1)
       WHERE m.is_published=TRUE
       ORDER BY a.due_date NULLS LAST, m.sort_order, m.title`,
      [user.email]
    );
  }

  // Get progress for each module
  for (const mod of modules.rows) {
    const progress = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE ep.completed=TRUE) as completed,
              COUNT(*) as total
       FROM edu_pages p
       JOIN edu_chapters c ON p.chapter_id=c.id
       LEFT JOIN edu_progress ep ON ep.page_id=p.id AND LOWER(ep.user_email)=LOWER($1)
       WHERE c.module_id=$2`,
      [user.email, mod.id]
    );
    mod.progress = progress.rows[0];

    const completion = await pool.query(
      'SELECT * FROM edu_module_completions WHERE LOWER(user_email)=LOWER($1) AND module_id=$2',
      [user.email, mod.id]
    );
    mod.is_completed = completion.rows.length > 0;
  }

  res.json({ ok: true, modules: modules.rows });
});

// ─── Module detail with chapters and pages ──────────────────────────────────
app.post('/api/getModule', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });

  const { module_id } = req.body;

  // Check access
  if (!isAdminOrMod(user)) {
    const access = await pool.query(
      'SELECT 1 FROM edu_assignments WHERE module_id=$1 AND LOWER(user_email)=LOWER($2)',
      [module_id, user.email]
    );
    if (access.rows.length === 0) return res.json({ ok: false, reason: 'No access' });
  }

  const mod = await pool.query('SELECT * FROM edu_modules WHERE id=$1', [module_id]);
  if (mod.rows.length === 0) return res.json({ ok: false, reason: 'Module not found' });

  const chapters = await pool.query(
    'SELECT * FROM edu_chapters WHERE module_id=$1 ORDER BY sort_order, id', [module_id]
  );

  for (const ch of chapters.rows) {
    const pages = await pool.query(
      'SELECT * FROM edu_pages WHERE chapter_id=$1 ORDER BY sort_order, id', [ch.id]
    );
    ch.pages = pages.rows;

    // Get progress for each page
    for (const pg of ch.pages) {
      const prog = await pool.query(
        'SELECT completed, video_watched FROM edu_progress WHERE page_id=$1 AND LOWER(user_email)=LOWER($2)',
        [pg.id, user.email]
      );
      pg.user_completed = prog.rows.length > 0 ? prog.rows[0].completed : false;
      pg.user_video_watched = prog.rows.length > 0 ? prog.rows[0].video_watched : false;
    }
  }

  res.json({ ok: true, module: mod.rows[0], chapters: chapters.rows });
});

// ─── Mark page complete ─────────────────────────────────────────────────────
app.post('/api/markPageComplete', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });

  const { page_id, module_id, chapter_id, video_watched } = req.body;

  await pool.query(
    `INSERT INTO edu_progress (user_email, module_id, chapter_id, page_id, completed, video_watched, completed_at)
     VALUES (LOWER($1), $2, $3, $4, TRUE, COALESCE($5, FALSE), NOW())
     ON CONFLICT (user_email, page_id) DO UPDATE SET completed=TRUE, video_watched=COALESCE($5, edu_progress.video_watched), completed_at=NOW()`,
    [user.email, module_id, chapter_id, page_id, video_watched || false]
  );

  // Check if all pages in module are complete
  const check = await pool.query(
    `SELECT
      (SELECT COUNT(*) FROM edu_pages p JOIN edu_chapters c ON p.chapter_id=c.id WHERE c.module_id=$1) as total,
      (SELECT COUNT(*) FROM edu_progress WHERE module_id=$1 AND LOWER(user_email)=LOWER($2) AND completed=TRUE) as done`,
    [module_id, user.email]
  );

  const { total, done } = check.rows[0];
  let moduleComplete = false;

  if (parseInt(done) >= parseInt(total) && parseInt(total) > 0) {
    await pool.query(
      `INSERT INTO edu_module_completions (user_email, module_id) VALUES (LOWER($1), $2)
       ON CONFLICT (user_email, module_id) DO NOTHING`,
      [user.email, module_id]
    );
    moduleComplete = true;
  }

  res.json({ ok: true, moduleComplete, pagesCompleted: parseInt(done), totalPages: parseInt(total) });
});

// ─── Mark video watched ─────────────────────────────────────────────────────
app.post('/api/markVideoWatched', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });

  const { page_id, module_id, chapter_id } = req.body;

  await pool.query(
    `INSERT INTO edu_progress (user_email, module_id, chapter_id, page_id, completed, video_watched, completed_at)
     VALUES (LOWER($1), $2, $3, $4, FALSE, TRUE, NOW())
     ON CONFLICT (user_email, page_id) DO UPDATE SET video_watched=TRUE`,
    [user.email, module_id, chapter_id, page_id]
  );

  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Admin: Get all modules (including unpublished) ─────────────────────────
app.post('/api/admin/getModules', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const modules = await pool.query(
    `SELECT m.*,
      (SELECT COUNT(*) FROM edu_chapters WHERE module_id=m.id) as chapter_count,
      (SELECT COUNT(*) FROM edu_pages p JOIN edu_chapters c ON p.chapter_id=c.id WHERE c.module_id=m.id) as page_count,
      (SELECT COUNT(*) FROM edu_assignments WHERE module_id=m.id) as assigned_count
     FROM edu_modules m ORDER BY m.sort_order, m.created_at DESC`
  );
  res.json({ ok: true, modules: modules.rows });
});

// ─── Admin: Create module ───────────────────────────────────────────────────
app.post('/api/admin/createModule', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { title, description } = req.body;
  const r = await pool.query(
    'INSERT INTO edu_modules (title, description, created_by) VALUES ($1, $2, $3) RETURNING *',
    [title, description || '', user.email]
  );
  res.json({ ok: true, module: r.rows[0] });
});

// ─── Admin: Update module ───────────────────────────────────────────────────
app.post('/api/admin/updateModule', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { module_id, title, description, is_published, cover_image } = req.body;
  await pool.query(
    `UPDATE edu_modules SET title=COALESCE($1,title), description=COALESCE($2,description),
     is_published=COALESCE($3,is_published), cover_image=COALESCE($4,cover_image), updated_at=NOW()
     WHERE id=$5`,
    [title, description, is_published, cover_image, module_id]
  );
  res.json({ ok: true });
});

// ─── Admin: Delete module ───────────────────────────────────────────────────
app.post('/api/admin/deleteModule', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  await pool.query('DELETE FROM edu_modules WHERE id=$1', [req.body.module_id]);
  res.json({ ok: true });
});

// ─── Admin: Chapter CRUD ────────────────────────────────────────────────────
app.post('/api/admin/createChapter', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { module_id, title } = req.body;
  const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 as next FROM edu_chapters WHERE module_id=$1', [module_id]);
  const r = await pool.query(
    'INSERT INTO edu_chapters (module_id, title, sort_order) VALUES ($1, $2, $3) RETURNING *',
    [module_id, title, maxOrder.rows[0].next]
  );
  res.json({ ok: true, chapter: r.rows[0] });
});

app.post('/api/admin/updateChapter', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { chapter_id, title, sort_order } = req.body;
  await pool.query(
    'UPDATE edu_chapters SET title=COALESCE($1,title), sort_order=COALESCE($2,sort_order) WHERE id=$3',
    [title, sort_order, chapter_id]
  );
  res.json({ ok: true });
});

app.post('/api/admin/deleteChapter', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  await pool.query('DELETE FROM edu_chapters WHERE id=$1', [req.body.chapter_id]);
  res.json({ ok: true });
});

// ─── Admin: Page CRUD ───────────────────────────────────────────────────────
app.post('/api/admin/createPage', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { chapter_id, title, content_type, content, background_image, video_url, video_required } = req.body;
  const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 as next FROM edu_pages WHERE chapter_id=$1', [chapter_id]);
  const r = await pool.query(
    `INSERT INTO edu_pages (chapter_id, title, content_type, content, background_image, video_url, video_required, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [chapter_id, title || '', content_type || 'rich_text', JSON.stringify(content || {}), background_image || '', video_url || '', video_required || false, maxOrder.rows[0].next]
  );
  res.json({ ok: true, page: r.rows[0] });
});

app.post('/api/admin/updatePage', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { page_id, title, content_type, content, background_image, video_url, video_required, sort_order } = req.body;
  await pool.query(
    `UPDATE edu_pages SET title=COALESCE($1,title), content_type=COALESCE($2,content_type),
     content=COALESCE($3,content), background_image=COALESCE($4,background_image),
     video_url=COALESCE($5,video_url), video_required=COALESCE($6,video_required),
     sort_order=COALESCE($7,sort_order) WHERE id=$8`,
    [title, content_type, content ? JSON.stringify(content) : null, background_image, video_url, video_required, sort_order, page_id]
  );
  res.json({ ok: true });
});

app.post('/api/admin/deletePage', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  await pool.query('DELETE FROM edu_pages WHERE id=$1', [req.body.page_id]);
  res.json({ ok: true });
});

// ─── Admin: Reorder chapters ────────────────────────────────────────────────
app.post('/api/admin/reorderChapters', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { order } = req.body; // [{id, sort_order}]
  for (const item of order) {
    await pool.query('UPDATE edu_chapters SET sort_order=$1 WHERE id=$2', [item.sort_order, item.id]);
  }
  res.json({ ok: true });
});

// ─── Admin: Reorder pages ───────────────────────────────────────────────────
app.post('/api/admin/reorderPages', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { order } = req.body;
  for (const item of order) {
    await pool.query('UPDATE edu_pages SET sort_order=$1 WHERE id=$2', [item.sort_order, item.id]);
  }
  res.json({ ok: true });
});

// ─── Admin: Assignments ─────────────────────────────────────────────────────
app.post('/api/admin/getAssignments', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { module_id } = req.body;
  const r = await pool.query(
    `SELECT a.*, u.name as user_name
     FROM edu_assignments a
     LEFT JOIN users u ON LOWER(u.email)=LOWER(a.user_email)
     WHERE a.module_id=$1 ORDER BY u.name`,
    [module_id]
  );
  res.json({ ok: true, assignments: r.rows });
});

app.post('/api/admin/assignModule', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { module_id, user_email, due_date } = req.body;
  await pool.query(
    `INSERT INTO edu_assignments (module_id, user_email, assigned_by, due_date)
     VALUES ($1, LOWER($2), $3, $4)
     ON CONFLICT (module_id, user_email) DO UPDATE SET due_date=$4`,
    [module_id, user_email, user.email, due_date || null]
  );
  res.json({ ok: true });
});

app.post('/api/admin/unassignModule', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  await pool.query(
    'DELETE FROM edu_assignments WHERE module_id=$1 AND LOWER(user_email)=LOWER($2)',
    [req.body.module_id, req.body.user_email]
  );
  res.json({ ok: true });
});

// ─── Admin: Progress overview ───────────────────────────────────────────────
app.post('/api/admin/getProgress', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { module_id } = req.body;

  // Get all assigned users and their progress
  const r = await pool.query(
    `SELECT a.user_email, u.name as user_name, a.due_date, a.assigned_at,
      (SELECT COUNT(*) FROM edu_pages p JOIN edu_chapters c ON p.chapter_id=c.id WHERE c.module_id=$1) as total_pages,
      (SELECT COUNT(*) FROM edu_progress WHERE module_id=$1 AND LOWER(user_email)=LOWER(a.user_email) AND completed=TRUE) as completed_pages,
      (SELECT completed_at FROM edu_module_completions WHERE module_id=$1 AND LOWER(user_email)=LOWER(a.user_email)) as module_completed_at
     FROM edu_assignments a
     LEFT JOIN users u ON LOWER(u.email)=LOWER(a.user_email)
     WHERE a.module_id=$1
     ORDER BY u.name`,
    [module_id]
  );
  res.json({ ok: true, progress: r.rows });
});

// ─── Admin: All progress overview ───────────────────────────────────────────
app.post('/api/admin/getAllProgress', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const r = await pool.query(
    `SELECT u.email, u.name,
      (SELECT COUNT(*) FROM edu_assignments WHERE LOWER(user_email)=LOWER(u.email)) as assigned_modules,
      (SELECT COUNT(*) FROM edu_module_completions WHERE LOWER(user_email)=LOWER(u.email)) as completed_modules
     FROM users u WHERE u.is_active=TRUE
     ORDER BY u.name`
  );
  res.json({ ok: true, users: r.rows });
});

// ─── Admin: Get staff list (for assignment) ─────────────────────────────────
app.post('/api/admin/getStaff', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const r = await pool.query('SELECT id, email, name, type, username FROM users WHERE is_active=TRUE ORDER BY name');
  res.json({ ok: true, staff: r.rows });
});

// ─── Admin: File upload ─────────────────────────────────────────────────────
app.post('/api/admin/upload/:type', upload.single('file'), async (req, res) => {
  try {
    const user = await getAuthorizedUser(req.body.email, req.body.pin);
    if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

    if (!req.file) return res.json({ ok: false, reason: 'No file uploaded' });

    const filePath = `/uploads/${req.params.type}/${req.file.filename}`;
    res.json({ ok: true, filePath, originalName: req.file.originalname });
  } catch (e) {
    console.error('Upload error:', e);
    res.json({ ok: false, reason: 'Upload failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MANUALS API
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/getManuals', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });

  const manuals = await pool.query(
    'SELECT * FROM edu_manuals ORDER BY category, sort_order, title'
  );

  const favorites = await pool.query(
    'SELECT manual_id FROM edu_manual_favorites WHERE LOWER(user_email)=LOWER($1)',
    [user.email]
  );
  const favSet = new Set(favorites.rows.map(f => f.manual_id));

  for (const m of manuals.rows) {
    m.is_favorite = favSet.has(m.id);
  }

  res.json({ ok: true, manuals: manuals.rows });
});

app.post('/api/toggleManualFavorite', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });

  const { manual_id } = req.body;
  const existing = await pool.query(
    'SELECT id FROM edu_manual_favorites WHERE LOWER(user_email)=LOWER($1) AND manual_id=$2',
    [user.email, manual_id]
  );

  if (existing.rows.length > 0) {
    await pool.query('DELETE FROM edu_manual_favorites WHERE id=$1', [existing.rows[0].id]);
    res.json({ ok: true, favorited: false });
  } else {
    await pool.query(
      'INSERT INTO edu_manual_favorites (user_email, manual_id) VALUES (LOWER($1), $2)',
      [user.email, manual_id]
    );
    res.json({ ok: true, favorited: true });
  }
});

// ─── Admin: Manual CRUD ─────────────────────────────────────────────────────
app.post('/api/admin/createManual', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { title, description, category, file_path, file_type } = req.body;
  const r = await pool.query(
    'INSERT INTO edu_manuals (title, description, category, file_path, file_type, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [title, description || '', category || 'General', file_path, file_type || 'pdf', user.email]
  );
  res.json({ ok: true, manual: r.rows[0] });
});

app.post('/api/admin/updateManual', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const { manual_id, title, description, category } = req.body;
  await pool.query(
    'UPDATE edu_manuals SET title=COALESCE($1,title), description=COALESCE($2,description), category=COALESCE($3,category) WHERE id=$4',
    [title, description, category, manual_id]
  );
  res.json({ ok: true });
});

app.post('/api/admin/deleteManual', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const manual = await pool.query('SELECT file_path FROM edu_manuals WHERE id=$1', [req.body.manual_id]);
  if (manual.rows.length > 0) {
    const fullPath = path.join(__dirname, 'public', manual.rows[0].file_path);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
  await pool.query('DELETE FROM edu_manuals WHERE id=$1', [req.body.manual_id]);
  res.json({ ok: true });
});

// ─── Catch-all: serve SPA ───────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ──────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`Aradia EDU running on port ${PORT}`));
});
