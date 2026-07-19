// Audit Bunny library vs DB: report content status of referenced videos,
// find/delete orphans (Bunny videos not referenced by any edu_videos row).
// Usage: node migrations/bunny-audit.js         (report only)
//        node migrations/bunny-audit.js --clean  (delete orphans)
require('dotenv').config();
const { Pool } = require('pg');
const LIB=process.env.BUNNY_STREAM_LIBRARY_ID, BKEY=process.env.BUNNY_STREAM_API_KEY;
const DB=process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL;
const CLEAN=process.argv.includes('--clean');
const guidFrom=fp=>{const m=String(fp).match(/mediadelivery\.net\/(?:embed|play)\/\d+\/([a-f0-9-]{36})/i);return m?m[1]:null;};
(async()=>{
  const pool=new Pool({connectionString:DB,ssl:{rejectUnauthorized:false}});
  const refRows=(await pool.query(`SELECT id,title,file_path FROM edu_videos WHERE file_type='bunny_video'`)).rows;
  const refGuids=new Set(refRows.map(r=>guidFrom(r.file_path)).filter(Boolean));
  // list all bunny videos
  let items=[],page=1;
  while(true){
    const r=await fetch(`https://video.bunnycdn.com/library/${LIB}/videos?page=${page}&itemsPerPage=100&orderBy=date`,{headers:{AccessKey:BKEY}});
    const j=await r.json(); items=items.concat(j.items||[]);
    if(!j.items||j.items.length<100)break; page++;
  }
  console.log(`Bunny library: ${items.length} videos. DB references ${refGuids.size} guids.`);
  // referenced: status breakdown
  const refItems=items.filter(i=>refGuids.has(i.guid));
  const st={}; let bytes=0, bad=[];
  refItems.forEach(i=>{st[i.status]=(st[i.status]||0)+1; bytes+=i.storageSize||0; if(i.status>=5||(i.status<2&&i.length===0))bad.push(i);});
  console.log('Referenced video statuses (4=finished,3=playable,5/6=error):',JSON.stringify(st));
  console.log('Referenced storage: '+(bytes/1e9).toFixed(2)+' GB');
  if(bad.length){console.log(`\n${bad.length} referenced videos look BROKEN (no content):`); bad.forEach(i=>console.log('  '+i.guid+' '+i.title+' status='+i.status+' len='+i.length));}
  // orphans
  const orphans=items.filter(i=>!refGuids.has(i.guid));
  console.log(`\nOrphans (not referenced by DB): ${orphans.length}`);
  if(orphans.length && CLEAN){
    let del=0; for(const o of orphans){ const r=await fetch(`https://video.bunnycdn.com/library/${LIB}/videos/${o.guid}`,{method:'DELETE',headers:{AccessKey:BKEY}}); if(r.ok)del++; }
    console.log(`Deleted ${del} orphans.`);
  } else if(orphans.length){ console.log('(run with --clean to delete them)'); }
  // Also: revert broken referenced rows back to drive so they re-migrate — only if we still have their drive url in the map
  await pool.end();
})().catch(e=>{console.error(e);process.exit(1);});
