// ══════════════════════════════════════════════════════════════════
//  THROW editor · 90 — keyboard shortcuts, help, test hooks, and startup.
//  MUST LOAD LAST: the final lines run the app (updateUI/render/roll-call).
// ══════════════════════════════════════════════════════════════════
// ── Keyboard ──────────────────────────────────
window.addEventListener('keydown',e=>{
  touchState();   // R/C rewrite the mesh without touching updateUI
  // Any focused text/choice control owns the keystroke. SELECT was missing:
  // with the blend dropdown focused, "A" jumped the list AND added a surface,
  // and the arrow keys changed the blend AND nudged the surface.
  if(/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if(helpModal.style.display==='flex'){
    if(e.key==='Escape') closeHelp();
    return;
  }
  if(placeMode){
    if(e.key==='Escape') exitPlaceMode(false);
    if(e.key==='Enter') exitPlaceMode(true);
    if(e.key==='Backspace'&&placePts.length>0){ placePts.pop(); drawPlaceCanvas(); }
    return;
  }
  // Undo / redo — Ctrl/Cmd+Z, and Shift+Z or Ctrl+Y to redo
  if((e.ctrlKey||e.metaKey) && (e.key==='z'||e.key==='Z')){ e.preventDefault(); e.shiftKey?redo():undo(); return; }
  if((e.ctrlKey||e.metaKey) && (e.key==='y'||e.key==='Y')){ e.preventDefault(); redo(); return; }
  // Arrow keys nudge the selected surface: 1px, or 10px with Shift. A burst of
  // nudges within 800ms collapses into a single undo step.
  const ARROWS={ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]};
  if(ARROWS[e.key]){
    const [ux,uy]=ARROWS[e.key];
    const step=e.shiftKey?10:1;
    if(surfaces.some(s=>s.id===selId)){
      const now=Date.now();
      if(now-(window._lastNudge||0) > 800) pushUndo();
      window._lastNudge=now;
      translateSel(ux*step, uy*step);
      e.preventDefault();
    }
    return;
  }
  if(e.key==='a'||e.key==='A') addSurface();
  else if(e.key==='p'||e.key==='P') enterPlaceMode();
  else if(e.key==='d'||e.key==='D'||e.key==='l'||e.key==='L') openDisplay();
  else if(e.key==='r'||e.key==='R') resetSelMesh();
  else if(e.key==='c'||e.key==='C') recenterSel();
  else if(e.key==='o'||e.key==='O') setOutlines(!outputShowOutlines);
  else if(e.key==='h'||e.key==='H') setHandles(!handlesVisible);
  else if(e.key===']') bringToFront();
  else if(e.key==='[') sendToBack();
  else if(e.key==='Delete'||e.key==='Backspace') deleteSel();
  else if(e.key==='Escape'){ selId=null; updateUI(); }
});

// ── Help / onboarding ─────────────────────────
const helpModal=document.getElementById('helpModal');
// safeGet/safeSet moved to 20-model.js — 60-ui.js calls them at LOAD time
// (the stage-size restore), which is earlier than this file executes.

function openHelp(){
  document.getElementById('helpHttpTip').style.display = IS_FILE ? 'block' : 'none';
  helpModal.style.display='flex';
}
function closeHelp(){ helpModal.style.display='none'; }
document.getElementById('btnHelp').onclick=openHelp;
document.getElementById('helpClose').onclick=closeHelp;
document.getElementById('helpStart').onclick=()=>{
  if(document.getElementById('helpDontShow').checked) safeSet('throw_hide_help','1');
  closeHelp();
};
helpModal.addEventListener('click',e=>{ if(e.target===helpModal) closeHelp(); });

// First-run: show the guide unless the user opted out
if(!safeGet('throw_hide_help')) openHelp();

// Gentle one-time nudge toward Go Live when running from a local file
if(IS_FILE && !safeGet('throw_file_tip')){
  setTimeout(()=>{ toast('Tip: run start.bat to unlock the ⧉ Display projector tab'); }, 1200);
  safeSet('throw_file_tip','1');
}

// ── Test hooks ────────────────────────────────
// Read-only views over module state for tests/interaction.spec.js. `let`
// bindings aren't window properties, so the tests couldn't see them otherwise.
Object.defineProperty(window,'surfaces',{get:()=>surfaces});
Object.defineProperty(window,'selId',{get:()=>selId});
window.undo=undo; window.redo=redo; window.pushUndo=pushUndo;
Object.defineProperty(window,'undoDepth',{get:()=>_undo.length});
Object.defineProperty(window,'placePtsLen',{get:()=>placePts.length});
Object.defineProperty(window,'stageW',{get:()=>stageW});
Object.defineProperty(window,'stageH',{get:()=>stageH});
Object.defineProperty(window,'outputShowOutlines',{get:()=>outputShowOutlines});
Object.defineProperty(window,'handlesVisible',{get:()=>handlesVisible});
window.renderMain=renderMain;
window.addSurfaceForTest=addSurface;

// ── Keyboard semantics for the styled div/span controls ───────
// Front/Back/Copy/Delete/Media, Flatten/Center/Apply, the mesh grid, the
// trace-mode toggles and the two ✕ closers are visually buttons and were the
// last part of THROW with no keyboard path. They are static, so one pass at
// init is enough; click() reuses the handler already bound elsewhere.
for(const el of document.querySelectorAll('.mini,.dbtn,.mgbtn,.tm-btn,#errClose,#helpClose')){
  el.setAttribute('role','button');
  el.setAttribute('tabindex','0');
  el.addEventListener('keydown', e=>{
    if(e.key!=='Enter' && e.key!==' ') return;
    e.preventDefault(); e.stopPropagation();   // Space must not scroll, and must
    el.click();                                // not reach the global shortcuts
  });
}

// ── Init ──────────────────────────────────────
updateUI();
render();

// Roll-call for a display tab that was already open when this editor loaded
// (a reload, or opening the editor second). The display answers hello-display,
// which lights the ⧉ button and triggers the full state + media resend.
try{ bc.postMessage({type:'hello-editor'}); }catch(_){}
