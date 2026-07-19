// Drive → Bunny Stream migration for edu_videos (local-proxy method).
//
// Google blocks Bunny's datacenter IPs from bulk-downloading Drive (HTTP 403),
// so we route the bytes through THIS machine: download each file from Drive
// (residential IP — allowed) to a temp file, PUT it up to Bunny, update the row.
//
// For each edu_videos row still on Drive (file_type='drive_video'):
//   1. download the file from the Drive API (alt=media + GOOGLE_API_KEY) to a temp file
//   2. create a Bunny video (title from the DB) and PUT the bytes
//   3. update the row to the Bunny embed URL (file_type='bunny_video')
// A map is written to drive-to-bunny-map.json (rollback record + input for the
// manual .docx link rewrite). Google Drive is never modified.
//
// Usage:
//   node migrations/drive-to-bunny.js 5      # migrate up to 5
//   node migrations/drive-to-bunny.js all    # migrate everything remaining
//   node migrations/drive-to-bunny.js status # transcode status of migrated videos
//
// Idempotent: only touches drive_video rows; safe to re-run after interruptions.
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const LIB = process.env.BUNNY_STREAM_LIBRARY_ID;
const BKEY = process.env.BUNNY_STREAM_API_KEY;
const GKEY = process.env.GOOGLE_API_KEY;
const DB = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const MAP_FILE = path.join(__dirname, 'drive-to-bunny-map.json');
const TMP_DIR = path.join(__dirname, '_tmp');

if (!LIB || !BKEY || !GKEY || !DB) {
  console.error('Missing env: need BUNNY_STREAM_LIBRARY_ID, BUNNY_STREAM_API_KEY, GOOGLE_API_KEY, DB URL.');
  process.exit(1);
}

const arg = (process.argv[2] || '5').toLowerCase();
const driveId = (fp) => {
  const s = String(fp || '');
  const m = s.match(/\/file\/d\/([^/]+)/) || s.match(/[?&]id=([^&]+)/);
  return m ? m[1] : null;
};
const embedUrl = (g) => `https://iframe.mediadelivery.net/embed/${LIB}/${g}`;
const driveMediaUrl = (id) => `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${GKEY}&supportsAllDrives=true`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadMap = () => { try { return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch { return {}; } };
const saveMap = (m) => fs.writeFileSync(MAP_FILE, JSON.stringify(m, null, 2));

async function downloadDrive(id, dest, attempt = 0) {
  const r = await fetch(driveMediaUrl(id));
  if (r.status === 403 && attempt < 6) { await sleep(15000 * (attempt + 1)); return downloadDrive(id, dest, attempt + 1); }
  if (!r.ok) throw new Error('download HTTP ' + r.status);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  return fs.statSync(dest).size;
}
async function bunnyCreate(title) {
  const r = await fetch(`https://video.bunnycdn.com/library/${LIB}/videos`, {
    method: 'POST', headers: { AccessKey: BKEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ title })
  });
  if (!r.ok) throw new Error('create ' + r.status);
  return (await r.json()).guid;
}
async function bunnyPut(guid, filePath) {
  const bytes = fs.readFileSync(filePath);
  const r = await fetch(`https://video.bunnycdn.com/library/${LIB}/videos/${guid}`, {
    method: 'PUT', headers: { AccessKey: BKEY, 'Content-Type': 'application/octet-stream' }, body: bytes
  });
  if (!r.ok) throw new Error('put ' + r.status);
}
async function bunnyDelete(guid) { try { await fetch(`https://video.bunnycdn.com/library/${LIB}/videos/${guid}`, { method: 'DELETE', headers: { AccessKey: BKEY } }); } catch {} }
async function bunnyStatus(guid) { const r = await fetch(`https://video.bunnycdn.com/library/${LIB}/videos/${guid}`, { headers: { AccessKey: BKEY } }); return r.ok ? r.json() : null; }

async function reportStatus() {
  const entries = Object.values(loadMap());
  if (!entries.length) return console.log('No migrated videos in the map yet.');
  const tally = {}; const failed = [];
  for (const e of entries) {
    const s = await bunnyStatus(e.bunny_guid); const st = s ? s.status : 'gone';
    tally[st] = (tally[st] || 0) + 1; if (st === 5 || st === 6) failed.push(e); await sleep(60);
  }
  console.log(`Transcode status of ${entries.length} migrated (3=playable,4=finished,5/6=error):`);
  Object.entries(tally).sort().forEach(([k, v]) => console.log(`  status ${k}: ${v}`));
  if (failed.length) { console.log('\nFAILED:'); failed.forEach(e => console.log(`  [${e.id}] ${e.title}`)); }
}

async function migrate() {
  const LIMIT = arg === 'all' ? Infinity : (parseInt(arg, 10) || 5);
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, keepAlive: true, idleTimeoutMillis: 15000 });
  // Railway's proxy resets idle connections; without this handler pg throws the
  // reset as an unhandled 'error' event on the pool and crashes the process.
  pool.on('error', () => {});
  // Also retry the query itself, since the active connection can drop mid-download.
  const q = async (text, params) => {
    for (let a = 0; ; a++) {
      try { return await pool.query(text, params); }
      catch (e) { if (a >= 3) throw e; await sleep(1000 * (a + 1)); }
    }
  };
  const map = loadMap();
  const rows = (await q(`SELECT id, title, category, file_path FROM edu_videos WHERE file_type='drive_video' ORDER BY id`)).rows;
  const todo = rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
  console.log(`${rows.length} videos still on Drive. Migrating ${todo.length} (proxy through this machine).\n`);
  let done = 0, failed = 0, gb = 0;
  for (const row of todo) {
    const id = driveId(row.file_path);
    if (!id) { console.log(`  [${row.id}] SKIP — no Drive id`); continue; }
    const tmp = path.join(TMP_DIR, `${row.id}.bin`);
    let guid = null;
    try {
      const size = await downloadDrive(id, tmp);
      guid = await bunnyCreate(row.title || `Video ${row.id}`);
      await bunnyPut(guid, tmp);
      const embed = embedUrl(guid);
      await q(`UPDATE edu_videos SET file_path=$1, file_type='bunny_video' WHERE id=$2`, [embed, row.id]);
      map[row.id] = { id: row.id, title: row.title, category: row.category, drive_id: id, drive_url: row.file_path, bunny_guid: guid, embed_url: embed };
      saveMap(map);
      gb += size / 1e9; done++;
      console.log(`  [${row.id}] OK — ${row.title} (${(size/1e6).toFixed(0)}MB) → ${guid}   [${done}/${todo.length}]`);
    } catch (e) {
      failed++;
      if (guid) await bunnyDelete(guid); // roll back partial
      console.log(`  [${row.id}] FAIL — ${row.title}: ${e.message}`);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    await sleep(500);
  }
  console.log(`\nDone: ${done} migrated, ${failed} failed, ${gb.toFixed(2)} GB moved this run. Map → ${MAP_FILE}`);
  if (failed) console.log('Re-run the same command to retry the failed ones (idempotent).');
  await pool.end();
}

(arg === 'status' ? reportStatus() : migrate()).catch(e => { console.error('FATAL', e); process.exit(1); });
