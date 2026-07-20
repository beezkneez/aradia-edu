// Migrate "extra" Drive videos that are linked in .docx manuals but were never
// added to the app (not in edu_videos, so not covered by drive-to-bunny.js).
// Downloads each accessible one through this machine, uploads to Bunny Stream,
// and records it in extras-map.json (keyed by Drive ID). Does NOT touch the DB —
// these are standalone Bunny videos used only for the manual hyperlinks.
// Inaccessible IDs (private/deleted) are reported and skipped.
//
// Usage: node migrations/migrate-extras.js "manuals/Pole"
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const LIB = process.env.BUNNY_STREAM_LIBRARY_ID, BKEY = process.env.BUNNY_STREAM_API_KEY, GKEY = process.env.GOOGLE_API_KEY;
const MAIN_MAP = path.join(__dirname, 'drive-to-bunny-map.json');
const EXTRAS_MAP = path.join(__dirname, 'extras-map.json');
const TMP_DIR = path.join(__dirname, '_tmp');
const folder = process.argv[2];
if (!folder) { console.error('Usage: node migrations/migrate-extras.js <folder>'); process.exit(1); }

const embedUrl = (g) => `https://iframe.mediadelivery.net/embed/${LIB}/${g}`;
const mediaUrl = (id) => `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${GKEY}&supportsAllDrives=true`;
const metaUrl = (id) => `https://www.googleapis.com/drive/v3/files/${id}?fields=name&key=${GKEY}&supportsAllDrives=true`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const load = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const RE = /https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\/[^"]*/g;

async function download(id, dest, attempt = 0) {
  const r = await fetch(mediaUrl(id));
  if (r.status === 403 && attempt < 10) { await sleep(Math.min(60000, 20000 * (attempt + 1))); return download(id, dest, attempt + 1); }
  if (!r.ok) throw new Error('download HTTP ' + r.status);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  return fs.statSync(dest).size;
}
async function bunnyCreate(title) {
  const r = await fetch(`https://video.bunnycdn.com/library/${LIB}/videos`, { method: 'POST', headers: { AccessKey: BKEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  if (!r.ok) throw new Error('create ' + r.status); return (await r.json()).guid;
}
async function bunnyPut(guid, fp) {
  const r = await fetch(`https://video.bunnycdn.com/library/${LIB}/videos/${guid}`, { method: 'PUT', headers: { AccessKey: BKEY, 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(fp) });
  if (!r.ok) throw new Error('put ' + r.status);
}

(async () => {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const known = new Set(Object.values(load(MAIN_MAP)).map(e => e.drive_id));
  const extras = load(EXTRAS_MAP);
  Object.keys(extras).forEach(id => known.add(id)); // already-done extras count as known
  // Collect unmatched IDs from the folder's docx.
  const ids = new Set();
  for (const f of fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.docx') && !f.startsWith('~'))) {
    const rels = new AdmZip(path.join(folder, f)).getEntry('word/_rels/document.xml.rels').getData().toString('utf8');
    let m; while ((m = RE.exec(rels))) if (!known.has(m[1])) ids.add(m[1]);
  }
  const todo = [...ids];
  console.log(`${todo.length} unmatched Drive IDs to try.\n`);
  let done = 0, inaccessible = [], consec403 = 0;
  for (const id of todo) {
    const tmp = path.join(TMP_DIR, `x_${id}.bin`);
    let guid = null;
    try {
      const meta = await fetch(metaUrl(id));
      if (!meta.ok) { inaccessible.push(id); console.log(`  SKIP ${id} — not accessible (${meta.status})`); continue; }
      const name = (await meta.json()).name || id;
      const size = await download(id, tmp);
      guid = await bunnyCreate(name);
      await bunnyPut(guid, tmp);
      extras[id] = { drive_id: id, name, bunny_guid: guid, embed_url: embedUrl(guid) };
      fs.writeFileSync(EXTRAS_MAP, JSON.stringify(extras, null, 2));
      done++; consec403 = 0;
      console.log(`  OK ${name} (${(size/1e6).toFixed(0)}MB) → ${guid}   [${done}]`);
    } catch (e) {
      if (guid) { try { await fetch(`https://video.bunnycdn.com/library/${LIB}/videos/${guid}`, { method: 'DELETE', headers: { AccessKey: BKEY } }); } catch {} }
      console.log(`  FAIL ${id}: ${e.message}`);
      if (/403/.test(e.message)) { if (++consec403 >= 2) { console.log('  …throttled, cooling 3 min…'); await sleep(180000); consec403 = 0; } }
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    await sleep(2500);
  }
  console.log(`\nDone: ${done} extras migrated, ${inaccessible.length} inaccessible. Map → ${EXTRAS_MAP}`);
  if (inaccessible.length) { console.log('Inaccessible IDs (private/deleted — need your review):'); inaccessible.forEach(id => console.log('  ' + id)); }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
