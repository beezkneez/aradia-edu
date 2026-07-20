// Move the current manual PDFs off Google Drive to Bunny Storage, in place.
// For each edu_manuals row whose file_path is a Drive link: download the file
// (export Google Docs → PDF; alt=media for real PDFs), PUT it to the Bunny
// Storage Zone, and UPDATE the row's file_path to the public pull-zone URL.
// The video links *inside* the PDFs are whatever they are today (fixed later).
// A rollback log is written to manuals-map.json; Google Drive is never modified.
//
// Usage: node migrations/manuals-to-bunny.js         (dry run — list only)
//        node migrations/manuals-to-bunny.js --write  (do it)
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const GKEY = process.env.GOOGLE_API_KEY;
const DB = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const ZONE = process.env.BUNNY_STORAGE_ZONE, PW = process.env.BUNNY_STORAGE_PASSWORD, HOST = process.env.BUNNY_STORAGE_HOSTNAME;
const API = process.env.BUNNY_STORAGE_API_HOST || 'storage.bunnycdn.com';
const WRITE = process.argv.includes('--write');
const MAP_FILE = path.join(__dirname, 'manuals-map.json');
const driveId = (fp) => { const m = String(fp).match(/\/file\/d\/([^/]+)/); return m ? m[1] : null; };

async function driveMeta(id) { const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType&key=${GKEY}&supportsAllDrives=true`); return r.ok ? r.json() : null; }
async function driveBytes(id, mime) {
  const url = mime === 'application/vnd.google-apps.document'
    ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=application/pdf&key=${GKEY}`
    : `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${GKEY}&supportsAllDrives=true`;
  const r = await fetch(url); if (!r.ok) throw new Error('download ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}
async function storagePut(remotePath, buf) {
  const r = await fetch(`https://${API}/${ZONE}/${remotePath}`, { method: 'PUT', headers: { AccessKey: PW, 'Content-Type': 'application/octet-stream' }, body: buf });
  if (!r.ok) throw new Error('storage PUT ' + r.status);
  return `https://${HOST}/${remotePath}`;
}

(async () => {
  const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } }); pool.on('error', () => {});
  const map = (() => { try { return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch { return {}; } })();
  const rows = (await pool.query(`SELECT id, title, file_path FROM edu_manuals WHERE file_path LIKE '%drive.google.com%' ORDER BY id`)).rows;
  console.log(`${rows.length} manuals still on Drive.${WRITE ? '' : '  (dry run — add --write)'}\n`);
  for (const row of rows) {
    const id = driveId(row.file_path);
    if (!id) { console.log(`  [${row.id}] ${row.title}: no Drive id, skip`); continue; }
    try {
      const meta = await driveMeta(id);
      if (!meta) { console.log(`  [${row.id}] ${row.title}: not accessible, skip`); continue; }
      if (!WRITE) { console.log(`  [${row.id}] ${row.title}: ${meta.mimeType} → would move to Bunny`); continue; }
      const buf = await driveBytes(id, meta.mimeType);
      const url = await storagePut(`manuals/${uuidv4()}.pdf`, buf);
      await pool.query(`UPDATE edu_manuals SET file_path=$1, file_type='pdf' WHERE id=$2`, [url, row.id]);
      map[row.id] = { id: row.id, title: row.title, old: row.file_path, new: url, mime: meta.mimeType };
      fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
      console.log(`  [${row.id}] ${row.title}: ${(buf.length/1e6).toFixed(1)}MB → ${url}`);
    } catch (e) { console.log(`  [${row.id}] ${row.title}: FAIL ${e.message}`); }
  }
  console.log(WRITE ? `\nDone. Rollback log → ${MAP_FILE}` : '');
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
