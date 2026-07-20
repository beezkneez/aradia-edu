// Generate branded SVG cover art for the Pole/Hoop categories and set them as
// each category's image (uploaded to Bunny Storage, image_url updated in place).
// Numbered categories get their level number; plain ones get a figure motif.
require('dotenv').config();
const { Pool } = require('pg');

const ZONE = process.env.BUNNY_STORAGE_ZONE, PW = process.env.BUNNY_STORAGE_PASSWORD, HOST = process.env.BUNNY_STORAGE_HOSTNAME;
const API = process.env.BUNNY_STORAGE_API_HOST || 'storage.bunnycdn.com';
const DB = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

const DEFS = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#571a2c"/><stop offset="0.55" stop-color="#8a2b46"/><stop offset="1" stop-color="#b23a58"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.34" r="0.62">
      <stop offset="0" stop-color="#ff6b81" stop-opacity="0.5"/><stop offset="1" stop-color="#ff6b81" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
const ROSE = '#ffdbe3', WHITE = '#ffffff';
const frame = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">${DEFS}
  <rect width="400" height="400" fill="url(#bg)"/>
  <circle cx="200" cy="150" r="190" fill="url(#glow)"/>
  ${inner}</svg>`;
const num = (x, y, s, t) => `<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${s}" font-weight="800" fill="${WHITE}" text-anchor="middle">${t}</text>`;

// ── Hoop: top bar + straps + ring; number inside the ring, or a seated figure ──
function hoop(n) {
  const rig = `
    <rect x="150" y="50" width="100" height="9" rx="4.5" fill="${ROSE}"/>
    <path d="M170 58 L200 118 M230 58 L200 118" stroke="${ROSE}" stroke-width="7" fill="none" stroke-linecap="round"/>
    <circle cx="200" cy="242" r="106" fill="none" stroke="${ROSE}" stroke-width="15"/>`;
  const inside = n
    ? num(200, 296, 150, n)
    : `<circle cx="200" cy="205" r="24" fill="${WHITE}"/>
       <path d="M200 230 C 200 268 188 286 158 300 M200 230 C 202 262 214 278 244 262"
             stroke="${WHITE}" stroke-width="17" fill="none" stroke-linecap="round"/>`;
  return frame(rig + inside);
}

// ── Pole: vertical pole + base; big number, or a dancer figure ──
function pole(n) {
  const rig = `<rect x="118" y="46" width="13" height="308" rx="6.5" fill="${ROSE}"/>
    <ellipse cx="124.5" cy="358" rx="40" ry="9" fill="${ROSE}" opacity="0.75"/>`;
  const body = n
    ? num(258, 258, 168, n)
    : `<circle cx="196" cy="120" r="21" fill="${WHITE}"/>
       <path d="M196 140 L131 156" stroke="${WHITE}" stroke-width="15" fill="none" stroke-linecap="round"/>
       <path d="M196 140 L202 224" stroke="${WHITE}" stroke-width="17" fill="none" stroke-linecap="round"/>
       <path d="M202 224 C 190 270 178 292 158 312" stroke="${WHITE}" stroke-width="16" fill="none" stroke-linecap="round"/>
       <path d="M202 224 C 224 250 244 262 258 258" stroke="${WHITE}" stroke-width="16" fill="none" stroke-linecap="round"/>`;
  return frame(rig + body);
}

// category id → svg
const ART = {
  9:   pole(null),  83: pole('1'), 104: pole('2'), 105: pole('3'), 106: pole('4'), 107: pole('5'),
  153: hoop(null),  1:  hoop('1'), 102: hoop('2'),
};

async function storagePut(remotePath, buf, type) {
  const r = await fetch(`https://${API}/${ZONE}/${remotePath}`, {
    method: 'PUT', headers: { AccessKey: PW, 'Content-Type': type }, body: buf
  });
  if (!r.ok) throw new Error('PUT ' + r.status);
  return `https://${HOST}/${remotePath}`;
}

(async () => {
  const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } }); pool.on('error', () => {});
  for (const [id, svg] of Object.entries(ART)) {
    try {
      const url = await storagePut(`categories/art-${id}.svg`, Buffer.from(svg, 'utf8'), 'image/svg+xml');
      await pool.query('UPDATE edu_categories SET image_url=$1 WHERE id=$2', [url, id]);
      const nm = (await pool.query('SELECT name FROM edu_categories WHERE id=$1', [id])).rows[0].name;
      console.log(`  [${id}] ${nm} → ${url}`);
    } catch (e) { console.log(`  [${id}] FAIL ${e.message}`); }
  }
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
