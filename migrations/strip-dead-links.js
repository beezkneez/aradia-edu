// Strip remaining Google Drive hyperlinks from .docx files, converting them to
// plain text (the move name stays; the broken link is removed). Run this AFTER
// rewrite-docx-links.js, so the only Drive links left are dead ones.
// Operates in place on the files in the given folder.
//
// Usage: node migrations/strip-dead-links.js "manuals/Pole-bunny"
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const folder = process.argv[2];
if (!folder) { console.error('Usage: node migrations/strip-dead-links.js <folder>'); process.exit(1); }

for (const f of fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.docx') && !f.startsWith('~'))) {
  const p = path.join(folder, f);
  const zip = new AdmZip(p);
  const relsEntry = zip.getEntry('word/_rels/document.xml.rels');
  const docEntry = zip.getEntry('word/document.xml');
  let rels = relsEntry.getData().toString('utf8');
  let doc = docEntry.getData().toString('utf8');

  // rIds whose external target is a Google Drive link → dead links to strip.
  const dead = new Set();
  [...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/g)]
    .forEach(m => { if (/drive\.google\.com/i.test(m[2])) dead.add(m[1]); });
  if (!dead.size) { console.log(`  ${f}: no dead links`); continue; }

  // Unwrap each dead <w:hyperlink> → its inner runs, and drop the Hyperlink
  // character style so the text reads as normal (not blue/underlined).
  let stripped = 0;
  doc = doc.replace(/<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>/g, (whole, attrs, inner) => {
    const idm = attrs.match(/r:id="([^"]+)"/);
    if (idm && dead.has(idm[1])) {
      stripped++;
      return inner.replace(/<w:rStyle w:val="Hyperlink"\/>/g, '');
    }
    return whole;
  });
  // Remove the now-orphaned relationship entries.
  rels = rels.replace(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\/>/g, (whole, id) => dead.has(id) ? '' : whole);

  zip.updateFile('word/document.xml', Buffer.from(doc, 'utf8'));
  zip.updateFile('word/_rels/document.xml.rels', Buffer.from(rels, 'utf8'));
  zip.writeZip(p);
  console.log(`  ${f}: stripped ${stripped} dead link(s)`);
}
console.log('Done.');
