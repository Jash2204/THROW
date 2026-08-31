// ══════════════════════════════════════════════════════════════════
//  THROW editor · 20 — small utilities and the surface model.
//  Anything the later files call at LOAD time belongs here or earlier.
// ══════════════════════════════════════════════════════════════════
// ── Utility ──────────────────────────────────
let _tid = 0;
function uid(){ return 'S'+(++_tid) }
function toast(msg, dur=1800){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),dur);
}
// localStorage wrappers — private-mode and blocked-storage safe. These live
// here, ahead of every caller, because the stage-size restore in 60-ui.js runs
// them at LOAD time: across separate scripts a function declaration is only
// hoisted within its own file, so declaring them last was a ReferenceError.
function safeGet(k){ try{ return localStorage.getItem(k); }catch(_){ return null; } }
function safeSet(k,v){ try{ localStorage.setItem(k,v); }catch(_){} }

function stageScale(){
  return stageEl.getBoundingClientRect().width / stageW;
}
function clientToStage(cx,cy){
  const r=stageEl.getBoundingClientRect();
  const sc=stageScale();
  return {x:(cx-r.left)/sc, y:(cy-r.top)/sc};
}

// ── Surface Model ─────────────────────────────
// A surface has an rows×cols grid of control points (grid + geometry helpers
// come from shared.js). Initial state = regular grid; user drags points to warp.
function makeSurface(x,y,w,h,rows=2,cols=2){
  return {
    id: uid(),
    rows, cols,
    pts: makeGrid(rows,cols,x,y,w,h),
    // reference rect for bilinear (used to map media UV)
    refX:x, refY:y, refW:w, refH:h,
    media: null,      // {type:'image'|'video', el, src}
    blend: 'normal',
    opacity: 1,
    visible: true,
    adjust: {br:1, ct:1, sat:1, hue:0, flipH:false, flipV:false},
    playlist: {items:[], transition:'cut', xfDur:1, imgDur:8},
    name: 'Surface'
  };
}

