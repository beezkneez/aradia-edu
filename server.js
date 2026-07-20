require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3400;

// ─── Database ───────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads', { maxAge: '7d' }));

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

// ─── Bunny Stream (video hosting) ───────────────────────────────────────────
// New edu videos are uploaded to a Bunny Stream library and stored as a Bunny
// iframe-embed URL in edu_videos.file_path (file_type='bunny_video'). Because
// every player (edu app + the aradia-time mirror) just iframes file_path, the
// Bunny player works everywhere with no player-code changes. Old Drive videos
// keep their drive.google.com/preview file_path and keep working.
const BUNNY_LIB = (process.env.BUNNY_STREAM_LIBRARY_ID || '').trim();
const BUNNY_KEY = (process.env.BUNNY_STREAM_API_KEY || '').trim();
// Pull-zone CDN host (e.g. vz-xxxx.b-cdn.net) — used to build poster/thumbnail URLs.
const BUNNY_CDN = (process.env.BUNNY_STREAM_CDN_HOSTNAME || '').trim()
  .replace(/^https?:\/\//, '').replace(/\/+$/, '');
const bunnyConfigured = () => Boolean(BUNNY_LIB && BUNNY_KEY);
const bunnyEmbedUrl = (guid) => `https://iframe.mediadelivery.net/embed/${BUNNY_LIB}/${guid}`;
function bunnyGuidFromPath(fp) {
  const m = String(fp || '').match(/iframe\.mediadelivery\.net\/(?:embed|play)\/\d+\/([a-f0-9-]{36})/i);
  return m ? m[1] : null;
}
// Extract a Google Drive file id from a /file/d/<id>/... or ?id=<id> URL.
function driveIdFromPath(fp) {
  const s = String(fp || '');
  const m = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
// Best-effort poster image for a video row, derived from its source:
//   • bunny_video → Bunny Stream's auto-generated thumbnail on the pull zone
//   • drive_video → Google Drive's public thumbnail endpoint
// Returns '' when no thumbnail can be built (client falls back to an icon).
function videoThumbnailUrl(row) {
  if (!row) return '';
  if (row.file_type === 'bunny_video' && BUNNY_CDN) {
    // The Bunny pull zone uses referrer hotlink protection, so a browser <img>
    // from our origin is blocked. Point at our same-origin proxy instead, which
    // fetches server-side with an allowed Referer (see /api/videoThumb/:guid).
    const guid = bunnyGuidFromPath(row.file_path);
    if (guid) return `/api/videoThumb/${guid}`;
  }
  if (row.file_type === 'drive_video') {
    const id = driveIdFromPath(row.file_path);
    if (id) return `https://drive.google.com/thumbnail?id=${id}&sz=w800`;
  }
  return '';
}
// Best-effort: remove a Bunny-hosted video when its edu_videos row is deleted,
// so we don't pay to store orphans. Never throws — cleanup is non-critical.
async function maybeDeleteFromBunny(row) {
  if (!row || row.file_type !== 'bunny_video' || !bunnyConfigured()) return;
  const guid = bunnyGuidFromPath(row.file_path);
  if (!guid) return;
  try {
    await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIB}/videos/${guid}`, {
      method: 'DELETE', headers: { AccessKey: BUNNY_KEY }
    });
  } catch (e) { console.error('Bunny delete failed:', e.message); }
}

// Temp landing spot for a video before it's streamed up to Bunny, then removed.
// (This server's disk is ephemeral — nothing video-sized is meant to live here.)
const bunnyTmpDir = path.join(__dirname, 'public', 'uploads', '_tmp');
const bunnyUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!fs.existsSync(bunnyTmpDir)) fs.mkdirSync(bunnyTmpDir, { recursive: true });
      cb(null, bunnyTmpDir);
    },
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB — comfortably above the ~30MB norm
});

// ─── Bunny Storage (file hosting for manual PDFs) ───────────────────────────
// Manual PDFs upload to a Bunny Storage Zone and are served via its pull zone;
// edu_manuals.file_path holds the public CDN URL. Replaces the old local-disk
// uploads, which were ephemeral on Railway. Old Drive/local manuals still work.
const BST_ZONE = (process.env.BUNNY_STORAGE_ZONE || '').trim();
const BST_PW = (process.env.BUNNY_STORAGE_PASSWORD || '').trim();
const BST_HOST = (process.env.BUNNY_STORAGE_HOSTNAME || '').trim();          // pull-zone hostname, e.g. aradia-edu-files.b-cdn.net
const BST_API = (process.env.BUNNY_STORAGE_API_HOST || 'storage.bunnycdn.com').trim(); // region endpoint (Frankfurt = default)
const bunnyStorageConfigured = () => Boolean(BST_ZONE && BST_PW && BST_HOST);
async function bunnyStoragePut(remotePath, buf) {
  const r = await fetch(`https://${BST_API}/${BST_ZONE}/${remotePath}`, {
    method: 'PUT', headers: { AccessKey: BST_PW, 'Content-Type': 'application/octet-stream' }, body: buf
  });
  if (!r.ok) throw new Error('storage PUT ' + r.status);
  return `https://${BST_HOST}/${remotePath}`;
}
// If a file_path is a URL under our pull zone, return its storage path, else null.
function bunnyStoragePathFromUrl(fp) {
  if (!BST_HOST) return null;
  const pref = `https://${BST_HOST}/`;
  return String(fp || '').startsWith(pref) ? String(fp).slice(pref.length) : null;
}
async function maybeDeleteFromBunnyStorage(fp) {
  const rp = bunnyStoragePathFromUrl(fp);
  if (!rp || !bunnyStorageConfigured()) return;
  try {
    await fetch(`https://${BST_API}/${BST_ZONE}/${rp}`, { method: 'DELETE', headers: { AccessKey: BST_PW } });
  } catch (e) { console.error('Bunny storage delete failed:', e.message); }
}

// ─── Auth helper (shared with aradia-time DB) ───────────────────────────────
async function getAuthorizedUser(email, pin) {
  try {
    const r = await pool.query(
      `SELECT id, email, name, type, username, is_active, profile_pic, preferred_theme, pin,
              is_superuser, COALESCE(teaches, '') as teaches,
              COALESCE(admin_permissions, '{}') as admin_permissions
       FROM users WHERE (LOWER(email)=LOWER($1) OR LOWER(username)=LOWER($1)) AND is_active=TRUE`,
      [email]
    );
    if (r.rows.length === 0) return null;
    const u = r.rows[0];
    const pinStr = String(pin || '').trim();
    const storedPin = u.pin || '';
    let ok = false;
    // Support both bcrypt hashed and plain text PINs (transitional).
    // On a successful plaintext match, auto-migrate to bcrypt.
    if (storedPin.startsWith('$2b$') || storedPin.startsWith('$2a$')) {
      ok = await bcrypt.compare(pinStr, storedPin);
    } else if (storedPin && storedPin === pinStr) {
      ok = true;
      try {
        const hashed = await bcrypt.hash(storedPin, 10);
        await pool.query(`UPDATE users SET pin=$1 WHERE id=$2`, [hashed, u.id]);
      } catch (e) {
        console.warn(`[AUTH] Failed to auto-hash plaintext PIN for ${u.email}: ${e.message}`);
      }
    }
    // Alternative credential: an edu session token (issued via SSO hand-off from
    // the portal). Lets a user authenticate without their PIN ever hitting a URL.
    if (!ok && pinStr) {
      const s = await pool.query(
        `SELECT 1 FROM edu_sessions WHERE token=$1 AND LOWER(user_email)=LOWER($2) AND expires_at > NOW()`,
        [pinStr, u.email]
      );
      if (s.rows.length) ok = true;
    }
    if (!ok) return null;
    return shapeUser(u);
  } catch (e) { console.error('Auth error:', e); return null; }
}

// Same projection as getAuthorizedUser, without a credential check. Only call
// after the caller's identity has already been proven (e.g. a valid SSO token).
function shapeUser(u) {
  // admin_permissions is a JSON string (shared with aradia-time). It maps a
  // feature key to an access level ("r" | "w" | "rw"). The "edu" key grants
  // EDU-only moderator rights here WITHOUT making the person a full aradia-time
  // moderator — set from aradia-time's Permissions page.
  let perms = {};
  try {
    perms = typeof u.admin_permissions === 'string'
      ? JSON.parse(u.admin_permissions || '{}')
      : (u.admin_permissions || {});
  } catch (e) { perms = {}; }
  const isEduMod = !!perms.edu;
  return {
    id: u.id, email: u.email, name: u.name, type: u.type,
    username: u.username, profile_pic: u.profile_pic,
    preferred_theme: u.preferred_theme,
    isAdmin: u.is_superuser === true || u.type === 'admin' || u.username === 'admin',
    isModerator: u.type === 'moderator' || isEduMod,
    isEduMod,
    teaches: u.teaches,
    admin_permissions: perms
  };
}

async function getUserByEmail(email) {
  try {
    const r = await pool.query(
      `SELECT id, email, name, type, username, is_active, profile_pic, preferred_theme, pin,
              is_superuser, COALESCE(teaches, '') as teaches,
              COALESCE(admin_permissions, '{}') as admin_permissions
       FROM users WHERE LOWER(email)=LOWER($1) AND is_active=TRUE`,
      [email]
    );
    if (r.rows.length === 0) return null;
    return shapeUser(r.rows[0]);
  } catch (e) { console.error('getUserByEmail error:', e); return null; }
}

function isAdminOrMod(user) {
  return user && (user.isAdmin || user.isModerator);
}

// Decide whether a resource category is visible to a non-admin user
// based on their comma-separated `teaches` string. "Routines" is universal.
// Matches by substring either way: teach "pole" matches "Pole 101"; teach
// "aerial hoop" matches "Aerial Hoop Level 1".
function categoryVisibleTo(category, teachesStr) {
  const cat = String(category || '').toLowerCase().trim();
  if (!cat) return false;
  if (cat === 'routines') return true;
  const teaches = String(teachesStr || '').toLowerCase()
    .split(',').map(s => s.trim()).filter(Boolean);
  for (const t of teaches) {
    if (cat.includes(t) || t.includes(cat)) return true;
  }
  return false;
}

// Attach `categories` [{id,name}], `category_ids`, and `category_names` to each
// item from its join table, falling back to the single text `category` column
// when the item has no join rows. joinTable/fkCol are fixed internal strings.
async function attachCategories(items, joinTable, fkCol) {
  if (!items.length) return;
  const ids = items.map(i => i.id);
  const r = await pool.query(
    `SELECT jt.${fkCol} AS item_id, c.id, c.name
       FROM ${joinTable} jt JOIN edu_categories c ON c.id = jt.category_id
      WHERE jt.${fkCol} = ANY($1::int[])
      ORDER BY c.sort_order, c.name`,
    [ids]
  );
  const byItem = {};
  for (const row of r.rows) {
    (byItem[row.item_id] = byItem[row.item_id] || []).push({ id: row.id, name: row.name });
  }
  for (const it of items) {
    let cats = byItem[it.id];
    if (!cats || !cats.length) cats = it.category ? [{ id: null, name: it.category }] : [];
    it.categories = cats;
    it.category_ids = cats.map(c => c.id).filter(x => x != null);
    it.category_names = cats.map(c => c.name);
  }
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

      -- Per-user notes on a manual (private; never shown to other users)
      CREATE TABLE IF NOT EXISTS edu_manual_notes (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        manual_id INT REFERENCES edu_manuals(id) ON DELETE CASCADE,
        notes TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_email, manual_id)
      );

      -- Videos library (Drive-hosted)
      CREATE TABLE IF NOT EXISTS edu_videos (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        category TEXT DEFAULT 'General',
        file_path TEXT NOT NULL,
        file_type TEXT DEFAULT 'drive_video',
        uploaded_by TEXT NOT NULL,
        uploaded_at TIMESTAMPTZ DEFAULT NOW(),
        sort_order INT DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS edu_video_favorites (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        video_id INT REFERENCES edu_videos(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_email, video_id)
      );

      CREATE TABLE IF NOT EXISTS edu_video_notes (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        video_id INT REFERENCES edu_videos(id) ON DELETE CASCADE,
        notes TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_email, video_id)
      );

      -- Links a video to one or more manuals (many-to-many). A video can be
      -- attached to several manuals; a manual can show several videos.
      CREATE TABLE IF NOT EXISTS edu_manual_videos (
        id SERIAL PRIMARY KEY,
        manual_id INT REFERENCES edu_manuals(id) ON DELETE CASCADE,
        video_id INT REFERENCES edu_videos(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(manual_id, video_id)
      );

      -- Many-to-many: a manual/video can belong to several categories. When an
      -- item has NO rows here, its single text category column is used as a
      -- fallback, so older insert paths keep working until edited.
      CREATE TABLE IF NOT EXISTS edu_manual_categories (
        manual_id INT REFERENCES edu_manuals(id) ON DELETE CASCADE,
        category_id INT REFERENCES edu_categories(id) ON DELETE CASCADE,
        PRIMARY KEY (manual_id, category_id)
      );
      CREATE TABLE IF NOT EXISTS edu_video_categories (
        video_id INT REFERENCES edu_videos(id) ON DELETE CASCADE,
        category_id INT REFERENCES edu_categories(id) ON DELETE CASCADE,
        PRIMARY KEY (video_id, category_id)
      );

      -- Per-user page bookmarks within a manual (private, like notes).
      CREATE TABLE IF NOT EXISTS edu_manual_bookmarks (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        manual_id INT REFERENCES edu_manuals(id) ON DELETE CASCADE,
        page INT NOT NULL DEFAULT 1,
        label TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Category catalog (shared by manuals + videos). applies_to is
      -- 'manual', 'video', or 'both' to control which dropdowns it shows in.
      CREATE TABLE IF NOT EXISTS edu_categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applies_to TEXT DEFAULT 'both' CHECK (applies_to IN ('manual', 'video', 'both')),
        sort_order INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- One-time SSO hand-off tokens written by aradia-time (portal) so a
      -- logged-in portal user lands here already authenticated. Shared DB.
      CREATE TABLE IF NOT EXISTS edu_sso_tokens (
        token       TEXT PRIMARY KEY,
        user_email  TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ
      );

      -- Edu session tokens minted after a successful SSO hand-off. These act as
      -- an alternative credential to the PIN for subsequent /api calls, so the
      -- user's real PIN never needs to travel through a URL.
      CREATE TABLE IF NOT EXISTS edu_sessions (
        token       TEXT PRIMARY KEY,
        user_email  TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ NOT NULL
      );
    `);

    // Seed edu_categories from any distinct categories already in use,
    // plus ensure the "Aradia" category exists across both surfaces.
    await client.query(`
      INSERT INTO edu_categories (name, applies_to)
      SELECT DISTINCT category, 'both' FROM (
        SELECT category FROM edu_manuals WHERE category IS NOT NULL AND category <> ''
        UNION
        SELECT category FROM edu_videos WHERE category IS NOT NULL AND category <> ''
      ) s
      ON CONFLICT (name) DO NOTHING;

      INSERT INTO edu_categories (name, applies_to)
      VALUES ('Aradia', 'both')
      ON CONFLICT (name) DO NOTHING;
    `);

    // Backfill the category join tables from each item's single text category,
    // but only for items that don't have any join rows yet (so this never
    // resurrects a category a user has since removed).
    await client.query(`
      INSERT INTO edu_manual_categories (manual_id, category_id)
      SELECT m.id, c.id FROM edu_manuals m
      JOIN edu_categories c ON c.name = m.category
      WHERE m.category IS NOT NULL AND m.category <> ''
        AND NOT EXISTS (SELECT 1 FROM edu_manual_categories mc WHERE mc.manual_id = m.id)
      ON CONFLICT DO NOTHING;

      INSERT INTO edu_video_categories (video_id, category_id)
      SELECT v.id, c.id FROM edu_videos v
      JOIN edu_categories c ON c.name = v.category
      WHERE v.category IS NOT NULL AND v.category <> ''
        AND NOT EXISTS (SELECT 1 FROM edu_video_categories vc WHERE vc.video_id = v.id)
      ON CONFLICT DO NOTHING;
    `);

    // Category cover image (uploaded to Bunny Storage) — shown as the row icon.
    await client.query(`ALTER TABLE edu_categories ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT ''`);
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

// ─── Brand logo (mirrors aradia-time) ────────────────────────────────────────
// The studio's brand logo is stored once in the shared `settings` table under
// key `brandLogoUrl` (edited from aradia-time's Branding card). We read the same
// value so the EDU header/login show the identical logo — change it there, it
// changes here. Cached in-process and refreshed periodically to stay off the hot
// path. Falls back to the BRAND_LOGO_URL env var, then empty (text wordmark only).
let _brandLogoUrl = process.env.BRAND_LOGO_URL || '';
async function refreshBrandLogo() {
  try {
    const r = await pool.query(
      `SELECT value FROM settings WHERE tenant_id=1 AND key='brandLogoUrl' LIMIT 1`
    );
    if (r.rows[0] && r.rows[0].value) _brandLogoUrl = r.rows[0].value;
  } catch (e) { /* keep env / last-known value — non-critical */ }
}
refreshBrandLogo();
const _brandTimer = setInterval(refreshBrandLogo, 5 * 60 * 1000);
if (_brandTimer.unref) _brandTimer.unref();

app.get('/api/brand', (req, res) => {
  res.json({ ok: true, logoUrl: _brandLogoUrl || '' });
});

// ─── Video thumbnail proxy (Bunny Stream) ────────────────────────────────────
// Bunny's pull zone blocks direct file access from non-allowed referrers, so a
// browser <img> pointing straight at the CDN thumbnail gets a 403. We fetch it
// server-side with an allowed Referer and stream it back from our own origin.
// The guid is validated to a strict UUID shape so this can only ever reach a
// thumbnail on our configured Stream CDN — not an arbitrary URL.
app.get('/api/videoThumb/:guid', async (req, res) => {
  const guid = String(req.params.guid || '');
  if (!BUNNY_CDN || !/^[a-f0-9-]{36}$/i.test(guid)) return res.status(404).end();
  try {
    const upstream = await fetch(`https://${BUNNY_CDN}/${guid}/thumbnail.jpg`, {
      headers: { Referer: 'https://iframe.mediadelivery.net/' }
    });
    if (!upstream.ok) return res.status(404).end();
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');  // 1 day — posters rarely change
    res.end(buf);
  } catch (e) { res.status(404).end(); }
});

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

// ─── SSO hand-off from the portal (aradia-time) ──────────────────────────────
// Exchanges a one-time token (minted by the portal for an already-authenticated
// user) for an edu session, so the user lands here without re-entering creds.
app.post('/api/sso', async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || '').trim();
    if (!token) return res.json({ ok: false, reason: 'Missing token' });

    // Atomically consume the token: only one request can flip used_at from NULL.
    const consume = await pool.query(
      `UPDATE edu_sso_tokens SET used_at = NOW()
       WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING user_email`,
      [token]
    );
    if (consume.rows.length === 0) return res.json({ ok: false, reason: 'Invalid or expired link' });

    const user = await getUserByEmail(consume.rows[0].user_email);
    if (!user) return res.json({ ok: false, reason: 'User not found' });

    // Mint a 30-day edu session that stands in for the PIN on subsequent calls.
    const session = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO edu_sessions (token, user_email, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [session, user.email]
    );

    const assignments = await pool.query(
      'SELECT COUNT(*) as count FROM edu_assignments WHERE LOWER(user_email)=LOWER($1)', [user.email]
    );
    res.json({ ok: true, user, session, hasAccess: isAdminOrMod(user) || parseInt(assignments.rows[0].count) > 0 });
  } catch (e) {
    console.error('SSO error:', e);
    res.json({ ok: false, reason: 'SSO failed' });
  }
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

  const { page_id, chapter_id, title, content_type, content, background_image, video_url, video_required, sort_order } = req.body;
  await pool.query(
    `UPDATE edu_pages SET chapter_id=COALESCE($1,chapter_id), title=COALESCE($2,title), content_type=COALESCE($3,content_type),
     content=COALESCE($4,content), background_image=COALESCE($5,background_image),
     video_url=COALESCE($6,video_url), video_required=COALESCE($7,video_required),
     sort_order=COALESCE($8,sort_order) WHERE id=$9`,
    [chapter_id, title, content_type, content ? JSON.stringify(content) : null, background_image, video_url, video_required, sort_order, page_id]
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

// ─── Admin: upload a manual (PDF/doc) to Bunny Storage ──────────────────────
// Receives the file to a temp path, PUTs it to the Bunny Storage Zone, returns
// the public pull-zone URL. Falls back with a clear error if not configured.
app.post('/api/admin/uploadManualBunny', bunnyUpload.single('file'), async (req, res) => {
  const tmpPath = req.file && req.file.path;
  try {
    const user = await getAuthorizedUser(req.body.email, req.body.pin);
    if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
    if (!bunnyStorageConfigured()) return res.json({ ok: false, reason: 'File hosting is not configured — set BUNNY_STORAGE_ZONE / _PASSWORD / _HOSTNAME.' });
    if (!req.file) return res.json({ ok: false, reason: 'No file uploaded' });
    const ext = (path.extname(req.file.originalname) || '.pdf').toLowerCase();
    const remotePath = `manuals/${uuidv4()}${ext}`;
    const url = await bunnyStoragePut(remotePath, fs.readFileSync(tmpPath));
    res.json({ ok: true, filePath: url, originalName: req.file.originalname });
  } catch (e) {
    console.error('uploadManualBunny error:', e);
    res.json({ ok: false, reason: 'Upload failed: ' + (e.message || 'unknown error') });
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
  }
});

// ─── Stream a manual's file same-origin (for the in-app pdf.js viewer) ──────
// Mobile browsers won't render a raw cross-origin PDF inside an iframe, so the
// viewer uses pdf.js — which needs the bytes same-origin. This proxies the
// manual's file_path (Bunny/Drive/etc.) through our own origin. Auth via query
// params so it can be used as a plain <...>getDocument(url) source.
app.get('/api/manualFile', async (req, res) => {
  try {
    const user = await getAuthorizedUser(req.query.email, req.query.pin);
    if (!user) return res.status(403).send('Unauthorized');
    const r = await pool.query('SELECT file_path FROM edu_manuals WHERE id=$1', [req.query.id]);
    if (!r.rows.length) return res.status(404).send('Not found');
    const up = await fetch(r.rows[0].file_path);
    if (!up.ok) return res.status(502).send('Upstream ' + up.status);
    res.setHeader('Content-Type', up.headers.get('content-type') || 'application/pdf');
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.send(Buffer.from(await up.arrayBuffer()));
  } catch (e) { console.error('manualFile error:', e); res.status(500).send('error'); }
});

// ─── Admin: Get PDF page count ──────────────────────────────────────────────
app.post('/api/admin/getPdfPageCount', async (req, res) => {
  try {
    const user = await getAuthorizedUser(req.body.email, req.body.pin);
    if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

    const filePath = path.join(__dirname, 'public', req.body.file_path);
    if (!fs.existsSync(filePath)) return res.json({ ok: false, reason: 'File not found' });

    // Read PDF and count /Type /Page occurrences (simple approach)
    const data = fs.readFileSync(filePath);
    const text = data.toString('latin1');

    // Count page objects - look for /Type /Page (not /Pages)
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    const pageCount = matches ? matches.length : 1;

    res.json({ ok: true, pageCount: Math.max(1, pageCount) });
  } catch (e) {
    console.error('PDF page count error:', e);
    res.json({ ok: true, pageCount: 1 });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MANUALS API
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/getManuals', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });

  const allManuals = await pool.query(
    'SELECT * FROM edu_manuals ORDER BY category, sort_order, title'
  );
  await attachCategories(allManuals.rows, 'edu_manual_categories', 'manual_id');

  // Filter by what the user teaches. Admins/mods see everything. A manual is
  // visible if ANY of its categories is visible. See categoryVisibleTo().
  const manuals = isAdminOrMod(user)
    ? allManuals.rows
    : allManuals.rows.filter(m => (m.category_names || []).some(cn => categoryVisibleTo(cn, user.teaches)));

  const favorites = await pool.query(
    'SELECT manual_id FROM edu_manual_favorites WHERE LOWER(user_email)=LOWER($1)',
    [user.email]
  );
  const favSet = new Set(favorites.rows.map(f => f.manual_id));

  const catImgM = await categoryImageMap();
  for (const m of manuals) {
    m.is_favorite = favSet.has(m.id);
    const ck = (m.category || (m.category_names && m.category_names[0]) || '').toLowerCase();
    m.category_image = catImgM[ck] || '';
  }

  // Attach the videos linked to each manual (for the "Related videos" section
  // in the manual viewer, and to pre-check the picker in the manual editor).
  if (manuals.length) {
    const ids = manuals.map(m => m.id);
    const links = await pool.query(
      `SELECT mv.manual_id, v.id, v.title, v.category, v.file_path, v.file_type
         FROM edu_manual_videos mv
         JOIN edu_videos v ON v.id = mv.video_id
        WHERE mv.manual_id = ANY($1::int[])
        ORDER BY v.title`,
      [ids]
    );
    const byManual = {};
    for (const row of links.rows) {
      (byManual[row.manual_id] = byManual[row.manual_id] || []).push({
        id: row.id, title: row.title, category: row.category,
        file_path: row.file_path, file_type: row.file_type
      });
    }
    for (const m of manuals) {
      m.videos = byManual[m.id] || [];
      m.video_ids = m.videos.map(v => v.id);
    }
  }

  res.json({ ok: true, manuals });
});

// Get the current user's private note for a manual
app.post('/api/getManualNote', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });
  const r = await pool.query(
    'SELECT notes FROM edu_manual_notes WHERE LOWER(user_email)=LOWER($1) AND manual_id=$2',
    [user.email, req.body.manual_id]
  );
  res.json({ ok: true, notes: r.rows[0]?.notes || '' });
});

// Save (upsert) the current user's private note for a manual
app.post('/api/saveManualNote', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });
  const notes = String(req.body.notes || '');
  await pool.query(
    `INSERT INTO edu_manual_notes (user_email, manual_id, notes, updated_at)
     VALUES (LOWER($1), $2, $3, NOW())
     ON CONFLICT (user_email, manual_id) DO UPDATE SET notes=$3, updated_at=NOW()`,
    [user.email, req.body.manual_id, notes]
  );
  res.json({ ok: true });
});

// ─── Per-user manual bookmarks ──────────────────────────────────────────────
app.post('/api/getManualBookmarks', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });
  const r = await pool.query(
    `SELECT id, page, label FROM edu_manual_bookmarks
      WHERE LOWER(user_email)=LOWER($1) AND manual_id=$2
      ORDER BY page, id`,
    [user.email, req.body.manual_id]
  );
  res.json({ ok: true, bookmarks: r.rows });
});

app.post('/api/addManualBookmark', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });
  const manual_id = parseInt(req.body.manual_id, 10);
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);
  const label = String(req.body.label || '').trim().slice(0, 120);
  if (!manual_id) return res.json({ ok: false, reason: 'manual_id required' });
  const r = await pool.query(
    `INSERT INTO edu_manual_bookmarks (user_email, manual_id, page, label)
     VALUES (LOWER($1), $2, $3, $4) RETURNING id, page, label`,
    [user.email, manual_id, page, label]
  );
  res.json({ ok: true, bookmark: r.rows[0] });
});

app.post('/api/deleteManualBookmark', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });
  await pool.query(
    'DELETE FROM edu_manual_bookmarks WHERE id=$1 AND LOWER(user_email)=LOWER($2)',
    [req.body.bookmark_id, user.email]
  );
  res.json({ ok: true });
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

// ═══════════════════════════════════════════════════════════════════════════
// VIDEOS API (parallel to manuals — Drive-hosted videos)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/getVideos', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });

  const all = await pool.query(
    'SELECT * FROM edu_videos ORDER BY category, sort_order, title'
  );
  await attachCategories(all.rows, 'edu_video_categories', 'video_id');
  const videos = isAdminOrMod(user)
    ? all.rows
    : all.rows.filter(v => (v.category_names || []).some(cn => categoryVisibleTo(cn, user.teaches)));

  const favorites = await pool.query(
    'SELECT video_id FROM edu_video_favorites WHERE LOWER(user_email)=LOWER($1)',
    [user.email]
  );
  const favSet = new Set(favorites.rows.map(f => f.video_id));
  const catImg = await categoryImageMap();
  for (const v of videos) {
    v.is_favorite = favSet.has(v.id);
    v.thumbnail_url = videoThumbnailUrl(v);
    const ck = (v.category || (v.category_names && v.category_names[0]) || '').toLowerCase();
    v.category_image = catImg[ck] || '';
  }

  // Attach the manuals each video is linked to (for the "Appears in" section in
  // the video viewer, and to pre-check the picker in the video editor).
  if (videos.length) {
    const ids = videos.map(v => v.id);
    const links = await pool.query(
      `SELECT mv.video_id, m.id, m.title, m.category
         FROM edu_manual_videos mv
         JOIN edu_manuals m ON m.id = mv.manual_id
        WHERE mv.video_id = ANY($1::int[])
        ORDER BY m.title`,
      [ids]
    );
    const byVideo = {};
    for (const row of links.rows) {
      (byVideo[row.video_id] = byVideo[row.video_id] || []).push({
        id: row.id, title: row.title, category: row.category
      });
    }
    for (const v of videos) {
      v.manuals = byVideo[v.id] || [];
      v.manual_ids = v.manuals.map(m => m.id);
    }
  }

  res.json({ ok: true, videos });
});

app.post('/api/toggleVideoFavorite', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });

  const { video_id } = req.body;
  const existing = await pool.query(
    'SELECT id FROM edu_video_favorites WHERE LOWER(user_email)=LOWER($1) AND video_id=$2',
    [user.email, video_id]
  );
  if (existing.rows.length > 0) {
    await pool.query('DELETE FROM edu_video_favorites WHERE id=$1', [existing.rows[0].id]);
    res.json({ ok: true, favorited: false });
  } else {
    await pool.query(
      'INSERT INTO edu_video_favorites (user_email, video_id) VALUES (LOWER($1), $2)',
      [user.email, video_id]
    );
    res.json({ ok: true, favorited: true });
  }
});

app.post('/api/getVideoNote', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });
  const r = await pool.query(
    'SELECT notes FROM edu_video_notes WHERE LOWER(user_email)=LOWER($1) AND video_id=$2',
    [user.email, req.body.video_id]
  );
  res.json({ ok: true, notes: r.rows[0]?.notes || '' });
});

app.post('/api/saveVideoNote', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });
  const notes = String(req.body.notes || '');
  await pool.query(
    `INSERT INTO edu_video_notes (user_email, video_id, notes, updated_at)
     VALUES (LOWER($1), $2, $3, NOW())
     ON CONFLICT (user_email, video_id) DO UPDATE SET notes=$3, updated_at=NOW()`,
    [user.email, req.body.video_id, notes]
  );
  res.json({ ok: true });
});

// ─── Admin: Video CRUD ──────────────────────────────────────────────────────
app.post('/api/admin/createVideo', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  const { title, description, category, file_path, file_type } = req.body;
  const r = await pool.query(
    'INSERT INTO edu_videos (title, description, category, file_path, file_type, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [title, description || '', category || 'General', file_path, file_type || 'drive_video', user.email]
  );
  res.json({ ok: true, video: r.rows[0] });
});

// ─── Admin: upload a video file straight to Bunny Stream ────────────────────
// Receives the file to a temp path, (1) creates the video object in the Bunny
// library, (2) uploads the bytes, then removes the temp file. Returns the
// embed URL + file_type so the client can save an edu_videos row via
// /api/admin/createVideo. The API key never leaves the server.
app.post('/api/admin/uploadVideoBunny', bunnyUpload.single('file'), async (req, res) => {
  const tmpPath = req.file && req.file.path;
  try {
    const user = await getAuthorizedUser(req.body.email, req.body.pin);
    if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
    if (!bunnyConfigured()) return res.json({ ok: false, reason: 'Video hosting is not configured — set BUNNY_STREAM_LIBRARY_ID and BUNNY_STREAM_API_KEY.' });
    if (!req.file) return res.json({ ok: false, reason: 'No file uploaded' });

    const title = String(req.body.title || req.file.originalname || 'Untitled').slice(0, 200);

    // 1) Create the video object.
    const createResp = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIB}/videos`, {
      method: 'POST',
      headers: { AccessKey: BUNNY_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ title })
    });
    if (!createResp.ok) {
      const t = await createResp.text().catch(() => '');
      console.error('Bunny create failed:', createResp.status, t);
      return res.json({ ok: false, reason: `Bunny rejected the create (${createResp.status}). Check the Library ID and API key.` });
    }
    const guid = (await createResp.json()).guid;
    if (!guid) return res.json({ ok: false, reason: 'Bunny did not return a video id' });

    // 2) Upload the bytes.
    const bytes = fs.readFileSync(tmpPath);
    const putResp = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIB}/videos/${guid}`, {
      method: 'PUT',
      headers: { AccessKey: BUNNY_KEY, 'Content-Type': 'application/octet-stream' },
      body: bytes
    });
    if (!putResp.ok) {
      const t = await putResp.text().catch(() => '');
      console.error('Bunny upload failed:', putResp.status, t);
      // Roll back the empty video object we just created.
      await maybeDeleteFromBunny({ file_type: 'bunny_video', file_path: bunnyEmbedUrl(guid) });
      return res.json({ ok: false, reason: `Bunny upload failed (${putResp.status})` });
    }

    res.json({ ok: true, guid, file_path: bunnyEmbedUrl(guid), file_type: 'bunny_video' });
  } catch (e) {
    console.error('uploadVideoBunny error:', e);
    res.json({ ok: false, reason: 'Upload failed: ' + (e.message || 'unknown error') });
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
  }
});

app.post('/api/admin/updateVideo', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  const { video_id, title, description, category } = req.body;
  await pool.query(
    'UPDATE edu_videos SET title=COALESCE($1,title), description=COALESCE($2,description), category=COALESCE($3,category) WHERE id=$4',
    [title, description, category, video_id]
  );
  res.json({ ok: true });
});

app.post('/api/admin/deleteVideo', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  // Look up the source before deleting so we can also remove Bunny-hosted files.
  const row = await pool.query('SELECT file_path, file_type FROM edu_videos WHERE id=$1', [req.body.video_id]);
  await pool.query('DELETE FROM edu_videos WHERE id=$1', [req.body.video_id]);
  if (row.rows[0]) await maybeDeleteFromBunny(row.rows[0]);
  res.json({ ok: true });
});

// Delete every video at once. Cascades clean up favorites, notes and
// manual-video links. Guarded by a confirm token from the client.
app.post('/api/admin/deleteAllVideos', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  if (req.body.confirm !== 'DELETE_ALL') return res.json({ ok: false, reason: 'Confirmation required' });
  const r = await pool.query('DELETE FROM edu_videos');
  res.json({ ok: true, deleted: r.rowCount });
});

// ─── Admin: Manual ↔ Video links ────────────────────────────────────────────
// Replace the full set of manuals a video is attached to.
app.post('/api/admin/setVideoManuals', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  const videoId = parseInt(req.body.video_id, 10);
  if (!videoId) return res.json({ ok: false, reason: 'video_id required' });
  const manualIds = Array.isArray(req.body.manual_ids)
    ? req.body.manual_ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM edu_manual_videos WHERE video_id=$1', [videoId]);
    for (const mId of manualIds) {
      await client.query(
        `INSERT INTO edu_manual_videos (manual_id, video_id) VALUES ($1, $2)
         ON CONFLICT (manual_id, video_id) DO NOTHING`,
        [mId, videoId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, manual_ids: manualIds });
  } catch (e) {
    await client.query('ROLLBACK');
    res.json({ ok: false, reason: e.message });
  } finally {
    client.release();
  }
});

// Replace the full set of videos attached to a manual.
app.post('/api/admin/setManualVideos', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  const manualId = parseInt(req.body.manual_id, 10);
  if (!manualId) return res.json({ ok: false, reason: 'manual_id required' });
  const videoIds = Array.isArray(req.body.video_ids)
    ? req.body.video_ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM edu_manual_videos WHERE manual_id=$1', [manualId]);
    for (const vId of videoIds) {
      await client.query(
        `INSERT INTO edu_manual_videos (manual_id, video_id) VALUES ($1, $2)
         ON CONFLICT (manual_id, video_id) DO NOTHING`,
        [manualId, vId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, video_ids: videoIds });
  } catch (e) {
    await client.query('ROLLBACK');
    res.json({ ok: false, reason: e.message });
  } finally {
    client.release();
  }
});

// Replace the full set of categories on a manual or video. `kind` picks the
// table. Also syncs the item's legacy text `category` to the first selected
// name so any code still reading that column stays sensible.
async function setItemCategories(res, kind, itemId, categoryIds) {
  const cfg = kind === 'video'
    ? { join: 'edu_video_categories', fk: 'video_id', table: 'edu_videos' }
    : { join: 'edu_manual_categories', fk: 'manual_id', table: 'edu_manuals' };
  const ids = Array.isArray(categoryIds) ? categoryIds.map(n => parseInt(n, 10)).filter(Boolean) : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${cfg.join} WHERE ${cfg.fk}=$1`, [itemId]);
    for (const cid of ids) {
      await client.query(
        `INSERT INTO ${cfg.join} (${cfg.fk}, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [itemId, cid]
      );
    }
    let name = '';
    if (ids.length) {
      const nr = await client.query('SELECT name FROM edu_categories WHERE id=$1', [ids[0]]);
      name = nr.rows[0] ? nr.rows[0].name : '';
    }
    await client.query(`UPDATE ${cfg.table} SET category=$1 WHERE id=$2`, [name, itemId]);
    await client.query('COMMIT');
    res.json({ ok: true, category_ids: ids });
  } catch (e) {
    await client.query('ROLLBACK');
    res.json({ ok: false, reason: e.message });
  } finally {
    client.release();
  }
}

app.post('/api/admin/setManualCategories', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  const manualId = parseInt(req.body.manual_id, 10);
  if (!manualId) return res.json({ ok: false, reason: 'manual_id required' });
  await setItemCategories(res, 'manual', manualId, req.body.category_ids);
});

app.post('/api/admin/setVideoCategories', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  const videoId = parseInt(req.body.video_id, 10);
  if (!videoId) return res.json({ ok: false, reason: 'video_id required' });
  await setItemCategories(res, 'video', videoId, req.body.category_ids);
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORIES API
// ═══════════════════════════════════════════════════════════════════════════
// List categories for a given surface ('manual', 'video'). 'both' always matches.
app.post('/api/getCategories', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!user) return res.json({ ok: false, reason: 'Unauthorized' });
  const surface = req.body.for === 'video' ? 'video' : 'manual';
  const r = await pool.query(
    `SELECT id, name, applies_to, image_url FROM edu_categories
     WHERE applies_to = 'both' OR applies_to = $1
     ORDER BY sort_order, name`,
    [surface]
  );
  res.json({ ok: true, categories: r.rows });
});

// Full category catalog (both surfaces) with how many manuals/videos use each
// name — for the admin Categories manager.
app.post('/api/admin/getAllCategories', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  // Count items tagged via the join table PLUS any that still rely on the text
  // fallback (no join rows). Counting only the text column would miss every
  // secondary category of a multi-category item.
  const r = await pool.query(
    `SELECT c.id, c.name, c.applies_to, c.image_url,
            (SELECT COUNT(*) FROM edu_manual_categories mc WHERE mc.category_id = c.id)
            + (SELECT COUNT(*) FROM edu_manuals m WHERE m.category = c.name
                 AND NOT EXISTS (SELECT 1 FROM edu_manual_categories mc2 WHERE mc2.manual_id = m.id)) AS manual_count,
            (SELECT COUNT(*) FROM edu_video_categories vc WHERE vc.category_id = c.id)
            + (SELECT COUNT(*) FROM edu_videos v WHERE v.category = c.name
                 AND NOT EXISTS (SELECT 1 FROM edu_video_categories vc2 WHERE vc2.video_id = v.id)) AS video_count
       FROM edu_categories c
      ORDER BY c.sort_order, c.name`
  );
  res.json({ ok: true, categories: r.rows });
});

app.post('/api/admin/createCategory', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.json({ ok: false, reason: 'Name required' });
  const applies_to = ['manual', 'video', 'both'].includes(req.body.applies_to)
    ? req.body.applies_to : 'both';
  try {
    const r = await pool.query(
      `INSERT INTO edu_categories (name, applies_to) VALUES ($1, $2) RETURNING *`,
      [name, applies_to]
    );
    res.json({ ok: true, category: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      // Duplicate name. Return the existing row, but first broaden its
      // applies_to so it becomes visible in the surface it's being (re)created
      // from — otherwise a video-only category can't be picked from the manual
      // editor and vice versa.
      const ex = await pool.query('SELECT * FROM edu_categories WHERE name=$1', [name]);
      let row = ex.rows[0];
      if (row && applies_to !== row.applies_to && row.applies_to !== 'both') {
        const upd = await pool.query(
          `UPDATE edu_categories SET applies_to='both' WHERE id=$1 RETURNING *`, [row.id]
        );
        row = upd.rows[0];
      }
      res.json({ ok: true, category: row, existed: true });
    } else {
      res.json({ ok: false, reason: e.message });
    }
  }
});

// Rename a category and/or change which surfaces it applies to. Renaming also
// retags any manuals/videos using the old name so nothing is orphaned.
app.post('/api/admin/updateCategory', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  const id = parseInt(req.body.category_id, 10);
  const name = String(req.body.name || '').trim();
  if (!id || !name) return res.json({ ok: false, reason: 'Name required' });
  const applies_to = ['manual', 'video', 'both'].includes(req.body.applies_to)
    ? req.body.applies_to : 'both';
  const cur = await pool.query('SELECT name FROM edu_categories WHERE id=$1', [id]);
  if (!cur.rows.length) return res.json({ ok: false, reason: 'Category not found' });
  const oldName = cur.rows[0].name;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE edu_categories SET name=$1, applies_to=$2 WHERE id=$3', [name, applies_to, id]);
    if (oldName !== name) {
      await client.query('UPDATE edu_manuals SET category=$1 WHERE category=$2', [name, oldName]);
      await client.query('UPDATE edu_videos SET category=$1 WHERE category=$2', [name, oldName]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.json({ ok: false, reason: 'A category with that name already exists' });
    res.json({ ok: false, reason: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/admin/deleteCategory', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  await pool.query('DELETE FROM edu_categories WHERE id=$1', [req.body.category_id]);
  res.json({ ok: true });
});

// ─── Admin: category cover image (Bunny Storage) ────────────────────────────
app.post('/api/admin/uploadCategoryImage', bunnyUpload.single('file'), async (req, res) => {
  const tmpPath = req.file && req.file.path;
  try {
    const user = await getAuthorizedUser(req.body.email, req.body.pin);
    if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
    if (!bunnyStorageConfigured()) return res.json({ ok: false, reason: 'File hosting is not configured — set BUNNY_STORAGE_*.' });
    if (!req.file) return res.json({ ok: false, reason: 'No file uploaded' });
    const id = parseInt(req.body.category_id, 10);
    if (!id) return res.json({ ok: false, reason: 'Missing category' });
    const ext = (path.extname(req.file.originalname) || '.jpg').toLowerCase();
    const url = await bunnyStoragePut(`categories/${uuidv4()}${ext}`, fs.readFileSync(tmpPath));
    const old = await pool.query('SELECT image_url FROM edu_categories WHERE id=$1', [id]);
    await pool.query('UPDATE edu_categories SET image_url=$1 WHERE id=$2', [url, id]);
    if (old.rows[0] && old.rows[0].image_url) await maybeDeleteFromBunnyStorage(old.rows[0].image_url);
    res.json({ ok: true, image_url: url });
  } catch (e) {
    console.error('uploadCategoryImage error:', e);
    res.json({ ok: false, reason: 'Upload failed: ' + (e.message || 'unknown error') });
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
  }
});

app.post('/api/admin/clearCategoryImage', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  const id = parseInt(req.body.category_id, 10);
  if (!id) return res.json({ ok: false, reason: 'Missing category' });
  const old = await pool.query('SELECT image_url FROM edu_categories WHERE id=$1', [id]);
  await pool.query(`UPDATE edu_categories SET image_url='' WHERE id=$1`, [id]);
  if (old.rows[0] && old.rows[0].image_url) await maybeDeleteFromBunnyStorage(old.rows[0].image_url);
  res.json({ ok: true });
});

// Map of lower(category name) → cover image URL, for tagging videos/manuals.
async function categoryImageMap() {
  const r = await pool.query(`SELECT name, image_url FROM edu_categories WHERE image_url <> ''`);
  const m = {};
  r.rows.forEach(c => { m[(c.name || '').toLowerCase()] = c.image_url; });
  return m;
}

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
    const fp = manual.rows[0].file_path || '';
    if (!/^https?:\/\//i.test(fp)) {
      // Legacy local file.
      const fullPath = path.join(__dirname, 'public', fp);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    } else {
      // Bunny-hosted PDF (no-op for Google Drive / other URLs).
      await maybeDeleteFromBunnyStorage(fp);
    }
  }
  await pool.query('DELETE FROM edu_manuals WHERE id=$1', [req.body.manual_id]);
  res.json({ ok: true });
});

// ─── Admin: One-shot bulk import from Google Drive ──────────────────────────
// Idempotent — skips manuals whose file_path already exists.
// To add more PDFs later: append to DRIVE_MANUALS_IMPORT and POST this endpoint.
const DRIVE_MANUALS_IMPORT = [
  // Pole
  { title: 'Pole 101 2022 Manual',         category: 'Pole',        drive_id: '12JmK6Z2ULK_hRO3NdJLUNBgVqQAxS8MT', sort_order: 1 },
  { title: 'Beginner Manual 2022',         category: 'Pole',        drive_id: '1rBxZc0P5Pl4vphbNpf041kmfwLrx6-pY', sort_order: 2 },
  { title: 'Intermediate 2022',            category: 'Pole',        drive_id: '11q0Cmo59qgs3VzInuxq5-KNxx5sn3SiH', sort_order: 3 },
  { title: 'Advanced 1 and 2',             category: 'Pole',        drive_id: '1XIqCtGgN-A0inU0uehvspg1CaoQ3mU6J', sort_order: 4 },
  { title: 'Pole Party Manual',            category: 'Pole',        drive_id: '1lUO1aZ3-OnhyjbIDFtTDXsEhpLwGeBGP', sort_order: 5 },
  // Aerial Hoop
  { title: 'Aerial Hoop Manual Level 1+2', category: 'Aerial Hoop', drive_id: '1V1ifhqQSDIsd_SZ7uGPpWrPP_JMcn_Hb', sort_order: 1 },
  { title: 'Aerial Hoop Manual Level 3+4', category: 'Aerial Hoop', drive_id: '15TJFBj_RAsQHueWrBYe5NOkUbYUH3V9e', sort_order: 2 },
  { title: 'Aerial Hoop Manual Level 5',   category: 'Aerial Hoop', drive_id: '1SFJUIwEOxjDHDF9F2DeeonApjZmTSXM1', sort_order: 3 },
  // Routines
  { title: 'Aradia Chair Routine',         category: 'Routines',    drive_id: '1jg2pm7CPrU_tDX7UnjMeHn59wwxz9NDh', sort_order: 1 },
];

// ─── Admin: One-shot bulk import of videos from Drive ──────────────────────
// Categories chosen for substring matching against users.teaches:
//   "pole" matches everything starting with "Pole "
//   "aerial hoop" matches "Aerial Hoop Level N"
//   "parties" matches "Parties"
//   "Routines" is universal (visible to all)
const DRIVE_VIDEOS_IMPORT = [
  // Aerial Hoop Level 1
  { drive_id: '1DHEL-VqYqx_1Lx1OS411Hm6-kviWTXFY', title: 'Angel to Bathtub',                category: 'Aerial Hoop Level 1' },
  { drive_id: '1Cyd0s-hQKW-5bTszgY5HPXid9W6z9EBN', title: 'Front Balance Roll to Delilah',  category: 'Aerial Hoop Level 1' },
  { drive_id: '1CjyrUmYHYOG6QLcPL5DyHsg6kOn3fiRU', title: 'Flip Mount',                      category: 'Aerial Hoop Level 1' },
  { drive_id: '1CV9irIpf51IdydzUZwJBdYetzpRfsvdj', title: 'Helicopter Mount',                category: 'Aerial Hoop Level 1' },
  { drive_id: '1BhRUCB1hBG1vIRkBadmgSy07IOjJNrHq', title: 'Delilah Mount',                   category: 'Aerial Hoop Level 1' },
  { drive_id: '1B7qH-hFKrfZrHSPOIN6-xYjicIum2OFM', title: 'Pike Mount',                      category: 'Aerial Hoop Level 1' },
  { drive_id: '1dhbZ_r5Ybjri77Mcl08xs6stowL37mVl', title: 'Side Mount',                      category: 'Aerial Hoop Level 1' },
  { drive_id: '1DdsiFiJTc25zMDc4v5mwiod64OGLdXh3', title: 'Side Mount, Double Leg Variation',category: 'Aerial Hoop Level 1' },

  // Aerial Hoop Level 2
  { drive_id: '1EjMHgSSrSyW1cHovNsrehyuVK2LXF64A', title: 'Inverted Straddle, Walkout Entry',category: 'Aerial Hoop Level 2' },
  { drive_id: '1EzPp4hg5ArrTqIWUfrV8gahz4vq5KGAw', title: 'Beats to Sit',                    category: 'Aerial Hoop Level 2' },
  { drive_id: '1EdsfqYmc0Hrvk4A7iqBviHOY7abnXAHv', title: 'Front Balance to Coffin to Sit',  category: 'Aerial Hoop Level 2' },
  { drive_id: '1FrwDvrv58X07oVC-BRXdD2tQdi9VFC7T', title: 'Combo: Star, Secretary, Horse, Monkey Roll, Martini', category: 'Aerial Hoop Level 2' },
  { drive_id: '1EZcuafCnBvn-xMWzbtUz3XD5rcFTARpr', title: 'Monkey Roll',                     category: 'Aerial Hoop Level 2' },

  // Aerial Hoop Level 3
  { drive_id: '1IZG54F1v0DiBF4wUP5V02xcRtgvuF7hM', title: 'Flip Mount to Helicopter Transition', category: 'Aerial Hoop Level 3' },
  { drive_id: '1I9_ayqdxEh1wKDrG8z6UWJbgfs1vsAQ4', title: 'Hocks Slide',                     category: 'Aerial Hoop Level 3' },

  // Pole 101
  { drive_id: '16rg2rm-lbZzYv0z5JW81OPL288OBZME-', title: 'Side Lat Stretch',                category: 'Pole 101' },
  { drive_id: '1MK_otKWrFd16kB7IPwrfqrNPN1lSMPg8', title: 'Body Walkdown',                   category: 'Pole 101' },
  { drive_id: '1_wnD9FiuZJ69uJrktgmjWIyWYHU3hN8b', title: 'Kick Forward Kick Back',          category: 'Pole 101' },
  { drive_id: '1_8nbDmeQehOWYCJqJJ6I7YrFGqLNjQqy', title: 'Cool Down Example 3',             category: 'Pole 101' },
  { drive_id: '1rfxU7C_st2fRjd99MCT_G76MDGrYBmWq', title: 'Cat Push Ups',                    category: 'Pole 101' },
  { drive_id: '1wnW_PCg_KxUNy-bW74i4d1Um9qlRU9Kz', title: 'Tuck to Peel Get Up',             category: 'Pole 101' },
  { drive_id: '1uHO7kl2Nedb6JagerxJ2GeX_JvYyHKEd', title: 'Aradia Push Ups',                 category: 'Pole 101' },
  { drive_id: '1UXH6ulyttyqf_Tio6uZK7WDJ_TYRYIsb', title: 'Cat Spirals',                     category: 'Pole 101' },
  { drive_id: '1_k-Zy-XZUzG7kE-9kow8hvrjFr7EdH1a', title: 'Sensual Get Up',                  category: 'Pole 101' },
  { drive_id: '1z0ZjkcQmvIL57bwxb8Qg0yEp80Cgj0KX', title: 'Cupid Crunches',                  category: 'Pole 101' },
  { drive_id: '1XU0aQ33V8_6dAa0IUiyUXyIoDVuCmfSx', title: 'Pole Ups',                        category: 'Pole 101' },
  { drive_id: '1MJH2o3Cx7nSKCPvSutXEWhfbuis0LFQ2', title: 'Clocks 2',                        category: 'Pole 101' },
  { drive_id: '17f5JcJcv3H6srYHhBI81RTNSKmygqtET', title: 'Peek A Boos',                     category: 'Pole 101' },
  { drive_id: '19xpQJfdbhaCyuuigIDZ2d7lxsgBMpPD4', title: 'Clocks',                          category: 'Pole 101' },
  { drive_id: '1Ba9HN8_OfxsYSnOpuBe546_6uRuF-Fqb', title: 'Rocking Cats',                    category: 'Pole 101' },
  { drive_id: '1_kyYirJk2MIMbp7Vo6VrPtpx20kMJBIR', title: 'Basic Get Down',                  category: 'Pole 101' },
  { drive_id: '175DE2bTkBWPw6rwWBcHx-8W46lx9LWHS', title: 'Front Hook Spin',                 category: 'Pole 101' },
  { drive_id: '17ALehc-LLAjbeGuGKI9S62iBXgrhHqWR', title: 'L Turn',                          category: 'Pole 101' },
  { drive_id: '17A2RJ6lk9rGVdNmaRTrHJ-9BUnJOZiJF', title: 'Side to Side',                    category: 'Pole 101' },
  { drive_id: '1wecVJqBS4VTbShkRP1LjlKIW__6uYsYw', title: 'Cat Get Down',                    category: 'Pole 101' },
  { drive_id: '17aKVY_vmA3qTom6WFUi5PM7oid4SMxFa', title: 'Pole Slide',                      category: 'Pole 101' },
  { drive_id: '15ulnaFuTsYSWwic1pYIvq5VNj2vq_FrN', title: 'Front Hook',                      category: 'Pole 101' },
  { drive_id: '17N2qDcKBMCl_1d_n_7PGdXG9500wfBE_', title: 'Pole Overs and Dancers Kick',     category: 'Pole 101' },
  { drive_id: '17np2fAU9Xvf2F3oi3GTfs907zRBu4pDi', title: 'Chair Spin',                      category: 'Pole 101' },
  { drive_id: '17KxEXKVYiXXf61f3IiKH82Lqxng0uQJV', title: 'Pole Turns',                      category: 'Pole 101' },
  { drive_id: '17Zov0gU42-3P5f0A71nH2xlhfHydYiVI', title: 'Big Dip',                         category: 'Pole 101' },
  { drive_id: '1wLDk2jkkKZxKrQ1fEK0tO_fZbEoYR-Hw', title: 'Ballerina Spin',                  category: 'Pole 101' },
  { drive_id: '176Hbb47InR-0z6dSj3VjAsSCjzswOS4e', title: 'Firefighter Spin',                category: 'Pole 101' },
  { drive_id: '176s0lQcrW1hjCi7JTtk2m6P8do0aqF34', title: 'Backwards Spin',                  category: 'Pole 101' },
  { drive_id: '179x1gx0H1aIwwXZetAPVDwJfN9uBSdnQ', title: 'Fan Kick',                        category: 'Pole 101' },
  { drive_id: '17qLRWqijRSeZvTyolBrc5PED0Hhlqs-7', title: 'Pole 101 Routine',                category: 'Pole 101' },
  { drive_id: '1T8HMQwybWAIHT6qnOzKY6ujfKQT75drg', title: 'Pole 101 Routine (v2)',           category: 'Pole 101' },

  // Pole Beginner
  { drive_id: '18hkg4DTuJ4gWtimOikxSthCyQ7E4nE0K', title: 'Sunwheel Spin',                   category: 'Pole Beginner' },
  { drive_id: '18mh1qn7fmieQtGtYys_fKaL8g30UyD0R', title: 'Backwards Sunwheel Spin',         category: 'Pole Beginner' },
  { drive_id: '18HUGsdDE51BybS0_5efHRXwPy22XEGyS', title: 'Firefighter Martini Spin',        category: 'Pole Beginner' },
  { drive_id: '17xVoJl5FFx6DdbV4YHiWxJf-TD5k4gwz', title: 'Crossed Legged Chair Spin',       category: 'Pole Beginner' },
  { drive_id: '19UM8fOAZfG02Rxeb_aOL52AbjtPw-HNU', title: 'Advanced PoleOver Spin',          category: 'Pole Beginner' },
  { drive_id: '18Ur4Ve52WP4OzU8rBMZ-zAY8v-Z7q-jT', title: 'Switcharoo Spin',                 category: 'Pole Beginner' },
  { drive_id: '1AnmHFxG2QIL2MI2iTv8HPTih4zgLH9fk', title: 'Cool Down Level 3 Example',       category: 'Pole Beginner' },
  { drive_id: '181XEt1LcJj8pFZqOQcWzBS26QNk8khep', title: 'One Handed Firefighter Spin',     category: 'Pole Beginner' },
  { drive_id: '1nWeY7E_i_HDlXY1Ej7aKAsJ62x0tR74T', title: 'Cartwheel Get Up',                category: 'Pole Beginner' },
  { drive_id: '19ct391NiW2d0FUT8d0n9Z-OsKBZLhfrb', title: 'Basic Inversion',                 category: 'Pole Beginner' },
  { drive_id: '19B8frdgFnNtjxwFU0I4GLVO7wQJwdtUC', title: 'Corkscrew Spin',                  category: 'Pole Beginner' },
  { drive_id: '18mI8yhXMdWDJ6eM82dA0l4Xr6aten7n3', title: 'Mermaid Spin',                    category: 'Pole Beginner' },
  { drive_id: '19Y91imwLMrgHeB4QzVO6LyIdLZYAVx9N', title: 'Boomerang (PNE) Spin',            category: 'Pole Beginner' },
  { drive_id: '1u0EKQ41Q3tSWtuYYCnKoKQNLbPYhXtgt', title: 'Assisted Pole Ups',               category: 'Pole Beginner' },
  { drive_id: '1PcErzP2CyH54IbS44iD1gQrjcrb7B4XA', title: 'Backwards Shoulder Roll',         category: 'Pole Beginner' },
  { drive_id: '187dyBdk1Ilh3t9SupsnD-ZS_m7N8z2lZ', title: 'Passe Chair Spin',                category: 'Pole Beginner' },
  { drive_id: '18OqCCF69JFfw7QFyoA9Rfuy3C4fwwUjH', title: 'Pole Over Spin',                  category: 'Pole Beginner' },
  { drive_id: '17rvnFai1XXn2OHcSSZRgNnShM84Nzs4Q', title: 'Firefighter Attitude Spin',       category: 'Pole Beginner' },
  { drive_id: '17yBSB_qYpV-uT02L7eFV7gUnUmFEsJSY', title: 'Cross Legged Pole Sit',           category: 'Pole Beginner' },
  { drive_id: '1FpXe7jaXZRRF4mYrwD_DPfJpQ69AcqVR', title: 'Forearm Stretches',               category: 'Pole Beginner' },
  { drive_id: '1w2n_TGE1d_oUEfTe4VS_vZyW0kR4UnOV', title: 'Climb Preps on the Floor',        category: 'Pole Beginner' },
  { drive_id: '1DUgga4XIGcEL0GF8-CKOeLFkE6T72utx', title: 'Mini Firefighter Get Up',         category: 'Pole Beginner' },
  { drive_id: '1J3oaav2iU2nG8-W0irDof_vJVgq6lycr', title: 'Lunge Sweep Get Up',              category: 'Pole Beginner' },
  { drive_id: '1VuiqaZuxuDdzU_NJt12KFDpaFE8ndmye', title: 'Split Grip Get Up',               category: 'Pole Beginner' },
  { drive_id: '1ostMbyPnppbg78S65H6kTzjTVFmUALYA', title: 'Baseball Climb',                  category: 'Pole Beginner' },
  { drive_id: '13qW2Y813PgQRnrTNwmU67C4BgvwQPf-v', title: 'Step Up Climb Prep',              category: 'Pole Beginner' },
  { drive_id: '1DbgiD-9WMw1UYHPpsPMCR9sZyvYMzcNo', title: 'Inversion from the Floor',        category: 'Pole Beginner' },
  { drive_id: '1nfbljWotpMQJjYiqyGnn562M73NuY9iw', title: 'Floor Fankicks',                  category: 'Pole Beginner' },
  { drive_id: '1r-qx0_tuXhzBadCT1wpJjiFv6WeQiGUh', title: 'Cupid Crunches',                  category: 'Pole Beginner' },
  { drive_id: '19KbQIn_AHJ8Y4vNyVslYbiBZ5mG52t2F', title: 'V/Diamond/Side Strength Hold',    category: 'Pole Beginner' },
  { drive_id: '18DvXQh-GJwxl2ZIEP9pGx65k4TACQoz2', title: 'Straight Legged Pole Sit',        category: 'Pole Beginner' },
  { drive_id: '196Rr-Yl5ILbwbQZN9YWXlLq4YNzH2tRb', title: 'Straight Legged Firefighter',     category: 'Pole Beginner' },
  { drive_id: '19-K2d7p-fNijHd74FqeCyaXpsPjOEci5', title: 'Straight Legged Ballerina',       category: 'Pole Beginner' },
  { drive_id: '18flRRziyTq2-w3XL6Q83SgM2i_vuW0BK', title: 'Diamond Spin',                    category: 'Pole Beginner' },
  { drive_id: '184gFXfMfls483G6CGYjVmLRudMTPmxCx', title: 'Big Dip into Backwards Spin',     category: 'Pole Beginner' },
  { drive_id: '19_qsb2cLRQmxspte7SOD-ijvL7WI2Hp9', title: 'Pole Faint',                      category: 'Pole Beginner' },

  // Pole Intermediate
  { drive_id: '1N77NjuOBluWu1lCK9U3KjFhq-9EFWvOP', title: 'Extended Butterfly',              category: 'Pole Intermediate' },
  { drive_id: '1MKIwr1qp-jBDPQ0dhescIygjdClT0LCf', title: 'Invert to Snake Out',             category: 'Pole Intermediate' },
  { drive_id: '1Mqzn6bqHm3AtSN5TO1JeKfxIkTiPi04j', title: 'Jasmine/Jagged Edge from the Floor', category: 'Pole Intermediate' },
  { drive_id: '1MiearQFF6xjVhO1wmzraNxjjSj627WB4', title: 'Helicopter Inversion',            category: 'Pole Intermediate' },
  { drive_id: '1NGS1lKgUGaRVURDi74GETULkQ3bgK0H2', title: 'Jasmine/Jagged Edge',             category: 'Pole Intermediate' },
  { drive_id: '1NnnBUNFP9yrFGOifkg-2JDLTvtpS0tmg', title: 'Butterfly to Bow and Arrow',      category: 'Pole Intermediate' },
  { drive_id: '1MNaeRPBxOM6g7-UXwesUgsS7N9fVFUPK', title: 'Spiral Spin',                     category: 'Pole Intermediate' },
  { drive_id: '1MyTRIU_FLh7ZPxUk6s0bZSv-9d-pd41s', title: 'Twister Spin',                    category: 'Pole Intermediate' },
  { drive_id: '1MJmxWLlR-1ST9Ob3qIjLBN72naqXSTDW', title: 'Inverted Crucifix',               category: 'Pole Intermediate' },
  { drive_id: '1M_KCYROv3A5YwT-MZAhEQFWwWQL2c1GN', title: 'Invert to Handstand Variations',  category: 'Pole Intermediate' },
  { drive_id: '1M1OZLxT6G3mae15sLV3XQ21qGbywHRCA', title: 'Chimney Sweep Spin',              category: 'Pole Intermediate' },
  { drive_id: '1MehXid_hAFiRwqe7_s6SD6BhmthgTMA_', title: 'Invert to Exit with Superman Legs',category: 'Pole Intermediate' },
  { drive_id: '1N8y118B4SMpy4Wwho11vYp8ELcWjuPtv', title: 'Jamilla',                         category: 'Pole Intermediate' },
  { drive_id: '1MdG8QH7WUi6EUrndeHkEErN1O4UbER7w', title: 'Butterfly',                       category: 'Pole Intermediate' },
  { drive_id: '1NIpx2fH7a3bax-Bk-Tg5Dk9q9wfndkvI', title: 'Descending Angel',                category: 'Pole Intermediate' },
  { drive_id: '1NB7CRSMdEZjDK9m_X7-U05jlJPXpf3SL', title: 'Outside Leg Hook',                category: 'Pole Intermediate' },
  { drive_id: '1M4COqcWor1Bc8RpL9lxgpWYzRsCqh-Yr', title: 'Fan Kick to Sit/Climb',           category: 'Pole Intermediate' },
  { drive_id: '1MW5SiF3fpszFZbLHi6wfNTOCJhfbWv-m', title: 'Juliette Spin',                   category: 'Pole Intermediate' },
  { drive_id: '1NYDLeIZt9cYymzz_vTQUNne9fJoBfoyF', title: 'Hawaii Spin',                     category: 'Pole Intermediate' },
  { drive_id: '1NTipTMbTMZsQ_NH7gZUqWkbBEa4vzLhd', title: 'Teddy',                           category: 'Pole Intermediate' },
  { drive_id: '1Mc2-yTycDAdNoBacft1sBlkxrB7KicLA', title: 'Wrist Seat and Wrist Seat Variation', category: 'Pole Intermediate' },
  { drive_id: '1NiS2tu0VJro-MqTW-uVBnxF3afOREL-8', title: 'Stargazer',                       category: 'Pole Intermediate' },
  { drive_id: '1NMl5yKWBgGjD-26UJ0lyWF2GinHZBFeQ', title: 'Spinning Helicopter',             category: 'Pole Intermediate' },
  { drive_id: '1NI1NFSvnG-GzHsxEODnBRn-ZdSi7pVEZ', title: 'Reiko',                           category: 'Pole Intermediate' },
  { drive_id: '1NN8dObdARyovVPq2oR79iF685FWIJsv0', title: 'Martini Sit',                     category: 'Pole Intermediate' },
  { drive_id: '1Mrza-YCQjj7PxpzzZSTXO6r57pMfI-cl', title: 'Swan Sit',                        category: 'Pole Intermediate' },
  { drive_id: '1M5qwz1xCvhO_bB_VXY9Q5IprH1pLQOc4', title: 'Side Climb',                      category: 'Pole Intermediate' },
  { drive_id: '1NKQAAIGw0QTCUMsT3_sqYtYnW6KMZlmA', title: 'Hood Ornament',                   category: 'Pole Intermediate' },
  { drive_id: '1MRjSJ4NjWW7oEQl2zylVeqWFB2A5203P', title: 'Bow and Arrow',                   category: 'Pole Intermediate' },
  { drive_id: '1MJF89y8Z4BheZIFk1rtRvaGDXQ5XcZLk', title: 'Pole Sit Layout',                 category: 'Pole Intermediate' },

  // Pole Advanced 1
  { drive_id: '1Sm40rc1MWXHZ31Hysxt6PGgDd0boJTx0', title: 'Superman from Jasmine/Jagged Edge', category: 'Pole Advanced 1' },
  { drive_id: '1RJCijZpcmZQSFS4Wg9oatIlBVOV7NUGw', title: 'Butterfly into Side Splits',      category: 'Pole Advanced 1' },
  { drive_id: '1RWOTFk-pqJTFF3wJC6AS7t1v9BIil12-', title: 'Bow and Arrow to Butterfly',      category: 'Pole Advanced 1' },
  { drive_id: '1Rww4rymbrA_5hh66X4N5Xx26j1sj2ZJl', title: 'Croissant',                       category: 'Pole Advanced 1' },
  { drive_id: '1S4KqgSDd4Enx9bj66o77WulsV-ET9R8H', title: 'Swing into Jasmine/Jagged Edge',  category: 'Pole Advanced 1' },
  { drive_id: '1SQ8g1z130Q6VxvgleZtW4ufJivyp5fAs', title: 'Inverted D to Split Grip Ayesha', category: 'Pole Advanced 1' },
  { drive_id: '1RWH1mpdk8oBUq9e4hJnQ6lxK3ZZiDO3f', title: 'Hip Hold/Pike',                   category: 'Pole Advanced 1' },
  { drive_id: '1RKTkEs6A5HSYQnB8u_dDrFKiB__zEiBi', title: 'Butterfly to Inverted Splits',    category: 'Pole Advanced 1' },
  { drive_id: '1SAnYV98SyKHgkKmude-_wLuhora5simf', title: 'Butterfly to Croissant to Brass Monkey', category: 'Pole Advanced 1' },
  { drive_id: '1SSC47W0uXRdy2rfIhSt9Z9WQUwNLEe92', title: "Bird's Nest (old)",                category: 'Pole Advanced 1' },
  { drive_id: '1SHL0brffzVeMTuNnTcJK2FbR7mPpOlF6', title: 'Inverted D',                      category: 'Pole Advanced 1' },
  { drive_id: '1RchDPuWN4xRRgsO75IodSqn_m0x2WjxV', title: 'Remi Sit',                        category: 'Pole Advanced 1' },
  { drive_id: '1SaIMGxDpl1e6YJY-bI-tRHGejELsPMVp', title: 'Shoulder Mount',                  category: 'Pole Advanced 1' },
  { drive_id: '1SBL-UFtNgx80V8EreCY742U5tUHMfini', title: 'Ball Drop',                       category: 'Pole Advanced 1' },
  { drive_id: '1SjeaDYOGtMFV-zW_Ef5TFSmGH_URwbUQ', title: 'Superman from the Floor',         category: 'Pole Advanced 1' },
  { drive_id: '1Rvzk400eWq9x6e-4glgb1SsY_m44AJmB', title: 'Sleeping Beauty/Cross Ankle Layback', category: 'Pole Advanced 1' },
  { drive_id: '1Req9QhLxok1j9SVPy71Dh3OpF6cc_xTi', title: 'Outside Leg Hang',                category: 'Pole Advanced 1' },
  { drive_id: '1SUnrbuk3WQPcv-F0EABFjDbV-hoCzlA6', title: 'Genie',                           category: 'Pole Advanced 1' },
  { drive_id: '1Sc9gdStZKTP8NrqsOs3eNjyqFZbLvwbY', title: 'Flatline Scorpio',                category: 'Pole Advanced 1' },
  { drive_id: '1RwjEnnigdTsyJAcHNemxDkRZNFsIx_QI', title: 'Aerial Inversion',                category: 'Pole Advanced 1' },
  { drive_id: '1SI5_4wqJFID2cEknDzu3JFew_Fe-of67', title: 'Rockstar Spin',                   category: 'Pole Advanced 1' },
  { drive_id: '1RwuWfd2sJyXnqAkUslAfDXzuDctE3Czi', title: 'Swing Climb',                     category: 'Pole Advanced 1' },
  { drive_id: '1RkniUv_jWlE92SGG_1v0WdoLExJ5oAPh', title: 'Leg Switches',                    category: 'Pole Advanced 1' },
  { drive_id: '1Rd4nm6l3g78MVn75njtXsyG7O9wU2APW', title: 'Inside Leg Hang',                 category: 'Pole Advanced 1' },
  { drive_id: '1RLdD_VZoq5MsS44q4JfqUQscDq6rqbKc', title: 'Dragonfly/Inverted Thigh Hold',   category: 'Pole Advanced 1' },
  { drive_id: '1Sn56QAhr-H9FeiQlZCNl3I4BEBU_Qanp', title: 'Superman from Flatline',          category: 'Pole Advanced 1' },

  // Pole Advanced 2
  { drive_id: '1ZzbxioLV3XwczTdI1m2WhrodrfijOxyc', title: 'Russian Sit Layback',             category: 'Pole Advanced 2' },
  { drive_id: '1ZQ8BzdbBgtWzyovkBaXUhTEZuxlwxAWo', title: 'Iguana Deadlift',                 category: 'Pole Advanced 2' },
  { drive_id: '1Z_2vEeeKpyJlHVi6_TLe7PhdXM1ep00A', title: 'Duchess/Jade Split',              category: 'Pole Advanced 2' },
  { drive_id: '1ZQ77i87QGUXHFGUWhK5nVWAxGWUmBAVN', title: 'Shoulder Mount to Brass Monkey',  category: 'Pole Advanced 2' },
  { drive_id: '1ZQMQrIQptqw4eCMOz9XstKAWT6KLs6BK', title: 'Circus Climb',                    category: 'Pole Advanced 2' },
  { drive_id: '1ZGBiyyC3jWkvoGadUl82AW3Tv7_MdkUi', title: 'Flag',                            category: 'Pole Advanced 2' },
  { drive_id: '1Z_O-FJOHSjspmaZC5bINSO5FoO3_p0Nl', title: 'Skittles Drop',                   category: 'Pole Advanced 2' },
  { drive_id: '1Zrfc3TUZydcSuOnaBHLsS2xK5BhHbJ62', title: 'Body Switches',                   category: 'Pole Advanced 2' },

  // Parties
  { drive_id: '14yHTelPii7eNBdqOJmpppUtsA0-eI7oV', title: 'Pole Party Routine',              category: 'Parties' },
  { drive_id: '1lIDw9z9qiVSYBLqfebyhquabhHPV9D4s', title: 'Chair Routine',                   category: 'Parties' },

  // Chair Dance Routine (universal — category "Routines")
  { drive_id: '1Sb8KaVRQ488ouaYcf98Iu09EfFRE2rAl', title: 'Chair Dance Routine',             category: 'Routines' },
];

app.post('/api/admin/importDriveVideos', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const inserted = [];
  const skipped = [];
  let sortByCategory = {};
  for (const v of DRIVE_VIDEOS_IMPORT) {
    const file_path = `https://drive.google.com/file/d/${v.drive_id}/preview`;
    const existing = await pool.query('SELECT id FROM edu_videos WHERE file_path=$1', [file_path]);
    if (existing.rows.length > 0) {
      skipped.push({ title: v.title, reason: 'already imported' });
      continue;
    }
    sortByCategory[v.category] = (sortByCategory[v.category] || 0) + 1;
    const r = await pool.query(
      `INSERT INTO edu_videos (title, description, category, file_path, file_type, uploaded_by, sort_order)
       VALUES ($1,'',$2,$3,'drive_video',$4,$5) RETURNING id`,
      [v.title, v.category, file_path, user.email, sortByCategory[v.category]]
    );
    inserted.push({ id: r.rows[0].id, title: v.title, category: v.category });
  }
  res.json({ ok: true, inserted, skipped, totals: { inserted: inserted.length, skipped: skipped.length } });
});

app.post('/api/admin/importDriveManuals', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const inserted = [];
  const skipped = [];
  for (const m of DRIVE_MANUALS_IMPORT) {
    const file_path = `https://drive.google.com/file/d/${m.drive_id}/preview`;
    const existing = await pool.query('SELECT id FROM edu_manuals WHERE file_path=$1', [file_path]);
    if (existing.rows.length > 0) {
      skipped.push({ title: m.title, reason: 'already imported' });
      continue;
    }
    const r = await pool.query(
      `INSERT INTO edu_manuals (title, description, category, file_path, file_type, uploaded_by, sort_order)
       VALUES ($1,'',$2,$3,'pdf',$4,$5) RETURNING id`,
      [m.title, m.category, file_path, user.email, m.sort_order]
    );
    inserted.push({ id: r.rows[0].id, title: m.title, category: m.category });
  }
  res.json({ ok: true, inserted, skipped, totals: { inserted: inserted.length, skipped: skipped.length } });
});

// Pull a Drive folder ID out of a pasted URL (or accept a bare ID).
function extractDriveFolderId(url) {
  if (!url) return null;
  const s = String(url).trim();
  let m = s.match(/\/folders\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

// List all non-trashed files directly inside a Drive folder, following
// pagination. Requires a Google API key with the Drive API enabled; works on
// folders shared as "Anyone with the link can view".
async function driveListFolder(folderId, apiKey) {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      key: apiKey,
      fields: 'nextPageToken, files(id,name,mimeType)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);
    const data = await resp.json();
    if (!resp.ok) {
      const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

// Import every video in a Google Drive folder in one shot.
app.post('/api/admin/importDriveFolder', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.json({ ok: false, reason: 'Google Drive import is not configured — set GOOGLE_API_KEY on the server.' });
  }
  const folderId = extractDriveFolderId(req.body.folder_url);
  if (!folderId) return res.json({ ok: false, reason: 'That doesn\'t look like a Google Drive folder link.' });
  const category = String(req.body.category || 'General').trim() || 'General';

  let files;
  try {
    files = await driveListFolder(folderId, apiKey);
  } catch (e) {
    return res.json({ ok: false, reason: `Could not read that folder: ${e.message}. Make sure it's shared as "Anyone with the link can view".` });
  }

  // Keep only video files; note anything skipped so the UI can report it.
  const videos = files.filter(f => (f.mimeType || '').startsWith('video/'));
  const nonVideos = files.filter(f => (f.mimeType || '') && !(f.mimeType || '').startsWith('video/') && f.mimeType !== 'application/vnd.google-apps.folder');

  const inserted = [];
  const skipped = [];
  // Continue existing per-category sort ordering.
  const sortRow = await pool.query(
    'SELECT category, COALESCE(MAX(sort_order),0) AS max FROM edu_videos GROUP BY category'
  );
  const sortByCategory = {};
  for (const r of sortRow.rows) sortByCategory[r.category] = parseInt(r.max, 10) || 0;

  for (const f of videos) {
    const file_path = `https://drive.google.com/file/d/${f.id}/preview`;
    const existing = await pool.query('SELECT id FROM edu_videos WHERE file_path=$1', [file_path]);
    if (existing.rows.length > 0) {
      skipped.push({ title: f.name, reason: 'already imported' });
      continue;
    }
    const title = String(f.name || 'Untitled').replace(/\.[^.]+$/, '');
    sortByCategory[category] = (sortByCategory[category] || 0) + 1;
    const ins = await pool.query(
      `INSERT INTO edu_videos (title, description, category, file_path, file_type, uploaded_by, sort_order)
       VALUES ($1,'',$2,$3,'drive_video',$4,$5) RETURNING id`,
      [title, category, file_path, user.email, sortByCategory[category]]
    );
    inserted.push({ id: ins.rows[0].id, title });
  }

  res.json({
    ok: true,
    inserted, skipped,
    totals: {
      inserted: inserted.length,
      skipped: skipped.length,
      nonVideoFiles: nonVideos.length,
      found: files.length,
    },
  });
});

// Pull a Drive file ID out of a stored link.
function driveFileIdFromUrl(u) {
  const s = String(u || '');
  let m = s.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return null;
}

// Check one item's link. Returns { status: 'ok'|'broken'|'unknown', reason }.
async function checkOneLink(filePath, apiKey) {
  const fp = String(filePath || '');
  if (!fp) return { status: 'broken', reason: 'No file link' };
  // Locally-hosted upload
  if (fp.startsWith('/uploads') || fp.startsWith('/')) {
    const abs = path.join(__dirname, 'public', fp);
    return fs.existsSync(abs)
      ? { status: 'ok', reason: '' }
      : { status: 'broken', reason: 'File missing on server' };
  }
  if (/drive\.google\.com/.test(fp)) {
    const id = driveFileIdFromUrl(fp);
    if (!id) return { status: 'broken', reason: 'Unrecognized Drive link' };
    if (!apiKey) return { status: 'unknown', reason: 'No GOOGLE_API_KEY set' };
    try {
      const params = new URLSearchParams({ fields: 'id,trashed', key: apiKey, supportsAllDrives: 'true' });
      const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?${params.toString()}`);
      if (resp.status === 404) return { status: 'broken', reason: 'Not found or not shared publicly' };
      if (resp.status === 403) return { status: 'broken', reason: 'Access denied — check sharing' };
      if (!resp.ok) return { status: 'unknown', reason: `Drive returned ${resp.status}` };
      const data = await resp.json();
      if (data.trashed) return { status: 'broken', reason: 'File is in the trash' };
      return { status: 'ok', reason: '' };
    } catch (e) {
      return { status: 'unknown', reason: e.message };
    }
  }
  // Other external URL — a lightweight reachability check.
  try {
    const resp = await fetch(fp, { method: 'GET' });
    return resp.ok ? { status: 'ok', reason: '' } : { status: 'broken', reason: `Returned ${resp.status}` };
  } catch (e) {
    return { status: 'broken', reason: 'Unreachable' };
  }
}

// Run an async mapper over items with a small concurrency cap.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Admin: check the health of every manual/video link and report the broken ones.
app.post('/api/admin/checkLinks', async (req, res) => {
  const user = await getAuthorizedUser(req.body.email, req.body.pin);
  if (!isAdminOrMod(user)) return res.json({ ok: false, reason: 'Admin only' });
  const kind = ['manual', 'video', 'both'].includes(req.body.kind) ? req.body.kind : 'both';
  const apiKey = process.env.GOOGLE_API_KEY;
  const items = [];
  if (kind === 'manual' || kind === 'both') {
    const r = await pool.query('SELECT id, title, file_path FROM edu_manuals');
    for (const m of r.rows) items.push({ type: 'manual', id: m.id, title: m.title, file_path: m.file_path });
  }
  if (kind === 'video' || kind === 'both') {
    const r = await pool.query('SELECT id, title, file_path FROM edu_videos');
    for (const v of r.rows) items.push({ type: 'video', id: v.id, title: v.title, file_path: v.file_path });
  }
  const results = await mapLimit(items, 8, async (it) => {
    const h = await checkOneLink(it.file_path, apiKey);
    return { ...it, ...h };
  });
  const problems = results.filter(r => r.status !== 'ok');
  res.json({
    ok: true,
    totals: {
      checked: results.length,
      ok: results.filter(r => r.status === 'ok').length,
      broken: results.filter(r => r.status === 'broken').length,
      unknown: results.filter(r => r.status === 'unknown').length,
    },
    problems,
  });
});

// ─── Catch-all: serve SPA ───────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ──────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`Aradia EDU running on port ${PORT}`));
});
