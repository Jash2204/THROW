// ══════════════════════════════════════════════════════════════════
//  THROW editor · 70 — project JSON: schema validation, save and load.
//  Imported files are untrusted input (docs/NOTES.md §8).
// ══════════════════════════════════════════════════════════════════
// ── JSON schema validation ────────────────────
// Only well-formed THROW project data is applied. Unknown/malformed fields are
// rejected or clamped rather than trusted — a crafted .json is the only
// meaningful injection vector when running from file://.
const ALLOWED_BLENDS = new Set(['normal','screen','multiply','overlay','hard-light','color-dodge','add']);
function validateProjectData(data){
  if(typeof data !== 'object' || data === null || Array.isArray(data))
    throw new Error('root must be an object');
  const w=Number(data.stageW), h=Number(data.stageH);
  if(!Number.isFinite(w)||w<1||w>16384) throw new Error('invalid stageW');
  if(!Number.isFinite(h)||h<1||h>16384) throw new Error('invalid stageH');
  if(!Array.isArray(data.surfaces)) throw new Error('surfaces must be an array');
  for(const sd of data.surfaces){
    if(typeof sd !== 'object' || sd === null) throw new Error('surface entry not an object');
    if(typeof sd.rows !== 'number'||sd.rows<1||sd.rows>8) throw new Error('invalid rows');
    if(typeof sd.cols !== 'number'||sd.cols<1||sd.cols>8) throw new Error('invalid cols');
    // pts is the one field the renderer indexes blindly (s.pts[r][c] for every
    // r≤rows, c≤cols, every frame), so its SHAPE has to be checked, not just
    // its type: a short array threw inside the render loop 60×/second, and
    // non-numeric entries propagated NaN silently through the whole warp.
    if(!Array.isArray(sd.pts) || sd.pts.length !== sd.rows+1)
      throw new Error('pts must have rows+1 rows');
    const LIM=1e6;   // far off-stage is legal (§7); infinite is not
    for(const row of sd.pts){
      if(!Array.isArray(row) || row.length !== sd.cols+1)
        throw new Error('each pts row must have cols+1 points');
      for(const p of row){
        if(typeof p!=='object' || p===null) throw new Error('pts entries must be {x,y} objects');
        const x=Number(p.x), y=Number(p.y);
        if(!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('pts coordinates must be finite numbers');
        p.x=Math.max(-LIM,Math.min(LIM,x));
        p.y=Math.max(-LIM,Math.min(LIM,y));
      }
    }
    // clamp rather than reject so minor drift (old saves) still loads
    if(!ALLOWED_BLENDS.has(sd.blend)) sd.blend='normal';
    if(typeof sd.opacity==='number') sd.opacity=Math.max(0,Math.min(1,sd.opacity));
    // only data: image URLs survive the JSON round-trip; drop anything else
    if(sd.mediaSrc && !(typeof sd.mediaSrc==='string' && sd.mediaSrc.startsWith('data:image/')))
      sd.mediaSrc=null;
    if(sd.mediaType && sd.mediaType!=='image') sd.mediaType=null;
    // sanitise adjustments: clamp numbers (0 is a VALID value — don't || it
    // away: brightness 0 = black, saturation 0 = grayscale), flips to booleans
    if(sd.adjust && typeof sd.adjust==='object'){
      const a=sd.adjust;
      const num=(v,def,max)=>{ v=Number(v); return Number.isFinite(v) ? Math.max(0,Math.min(max,v)) : def; };
      sd.adjust={
        br:  num(a.br, 1, 2),
        ct:  num(a.ct, 1, 2),
        sat: num(a.sat, 1, 2),
        hue: num(a.hue, 0, 360),
        flipH: !!a.flipH, flipV: !!a.flipV
      };
    } else sd.adjust=null;
    // sanitise crop: normalised 0..1, kept inside the source frame
    if(sd.crop && typeof sd.crop==='object'){
      const c=sd.crop;
      const n01=(v,def)=>{ v=Number(v); return Number.isFinite(v)?Math.max(0,Math.min(1,v)):def; };
      let x=n01(c.x,0), y=n01(c.y,0), w=n01(c.w,1), h=n01(c.h,1);
      if(w<=0) w=1; if(h<=0) h=1;
      if(x+w>1) w=1-x; if(y+h>1) h=1-y;
      sd.crop={x,y,w,h};
    } else sd.crop=null;
    // sanitise sticker mask: an array of {u,v} in 0..1 (need ≥3 to be a polygon)
    if(Array.isArray(sd.mask) && sd.mask.length>=3){
      sd.mask=sd.mask.map(m=>({
        u: Math.max(0,Math.min(1, Number(m&&m.u)||0)),
        v: Math.max(0,Math.min(1, Number(m&&m.v)||0))
      }));
    } else sd.mask=null;
    // sanitise playlist config (items never persist in JSON)
    if(sd.playlist && typeof sd.playlist==='object'){
      const p=sd.playlist;
      const num=(v,def,min,max)=>{ v=Number(v); return Number.isFinite(v) ? Math.max(min,Math.min(max,v)) : def; };
      sd.playlist={
        transition: ['cut','crossfade','fadeblack'].includes(p.transition) ? p.transition : 'cut',
        xfDur: num(p.xfDur, 1, 0.2, 5),
        imgDur: num(p.imgDur, 8, 2, 60)
      };
    } else sd.playlist=null;
    // sanitise name to plain text
    if(typeof sd.name==='string') sd.name=sd.name.substring(0,32);
    else sd.name='Surface';
  }
  return data;
}

// Expose for automated tests (no-op in production use)
window.validateProjectData = validateProjectData;

// ── Save / Load ───────────────────────────────
document.getElementById('btnSave').onclick=function(){
  const promises=surfaces.map(async s=>({
    id:s.id, name:s.name, rows:s.rows, cols:s.cols,
    pts:s.pts, refX:s.refX, refY:s.refY, refW:s.refW, refH:s.refH,
    // the look/crop that round-trip are the ones on the item being embedded
    blend:s.blend, opacity:s.opacity, visible:s.visible, mask:s.mask||null,
    adjust:(selItem(s)&&selItem(s).adjust)||s.adjust||null,
    crop:(selItem(s)&&selItem(s).crop)||s.cropSeed||null,
    playlist:s.playlist?{transition:s.playlist.transition, xfDur:s.playlist.xfDur, imgDur:s.playlist.imgDur}:null,
    mediaSrc:s.media? await toDataURL(editorEl(s.media),s.media.type):null,
    mediaType:s.media?s.media.type:null
  }));
  Promise.all(promises).then(surfData=>{
    const data={stageW,stageH,surfaces:surfData};
    const blob=new Blob([JSON.stringify(data)],{type:'application/json'});
    const a=document.createElement('a');
    const url=URL.createObjectURL(blob);
    a.href=url;
    a.download='mapping.throw.json'; a.click();
    // The blob stays alive until revoked; a project with embedded images is
    // megabytes, and every Save leaked one for the life of the tab.
    setTimeout(()=>{ try{ URL.revokeObjectURL(url); }catch(_){} }, 30000);
  });
};
// Any fully-opaque pixel run? Scanning the alpha channel is the only honest
// test — the source extension lies (a .png is usually opaque, a .webp may not
// be) and guessing wrong either flattens transparency onto black or bloats
// every photo into a lossless PNG.
function hasAlpha(g,w,h){
  const d=g.getImageData(0,0,w,h).data;
  for(let i=3;i<d.length;i+=4) if(d[i]<255) return true;
  return false;
}
async function toDataURL(el,type){
  if(type==='image' && el){
    const c=document.createElement('canvas');
    c.width=el.naturalWidth||el.width; c.height=el.naturalHeight||el.height;
    if(!c.width||!c.height) return null;
    const g=c.getContext('2d',{willReadFrequently:true});
    g.drawImage(el,0,0);
    // JPEG has no alpha channel: a transparent logo round-tripped through it
    // came back with a black box behind it. Opaque images still take the small
    // lossy path; only images that actually need alpha pay for PNG.
    try{ if(hasAlpha(g,c.width,c.height)) return c.toDataURL('image/png'); }
    catch(_){ /* tainted canvas — fall through to the lossy path */ }
    return c.toDataURL('image/jpeg',0.85);
  }
  return null; // video too large to embed
}
document.getElementById('btnLoad').onclick=()=>document.getElementById('fileLoad').click();
document.getElementById('fileLoad').addEventListener('change',function(){
  const file=this.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const data=validateProjectData(JSON.parse(e.target.result));
      stageW=data.stageW||1920; stageH=data.stageH||1080;
      document.getElementById('stageW').value=stageW;
      document.getElementById('stageH').value=stageH;
      resizeStage(stageW,stageH);
      syncStagePresetUI();
      surfaces=(data.surfaces||[]).map(sd=>{
        const s={...sd, media:null};
        // Mint a FRESH id rather than trusting the file's. uid()'s counter
        // restarts at 0 each page load, so a saved "S1" would collide with the
        // next surface added by hand — and every `surfaces.find(s=>s.id===…)`
        // would then resolve to whichever came first, editing one surface while
        // another moved. (Also covers duplicate ids within a hand-edited file.)
        // Nothing cross-references surface ids in the save format, so renaming
        // them on import is free; the display keys its media off these ids and
        // is repopulated below.
        s.id=uid();
        // restored playlist config (items don't persist — blobs can't live in
        // JSON; a restored image becomes a single-item playlist)
        s.playlist = sd.playlist
          ? {items:[], transition:sd.playlist.transition, xfDur:sd.playlist.xfDur, imgDur:sd.playlist.imgDur}
          : {items:[], transition:'cut', xfDur:1, imgDur:8};
        if(sd.mediaSrc && sd.mediaType==='image'){
          const img=new Image();
          img.addEventListener('error',()=>showError('A saved image in this project could not be restored.'));
          img.addEventListener('load',()=>{ if(s.media && s.media.el===img){ s.media.thumb=makeThumb(img); updateUI(); } });
          img.src=sd.mediaSrc;
          s.media={type:'image',el:img,src:sd.mediaSrc};
          // the saved surface look/crop become the restored item's
          s.playlist.items=[regItem({id:plUid(), src:sd.mediaSrc, name:s.name||'image', kind:'image',
                             adjust:{...DEF_ADJUST, ...(sd.adjust||{})}, crop:{...DEF_CROP, ...(sd.crop||{})}})];
          s._selItem=s.playlist.items[0].id;
          bcSendPlaylist(s);   // restored image → Display tab (as data: URL)
        }
        // Deliberately NO clamping: surfaces are allowed to sit partly or fully
        // off-stage (hidden / not projected). Press C to rescue a lost surface.
        return s;
      });
      selId=null; updateUI(); clearError(); toast('Project loaded');
    }catch(err){
      showError('That file isn\u2019t a valid THROW project.', err.message);
    }
  };
  reader.onerror=()=>showError('Could not read that file.');
  reader.readAsText(file); this.value='';
});

document.getElementById('btnClear').onclick=()=>{
  if(!confirm('Clear all surfaces?')) return;
  pushUndo();
  surfaces.forEach(freeMedia);
  surfaces=[]; selId=null; updateUI();
};

