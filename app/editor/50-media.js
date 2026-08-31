// ══════════════════════════════════════════════════════════════════
//  THROW editor · 50 — thumbnails, playlists, per-item looks, add/delete/copy.
//  Item blobs cross the channel once, addressed by id (docs/NOTES.md §7a).
// ══════════════════════════════════════════════════════════════════
// ── Media loading (editor side) ───────────────
// The editor accepts anything the browser MIGHT decode (format lists +
// sniffing come from shared.js), makes a lightweight preview, and ships the
// original Blob to the Display tab, which does the real decoding/playback.
// Videos NEVER play in the editor — a captured frame + ▶ badge stands in.
const THUMB_MAX = 512;
function makeThumb(el){
  try{
    const w=el.videoWidth||el.naturalWidth||el.width, h=el.videoHeight||el.naturalHeight||el.height;
    if(!w||!h) return null;
    const sc=Math.min(1, THUMB_MAX/Math.max(w,h));
    const c=document.createElement('canvas');
    c.width=Math.max(1,Math.round(w*sc)); c.height=Math.max(1,Math.round(h*sc));
    c.getContext('2d').drawImage(el,0,0,c.width,c.height);
    return c;
  }catch(_){ return null; }
}

// Grab one representative frame from a video via a THROWAWAY element —
// created, seeked ~0.1s in (black lead-ins make useless thumbs), snapshotted,
// destroyed. A decode failure here is an early warning in the same browser
// the Display tab runs in, so report it with the honest codec hint.
function makeVideoThumb(s, item){
  const file=item.file;
  const url=typedBlobURL(file, true);
  const v=document.createElement('video');
  v.muted=true; v.playsInline=true; v.preload='auto';
  let done=false, timer=0;
  const cleanup=()=>{
    try{ clearTimeout(timer); }catch(_){}
    try{ v.pause(); v.removeAttribute('src'); v.load(); }catch(_){}
    try{ URL.revokeObjectURL(url); }catch(_){}
  };
  // A source that fires NEITHER loadeddata nor error leaves this element and
  // its blob URL alive for the life of the tab, and the item silently never
  // gets a preview frame. Bound the wait. Not fatal — the display owns real
  // playback and may well manage the file — so this is a toast, not a banner.
  timer=setTimeout(()=>{
    if(done) return; done=true;
    toast('Couldn’t grab a preview frame from “'+(item.name||'clip')+'” — it may still play in the Display tab', 3000);
    cleanup();
  }, 20000);
  const snap=()=>{
    if(done) return; done=true;
    item._srcH=v.videoHeight||0;   // for the downscale hint / suggestion
    const t=makeThumb(v);
    if(t){
      item._thumb=t;   // cached on the item so re-selecting it is instant
      if(s.media && s.media.file===file){ s.media.thumb=t; updateUI(); }
    }
    if(item._srcH>1140 && !item._dsSuggested){
      item._dsSuggested=true;
      toast('“'+(item.name||'clip')+'” is '+item._srcH+'p — ⤓ Downscale it for smoother playback', 3200);
    }
    // NOTE: there used to be a "this clip is too large to play" error here.
    // It is no longer true — the display streams anything above 64MB to disk
    // (OPFS) rather than holding it in memory, and a 2.7GB capture now plays.
    // Predicting failure that no longer happens is just the old misleading
    // message pointing the other way; the storage meter reports what is
    // actually being used instead.
    cleanup();
  };
  v.addEventListener('loadeddata',()=>{
    try{ if(v.duration>0.5){ v.currentTime=0.1; } else snap(); }catch(_){ snap(); }
  });
  v.addEventListener('seeked',snap);
  v.addEventListener('error',()=>{
    if(done) return; done=true;
    const code=v.error?v.error.code:0;
    showError('Couldn’t decode '+(file.name||'that video')+' — '+mediaErrText(code)+'.',
      playbackHint(file.name, code));
    cleanup();
  });
  v.src=url;
}

// ── Playlists ─────────────────────────────────
// A surface's media is an ordered PLAYLIST of items (a single file = playlist
// of one). Item blobs ship to the Display tab ONCE, addressed by item id;
// reorders/removals/config changes ride the state broadcast — no re-sends.
// The editor stage always shows item 0's thumbnail.
let _plCounter=0;
function plUid(){ return 'M'+(++_plCounter)+'_'+Date.now().toString(36); }
function defaultPlaylist(){ return {items:[], transition:'cut', xfDur:1, imgDur:8}; }
function playlistOf(s){ if(!s.playlist) s.playlist=defaultPlaylist(); return s.playlist; }
// Every item carries its own LOOK. New items inherit the surface's default
// (s.adjust) so "set it once, every clip matches" still works — after that each
// item is edited independently.
// Every media item is registered by id so undo/redo can snapshot playlists as
// plain JSON (ids + looks) and re-link the heavy File/thumbnail objects on
// restore — including items removed by a delete the user then undoes.
const itemRegistry=new Map();
function regItem(it){ if(it&&it.id) itemRegistry.set(it.id, it); return it; }
function mkItem(file, seed, cropSeed){
  return regItem({id:plUid(), file, name:file.name||'media', kind:isVideoFile(file)?'video':'image',
          adjust:{...DEF_ADJUST, ...(seed||{})}, crop:{...DEF_CROP, ...(cropSeed||{})},
          trimIn:0, trimOut:0});   // seconds; trimOut 0 = play to the end
}

// ── Which item is being edited/previewed ──────
// Stored per surface (s._selItem) rather than globally, so switching surfaces
// can't leave ADJUST pointed at an item the stage isn't previewing.
function selItem(s){
  if(!s || !s.playlist || !s.playlist.items.length) return null;
  return s.playlist.items.find(it=>it.id===s._selItem) || s.playlist.items[0];
}
// The look the ADJUST panel edits: the selected item's, or — when the surface
// has no media yet — the surface's own default, which seeds items added later.
function adjustTarget(s){
  if(!s) return null;
  const it=selItem(s);
  if(it){ if(!it.adjust) it.adjust={...DEF_ADJUST}; return it.adjust; }
  if(!s.adjust) s.adjust={...DEF_ADJUST};
  return s.adjust;
}
// Preview a different playlist item on the stage (and point ADJUST at it)
function selectPlItem(s, id){
  if(!s || s._selItem===id) return;
  s._selItem=id;
  buildEditorMedia(s, selItem(s));
  updateUI();
}

// Build the editor's stage representation (s.media) from a playlist item.
function buildEditorMedia(s, item){
  try{ if(s.media && s.media.animCanvas && s.media.animCanvas._stop) s.media.animCanvas._stop(); }catch(_){}
  try{ if(s.media && s.media.src && !String(s.media.src).startsWith('data:')) URL.revokeObjectURL(s.media.src); }catch(_){}
  s.media=null;
  if(!item) return;
  if(item.src){   // restored data: URL image (from a saved project)
    const el=new Image();
    el.addEventListener('load',()=>{ if(s.media && s.media.el===el){ s.media.thumb=item._thumb=makeThumb(el); updateUI(); } });
    el.src=item.src;
    s.media={type:'image', el, src:item.src, name:item.name, item, thumb:item._thumb||null};
    return;
  }
  const file=item.file, name=item.name||'';
  if(item.kind==='video'){
    // Advisory only, and only the first time this item is built — the Display
    // tab's real MediaError is the source of truth.
    if(!item._sniffed){
      item._sniffed=true;
      sniffVideoCodec(file).then(info=>{
        if(info.name && !info.ok){
          toast('Heads up: '+(name||'video')+' looks like '+info.name+' — trying anyway…', 2600);
        }
      }).catch(()=>{});
    }
    s.media={type:'video', file, name, item, thumb:item._thumb||null};
    // Re-selecting an item must not re-decode the file just to re-grab a frame
    if(!item._thumb) makeVideoThumb(s, item);
  } else if(ANIMATED_EXT.test(name)){
    s.media={type:'image', file, name, item, thumb:item._thumb||null};
    // Re-selecting an item normally reuses its decoded canvas. But switching
    // AWAY stops that canvas (top of this function) and stopping closes its
    // frames — so a cached canvas that has been stopped is spent, and reusing
    // it showed a permanently frozen GIF. Decode again in that case.
    if(item._animCanvas && !item._animCanvas._dead){ s.media.animCanvas=item._animCanvas; return; }
    item._animCanvas=null;
    // ONE decode per item in flight. Switching away and back faster than the
    // decode finishes otherwise starts a second decode for the SAME item; both
    // pass the staleness check when they land, and the first canvas is
    // overwritten while still advancing — an orphan per round trip. A pending
    // decode will assign itself when it resolves, so returning here is enough.
    if(item._animPending) return;
    item._animPending=true;
    createAnimatedCanvas(file).then(anim=>{
      item._animPending=false;
      // The decode is async and its canvas STARTS ADVANCING before it resolves,
      // so a result that arrives after the user switched away is not merely
      // unwanted — it is a self-running rAF loop holding decoded frames open
      // forever. Stop it instead of dropping it on the floor.
      if(!s.media || s.media.file!==file){
        try{ if(anim && anim.canvas && anim.canvas._stop) anim.canvas._stop(); }catch(_){}
        return;
      }
      if(anim){
        // belt and braces: never overwrite a live canvas without stopping it
        try{ if(item._animCanvas && item._animCanvas!==anim.canvas && item._animCanvas._stop) item._animCanvas._stop(); }catch(_){}
        s.media.animCanvas=item._animCanvas=anim.canvas; updateUI();
      }
      else attachPlainImage(s, item);   // no ImageDecoder — <img> still animates GIF/WebP
    }).catch(err=>{
      item._animPending=false;
      showError(err.message);
      if(s.media && s.media.file===file) attachPlainImage(s, item);
    });
  } else {
    s.media={type:'image', file, name, item, thumb:item._thumb||null};
    attachPlainImage(s, item);
  }
}

function attachPlainImage(s, item){
  const file=item.file;
  const url=typedBlobURL(file, false);
  const el=new Image();
  el.addEventListener('error',()=>showError('Couldn’t load '+(file.name||'that image')+'.','the file may be corrupt or an unsupported format'));
  el.addEventListener('load',()=>{
    item._thumb=makeThumb(el);
    if(s.media && s.media.el===el){ s.media.thumb=item._thumb; updateUI(); }
  });
  el.src=url;
  s.media.el=el; s.media.src=url;
}

function acceptableFiles(files){
  const ok=[], bad=[];
  for(const f of files) (isImageFile(f)||isVideoFile(f)) ? ok.push(f) : bad.push(f.name||'file');
  if(bad.length) showError('Skipped unsupported file'+(bad.length>1?'s':'')+': '+bad.join(', '),
    'drop images (png/jpg/webp/gif/avif…) or videos (mp4/webm/mov/mkv/ogg…)');
  return ok;
}

// Replace the whole playlist with one file (drop / Media button / dblclick).
function loadMediaToSurface(s,file){
  if(!s){ showError('Pick a surface first, then add media.'); return; }
  if(!file) return;
  const ok=acceptableFiles([file]);
  if(!ok.length) return;
  const pl=playlistOf(s);
  const seed=s.adjust;   // keep the surface's established look
  pushUndo();
  freeMedia(s);
  pl.items=[mkItem(ok[0], seed, s.cropSeed)];
  s.name=(ok[0].name||'media').replace(/\.[^.]+$/,'').substring(0,18);
  s._selItem=pl.items[0].id;
  buildEditorMedia(s, pl.items[0]);
  bcSendPlaylist(s);
  updateUI(); toast('Loaded: '+s.name);
}

// Append files to the playlist (＋ Add in the Playlist panel).
function addToPlaylist(s, files){
  if(!s){ toast('Select a surface first'); return; }
  const ok=acceptableFiles(files);
  if(!ok.length) return;
  pushUndo();
  const pl=playlistOf(s);
  const wasEmpty=pl.items.length===0;
  for(const f of ok) pl.items.push(mkItem(f, s.adjust, s.cropSeed));   // new clips inherit the surface look/crop
  if(wasEmpty){
    s.name=(ok[0].name||'media').replace(/\.[^.]+$/,'').substring(0,18);
    s._selItem=pl.items[0].id;
    buildEditorMedia(s, pl.items[0]);
  }
  bcSendPlaylist(s);
  updateUI(); toast('Added '+ok.length+' item'+(ok.length>1?'s':'')+' — playlist: '+pl.items.length);
}

function plMoveItem(s, i, d){
  const pl=playlistOf(s);
  const j=i+d;
  if(j<0 || j>=pl.items.length) return;
  pushUndo();
  [pl.items[i], pl.items[j]]=[pl.items[j], pl.items[i]];
  updateUI();   // selection follows the item by id; order rides the state broadcast
}
function plRemoveItem(s, i){
  pushUndo();
  const pl=playlistOf(s);
  const [gone]=pl.items.splice(i,1);
  if(gone && gone.id===s._selItem){        // was previewing the one just removed
    s._selItem=pl.items.length?pl.items[0].id:null;
    buildEditorMedia(s, selItem(s));
  }
  updateUI();
}

document.getElementById('mediaLoad').addEventListener('change',function(){
  const file=this.files[0]; if(!file) return;
  const s=surfaces.find(s=>s.id===selId);
  if(s) loadMediaToSurface(s,file);
  this.value='';
});
document.getElementById('plMediaLoad').addEventListener('change',function(){
  const files=[...this.files]; if(!files.length) return;
  addToPlaylist(surfaces.find(s=>s.id===selId), files);
  this.value='';
});
document.getElementById('btnPlAdd').onclick=()=>{
  if(!selId){ toast('Select a surface first'); return; }
  document.getElementById('plMediaLoad').click();
};

// ── Add surface ───────────────────────────────
function addSurface(){
  pushUndo();
  const cx=stageW/2, cy=stageH/2;
  const w=stageW*0.35, h=stageH*0.35;
  const rows=currentMeshRows(), cols=currentMeshCols();
  const s=makeSurface(cx-w/2,cy-h/2,w,h,rows,cols);
  surfaces.push(s);
  selId=s.id;
  updateUI(); toast('Surface added — drag corners to warp');
  return s;
}

document.getElementById('btnAdd').onclick=()=>addSurface();

// ── Delete / Dup ──────────────────────────────
document.getElementById('btnDel').onclick=deleteSel;
document.getElementById('btnDup').onclick=()=>{
  const s=surfaces.find(s=>s.id===selId);
  if(!s) return;
  pushUndo();
  const clone=JSON.parse(JSON.stringify(s));
  clone.id=uid(); clone.name=s.name+' copy';
  // offset clone
  for(let r=0;r<=clone.rows;r++) for(let c=0;c<=clone.cols;c++){
    clone.pts[r][c].x+=20; clone.pts[r][c].y+=20;
  }
  // JSON cloning turns the warp-cache canvas into junk — drop it so the clone
  // builds its own on first render
  delete clone._warpBuf; delete clone._warpKey;
  // re-attach media (thumb/anim canvas + blob are shared by reference).
  // Playlist items get FRESH ids (JSON cloning destroyed the File refs).
  if(s.playlist){
    clone.playlist={transition:s.playlist.transition, xfDur:s.playlist.xfDur, imgDur:s.playlist.imgDur,
      items:s.playlist.items.map(it=>regItem({id:plUid(), file:it.file, src:it.src, name:it.name, kind:it.kind,
                                       adjust:{...DEF_ADJUST, ...(it.adjust||{})}, crop:{...DEF_CROP, ...(it.crop||{})},
                                       trimIn:it.trimIn||0, trimOut:it.trimOut||0,
                                       _thumb:it._thumb, _animCanvas:it._animCanvas, _sniffed:it._sniffed}))};
    clone._selItem=clone.playlist.items.length?clone.playlist.items[0].id:null;
  }
  // Build the copy's stage preview from the copy's OWN item. Spreading the
  // original's s.media carried two faults: media.item still pointed at the
  // original's item, so editorAdjust() previewed the original's look and
  // editing the copy changed only the projector; and media.src was the
  // original's blob URL, which freeMedia() on the original revokes — blanking
  // the copy. buildEditorMedia re-derives both from the clone's item (reusing
  // the cached _thumb, so no re-decode).
  buildEditorMedia(clone, selItem(clone));
  surfaces.push(clone);
  bcSendPlaylist(clone);   // display needs the blobs under the new item ids
  selId=clone.id; updateUI();
};

function freeMedia(s){
  if(!s||!s.media) return;
  try{ if(s.media.animCanvas && s.media.animCanvas._stop) s.media.animCanvas._stop(); }catch(_){}
  try{ if(s.media.src && !String(s.media.src).startsWith('data:')) URL.revokeObjectURL(s.media.src); }catch(_){}
  s.media=null;
  // display-side cleanup happens via the state broadcast (playlist order)
}
function deleteSel(){
  if(!selId) return;
  pushUndo();
  const s=surfaces.find(x=>x.id===selId); freeMedia(s);
  surfaces=surfaces.filter(s=>s.id!==selId);
  selId=surfaces.length?surfaces[surfaces.length-1].id:null;
  updateUI();
}

document.getElementById('btnMedia').onclick=()=>{
  if(!selId){ toast('Select a surface first'); return; }
  document.getElementById('mediaLoad').click();
};

document.getElementById('btnResetMesh').onclick=()=>resetSelMesh();

function resetSelMesh(){
  const s=surfaces.find(s=>s.id===selId);
  if(!s){ toast('Select a surface first'); return; }
  pushUndo();
  const b=surfaceBBox(s);
  s.pts=makeGrid(s.rows,s.cols,b.x,b.y,b.w,b.h);
  toast('Mesh flattened (R)');
}

// CALIBRATE: drop the selected surface back to a clean, fully-visible rectangle
// in the middle of the stage — the rescue button when a warp gets tangled or a
// handle wanders off the projector.
function recenterSel(){
  const s=surfaces.find(s=>s.id===selId);
  if(!s){ toast('Select a surface first'); return; }
  pushUndo();
  const w=stageW*0.5, h=stageH*0.5;
  s.pts=makeGrid(s.rows,s.cols,(stageW-w)/2,(stageH-h)/2,w,h);
  toast('Surface re-centered (C)');
}

// Rigid translate of the selected surface (arrow-key nudge). dx/dy in stage px.
function translateSel(dx, dy){
  const s=surfaces.find(s=>s.id===selId);
  if(!s) return false;
  touchState();
  for(let r=0;r<=s.rows;r++) for(let c=0;c<=s.cols;c++){
    s.pts[r][c].x+=dx; s.pts[r][c].y+=dy;
  }
  return true;
}

