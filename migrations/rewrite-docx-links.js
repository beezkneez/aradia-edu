// Phase 2: rewrite Google Drive video hyperlinks inside .docx manuals to their
// Bunny equivalents, using the map produced by drive-to-bunny.js.
//
// For each .docx in the given folder: open it, find every Drive /file/d/{ID}
// hyperlink target, and if that Drive ID was migrated (present in the map),
// replace the target with the Bunny embed URL. Writes NEW files to
// <folder>-bunny/ — originals are never modified. Reports any links with no
// Bunny match (left as Drive) so you can chase them down.
//
// Usage:
//   node migrations/rewrite-docx-links.js "manuals/Pole"           # dry run (report only)
//   node migrations/rewrite-docx-links.js "manuals/Pole" --write   # write <folder>-bunny/*.docx
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const MAP_FILE = path.join(__dirname, 'drive-to-bunny-map.json');
const folder = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!folder) { console.error('Usage: node migrations/rewrite-docx-links.js <folder> [--write]'); process.exit(1); }

// Build drive_id -> embed_url from the migration map.
let map = {};
try { map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch { console.error('No map file yet — run the video migration first.'); process.exit(1); }
const byDriveId = {};
Object.values(map).forEach(e => { if (e.drive_id) byDriveId[e.drive_id] = e; });
// Merge the "extras" map (manual-only videos migrated by migrate-extras.js).
try {
  const extras = JSON.parse(fs.readFileSync(path.join(__dirname, 'extras-map.json'), 'utf8'));
  Object.values(extras).forEach(e => { if (e.drive_id) byDriveId[e.drive_id] = e; });
} catch {}
console.log(`Map has ${Object.keys(byDriveId).length} migrated Drive IDs.\n`);

const RELS = 'word/_rels/document.xml.rels';
const DRIVE_RE = /https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\/[^"]*/g;

const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.docx') && !f.startsWith('~'));
const outDir = folder.replace(/[\\/]+$/, '') + '-bunny';
if (WRITE && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

let grandUnmatched = [];
for (const f of files) {
  const zip = new AdmZip(path.join(folder, f));
  const entry = zip.getEntry(RELS);
  if (!entry) { console.log(`  ${f}: no ${RELS} — skipped`); continue; }
  let xml = entry.getData().toString('utf8');
  let total = 0, replaced = 0; const unmatched = [];
  xml = xml.replace(DRIVE_RE, (whole, id) => {
    total++;
    const hit = byDriveId[id];
    if (hit) { replaced++; return hit.embed_url; }
    unmatched.push(id);
    return whole;
  });
  console.log(`  ${f}: ${total} Drive links → ${replaced} rewritten, ${unmatched.length} unmatched`);
  if (unmatched.length) grandUnmatched.push({ file: f, ids: unmatched });
  if (WRITE) {
    zip.updateFile(RELS, Buffer.from(xml, 'utf8'));
    zip.writeZip(path.join(outDir, f));
  }
}

if (grandUnmatched.length) {
  console.log('\nUnmatched Drive IDs (no migrated Bunny video — left as Drive links):');
  grandUnmatched.forEach(u => { console.log(`  ${u.file}:`); u.ids.forEach(id => console.log(`    ${id}`)); });
}
console.log(WRITE ? `\nWrote rewritten .docx files to ${outDir}/` : '\n(dry run — add --write to produce the rewritten files)');
