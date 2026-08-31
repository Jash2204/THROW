// ══════════════════════════════════════════════════════════════════
//  THROW editor · 85 — stacking order, scale about centre, undo/redo.
//  Snapshots are plain JSON; media re-links by id (docs/NOTES.md §7f).
// ══════════════════════════════════════════════════════════════════
// ── Stacking order ────────────────────────────
// surfaces[] IS the paint order — later entries draw on top. The rail lists it
// reversed (top row = topmost), and the display renders the same array order,
// so a reorder rides the normal state broadcast with no extra plumbing.
function bringToFront(){
  const i=surfaces.findIndex(s=>s.id===selId);
  if(i<0){ toast('Select a surface first'); return; }
  if(i===surfaces.length-1){ toast('Already at the front'); return; }
  pushUndo();
  surfaces.push(surfaces.splice(i,1)[0]);
  updateUI(); toast('Moved to front');
}
function sendToBack(){
  const i=surfaces.findIndex(s=>s.id===selId);
  if(i<0){ toast('Select a surface first'); return; }
  if(i===0){ toast('Already at the back'); return; }
  pushUndo();
  surfaces.unshift(surfaces.splice(i,1)[0]);
  updateUI(); toast('Moved to back');
}
document.getElementById('btnFront').onclick=bringToFront;
document.getElementById('btnBack').onclick=sendToBack;

// ── Scale ─────────────────────────────────────
// Scales every control point about the surface's centre, so a warped mesh keeps
// its shape. The slider is cumulative from the moment you selected the surface
// (it resets to 100% on selection change), which means dragging back to 100%
// exactly undoes it — no separate "original size" state to keep.
let _scaleLast=100, _scaleSelId=null;
function scaleSurface(s, f){
  if(!(f>0) || !isFinite(f)) return;
  touchState();
  const c=surfaceCenter(s);
  for(let r=0;r<=s.rows;r++) for(let col=0;col<=s.cols;col++){
    const p=s.pts[r][col];
    p.x=c.x+(p.x-c.x)*f;
    p.y=c.y+(p.y-c.y)*f;
  }
}
const rngScale=document.getElementById('rngScale');
rngScale.oninput=function(){
  beginGesture();
  const v=+this.value;
  document.getElementById('lblScale').textContent=v+'%';
  const s=surfaces.find(s=>s.id===selId);
  if(!s){ this.value=100; _scaleLast=100; document.getElementById('lblScale').textContent='100%'; toast('Select a surface first'); return; }
  scaleSurface(s, v/_scaleLast);
  _scaleLast=v;
};

// ── Undo / redo ───────────────────────────────
// Snapshots are plain JSON: geometry, config, z-order and per-item looks. Media
// (File refs, thumbnails, decoded frames) is immutable and re-linked by id from
// itemRegistry on restore, so snapshots stay tiny and an undo of a delete brings
// the blobs back. pushUndo() is called at the START of each edit gesture.
let _undo=[], _redo=[], _restoring=false;
const UNDO_MAX=80;
function snapshot(){
  return JSON.stringify({
    stageW, stageH, selId,
    surfaces: surfaces.map(s=>({
      id:s.id, rows:s.rows, cols:s.cols, pts:s.pts,
      blend:s.blend, opacity:s.opacity, visible:s.visible, name:s.name, mask:s.mask?s.mask.map(m=>({u:m.u,v:m.v})):null,
      adjust:{...(s.adjust||DEF_ADJUST)}, cropSeed:s.cropSeed?{...s.cropSeed}:null, sel:s._selItem||null,
      pl: s.playlist ? {
        transition:s.playlist.transition, xfDur:s.playlist.xfDur, imgDur:s.playlist.imgDur,
        items:s.playlist.items.map(it=>({id:it.id, adjust:{...(it.adjust||DEF_ADJUST)}, crop:{...(it.crop||DEF_CROP)}, trimIn:it.trimIn||0, trimOut:it.trimOut||0}))
      } : null
    }))
  });
}
function pushUndo(){
  if(_restoring) return;
  _undo.push(snapshot());
  if(_undo.length>UNDO_MAX) _undo.shift();
  _redo.length=0;
}
function restore(json){
  const st=JSON.parse(json);
  _restoring=true;
  try{
    stageW=st.stageW; stageH=st.stageH;
    document.getElementById('stageW').value=stageW;
    document.getElementById('stageH').value=stageH;
    resizeStage(stageW,stageH); syncStagePresetUI();
    surfaces = st.surfaces.map(ss=>{
      const s={ id:ss.id, rows:ss.rows, cols:ss.cols, pts:ss.pts,
                blend:ss.blend, opacity:ss.opacity, visible:ss.visible, name:ss.name,
                adjust:{...ss.adjust}, cropSeed:ss.cropSeed?{...ss.cropSeed}:null, mask:ss.mask||null, media:null, _selItem:ss.sel };
      if(ss.pl){
        s.playlist={transition:ss.pl.transition, xfDur:ss.pl.xfDur, imgDur:ss.pl.imgDur,
          items: ss.pl.items.map(pit=>{
            const it=itemRegistry.get(pit.id);
            if(!it) return null;
            it.adjust={...pit.adjust};       // look + crop + trim are what changed
            if(pit.crop) it.crop={...pit.crop};
            if('trimIn' in pit) it.trimIn=pit.trimIn;
            if('trimOut' in pit) it.trimOut=pit.trimOut;
            return it;
          }).filter(Boolean)};
      }
      return s;
    });
    selId = surfaces.some(s=>s.id===st.selId) ? st.selId
          : (surfaces.length?surfaces[surfaces.length-1].id:null);
    const cur=surfaces.find(s=>s.id===selId);
    if(cur && cur.playlist && cur.playlist.items.length){
      if(!cur.playlist.items.some(it=>it.id===cur._selItem)) cur._selItem=cur.playlist.items[0].id;
      buildEditorMedia(cur, selItem(cur));
    }
    // NOT a forced resend. Undo/redo changes looks, order and geometry — never
    // media bytes — and force-sending re-read every File and re-broadcast every
    // blob on each step, so undoing an opacity nudge re-shipped a wall of 4K
    // clips. Items the display still holds cost nothing; anything it genuinely
    // pruned it asks for by id (see the need-item handler).
    for(const s of surfaces) if(s.playlist) bcSendPlaylist(s);
    _scaleSelId=null;   // rewind the scale dial for the restored selection
  } finally {
    _restoring=false;
  }
  updateUI();
}
function undo(){
  if(!_undo.length){ toast('Nothing to undo'); return; }
  _redo.push(snapshot());
  restore(_undo.pop());
  toast('Undo');
}
function redo(){
  if(!_redo.length){ toast('Nothing to redo'); return; }
  _undo.push(snapshot());
  restore(_redo.pop());
  toast('Redo');
}
// Continuous gestures (canvas drags, sliders) snapshot ONCE at the start, so a
// 100-step opacity drag is a single undo. beginGesture() is idempotent within a
// gesture; endGesture() re-arms it.
let _gestureArmed=true;
function beginGesture(){ if(_gestureArmed){ pushUndo(); _gestureArmed=false; } }
function endGesture(){ _gestureArmed=true; }
function syncScaleUI(){
  // only rewind the dial when the selection actually changes
  if(_scaleSelId===selId) return;
  _scaleSelId=selId; _scaleLast=100;
  rngScale.value=100;
  document.getElementById('lblScale').textContent='100%';
}

