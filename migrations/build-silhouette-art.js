// Build category cover tiles from the pose-silhouette grid screenshot:
// extract each black silhouette, trim/centre it on a wine tile, add a white
// italic level number. Default = write preview; pass --upload to push to
// Bunny Storage and set each category's image_url.
require('dotenv').config();
const sharp = require('sharp');
const { Pool } = require('pg');

const D = 'C:/Users/judbe/AppData/Local/Temp/claude/C--dev-aradia-time/a0900517-5bd4-4eda-a8b7-53d7803ed2ed/scratchpad';
const GRID = D + '/grid.png';
const cw = Math.floor(658 / 7), ch = Math.floor(449 / 4);
const INS = { left: 8, right: 8, top: 16, bottom: 5 };
const T = 30;
const UPLOAD = process.argv.includes('--upload');

const ZONE = process.env.BUNNY_STORAGE_ZONE, PW = process.env.BUNNY_STORAGE_PASSWORD, HOST = process.env.BUNNY_STORAGE_HOSTNAME;
const API = process.env.BUNNY_STORAGE_API_HOST || 'storage.bunnycdn.com';
const DB = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c2540"/><stop offset="1" stop-color="#511628"/></linearGradient>
    <radialGradient id="v" cx="0.5" cy="0.42" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.28"/></radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#g)"/><rect width="400" height="400" fill="url(#v)"/></svg>`;
const numSvg = (n) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
  <text x="34" y="86" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-weight="700" font-size="72" fill="#ffffff" paint-order="stroke" stroke="#000000" stroke-opacity="0.28" stroke-width="2">${n}</text></svg>`;

async function silhouette(col, row) {
  const left = col * cw + INS.left, top = row * ch + INS.top, width = cw - INS.left - INS.right, height = ch - INS.top - INS.bottom;
  const grey = await sharp(GRID).extract({ left, top, width, height }).greyscale().toBuffer();
  const mask = await sharp(grey).threshold(T).toBuffer();          // silhouette=0, bg=255
  const alpha = await sharp(mask).negate().toBuffer();             // silhouette=255
  const black = await sharp({ create: { width, height, channels: 3, background: '#000000' } }).png().toBuffer();
  let rgba = await sharp(black).joinChannel(alpha).png().toBuffer();
  // Erase the top-left number corner (dest-out) so its speckle doesn't survive.
  rgba = await sharp(rgba).composite([{
    input: { create: { width: 24, height: 30, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } },
    left: 0, top: 0, blend: 'dest-out'
  }]).png().toBuffer();
  return sharp(rgba).trim().resize(300, 336, { fit: 'inside' }).png().toBuffer();
}

async function tile(col, row, number) {
  const sil = await silhouette(col, row);
  const m = await sharp(sil).metadata();
  const left = Math.round((400 - m.width) / 2), topPos = Math.round((400 - m.height) / 2) + 8;
  let out = await sharp(Buffer.from(bgSvg)).composite([{ input: sil, left, top: topPos }]).png().toBuffer();
  if (number) out = await sharp(out).composite([{ input: Buffer.from(numSvg(number)), left: 0, top: 0 }]).png().toBuffer();
  return out;
}

// category id → { col, row, number }  (pole row=0, hoop row=1)
const MAP = {
  9:   { col: 6, row: 0, number: null }, 83: { col: 1, row: 0, number: '1' }, 104: { col: 2, row: 0, number: '2' },
  105: { col: 3, row: 0, number: '3' }, 106: { col: 4, row: 0, number: '4' }, 107: { col: 5, row: 0, number: '5' },
  153: { col: 6, row: 1, number: null }, 1: { col: 0, row: 1, number: '1' }, 102: { col: 1, row: 1, number: '2' },
};

async function storagePut(remotePath, buf) {
  const r = await fetch(`https://${API}/${ZONE}/${remotePath}`, { method: 'PUT', headers: { AccessKey: PW, 'Content-Type': 'image/png' }, body: buf });
  if (!r.ok) throw new Error('PUT ' + r.status);
  return `https://${HOST}/${remotePath}`;
}

(async () => {
  const ids = Object.keys(MAP);
  const built = {};
  for (const id of ids) built[id] = await tile(MAP[id].col, MAP[id].row, MAP[id].number);

  const parts = [];
  for (let i = 0; i < ids.length; i++) parts.push({ input: await sharp(built[ids[i]]).resize(200, 200).toBuffer(), left: (i % 5) * 208 + 8, top: Math.floor(i / 5) * 208 + 8 });
  await sharp({ create: { width: 5 * 208 + 8, height: 2 * 208 + 8, channels: 3, background: '#222222' } }).composite(parts).png().toFile(D + '/silhouette_preview.png');
  console.log('preview → silhouette_preview.png  (order: ' + ids.join(', ') + ')');

  if (UPLOAD) {
    const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } }); pool.on('error', () => {});
    for (const id of ids) {
      const url = await storagePut(`categories/pose-${id}.png`, built[id]);
      await pool.query('UPDATE edu_categories SET image_url=$1 WHERE id=$2', [url, id]);
      console.log(`  [${id}] ${MAP[id].number || '(plain)'} → ${url}`);
    }
    await pool.end();
    console.log('uploaded + set all.');
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
