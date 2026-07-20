// Build category cover tiles by cropping cells from the hi-res silhouette grid
// (images/category.png). Numbered cells are used as-is; the two "plain"
// categories get their baked-in number covered by the symmetric top-right
// background corner (seamless with the radial gradient).
// Default = preview; pass --upload to push to Bunny Storage + set image_url.
require('dotenv').config();
const sharp = require('sharp');
const { Pool } = require('pg');

const SRC = 'images/category.png';
const D = 'C:/Users/judbe/AppData/Local/Temp/claude/C--dev-aradia-time/a0900517-5bd4-4eda-a8b7-53d7803ed2ed/scratchpad';
const W = 1536, H = 1024, COLS = 7, ROWS = 4, INSET = 9;
const UPLOAD = process.argv.includes('--upload');

const ZONE = process.env.BUNNY_STORAGE_ZONE, PW = process.env.BUNNY_STORAGE_PASSWORD, HOST = process.env.BUNNY_STORAGE_HOSTNAME;
const API = process.env.BUNNY_STORAGE_API_HOST || 'storage.bunnycdn.com';
const DB = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

function box(col, row) {
  const l = Math.round(col * W / COLS) + INSET, r = Math.round((col + 1) * W / COLS) - INSET;
  const t = Math.round(row * H / ROWS) + INSET, b = Math.round((row + 1) * H / ROWS) - INSET;
  return { left: l, top: t, width: r - l, height: b - t };
}

async function cell(col, row, blankNumber) {
  const b = box(col, row);
  let buf = await sharp(SRC).extract(b).png().toBuffer();
  if (blankNumber) {
    // Cover the baked-in number with the mirror (top-right) corner, which shares
    // the same vignette darkness. Sampled well inside the edge to avoid border px.
    const pw = 62, ph = 68;
    const patch = await sharp(buf).extract({ left: b.width - pw - 14, top: 3, width: pw, height: ph }).flop().png().toBuffer();
    buf = await sharp(buf).composite([{ input: patch, left: 3, top: 3 }]).png().toBuffer();
  }
  return buf;
}

// category id → { col, row, blank }  (pole row 0, hoop row 1)
const MAP = {
  83: { col: 0, row: 0 }, 104: { col: 1, row: 0 }, 105: { col: 2, row: 0 }, 106: { col: 3, row: 0 }, 107: { col: 4, row: 0 },
  9:  { col: 6, row: 0, blank: true },
  1:  { col: 0, row: 1 }, 102: { col: 1, row: 1 },
  153: { col: 6, row: 1, blank: true },
};

async function storagePut(remotePath, buf) {
  const r = await fetch(`https://${API}/${ZONE}/${remotePath}`, { method: 'PUT', headers: { AccessKey: PW, 'Content-Type': 'image/png' }, body: buf });
  if (!r.ok) throw new Error('PUT ' + r.status);
  return `https://${HOST}/${remotePath}`;
}

(async () => {
  const ids = Object.keys(MAP);
  const built = {};
  for (const id of ids) built[id] = await cell(MAP[id].col, MAP[id].row, MAP[id].blank);

  const parts = [];
  for (let i = 0; i < ids.length; i++) parts.push({ input: await sharp(built[ids[i]]).resize(190, 210).png().toBuffer(), left: (i % 5) * 198 + 6, top: Math.floor(i / 5) * 218 + 6 });
  await sharp({ create: { width: 5 * 198 + 12, height: 2 * 218 + 12, channels: 3, background: '#222222' } }).composite(parts).png().toFile(D + '/category_hd_preview.png');
  console.log('preview → category_hd_preview.png  (order: ' + ids.join(', ') + ')');

  if (UPLOAD) {
    const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } }); pool.on('error', () => {});
    for (const id of ids) {
      const url = await storagePut(`categories/hd-${id}.png`, built[id]);
      await pool.query('UPDATE edu_categories SET image_url=$1 WHERE id=$2', [url, id]);
      console.log(`  [${id}] → ${url}`);
    }
    await pool.end();
    console.log('uploaded + set all.');
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
