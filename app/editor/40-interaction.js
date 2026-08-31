// ══════════════════════════════════════════════════════════════════
//  THROW editor · 40 — pointer interaction on the stage and file drop.
//  Hit priority corners -> centre -> inner points (docs/NOTES.md §7).
// ══════════════════════════════════════════════════════════════════
// ── Interaction ───────────────────────────────
// Distinguish a click (select / load) from a real drag, so body-dragging a
// surface to move it never gets confused with a tap.
let pressMoved=false;
IC.addEventListener('pointerdown', e=>{
  if(placeMode) return;
  // preventDefault below suppresses the browser's own focus change, so a
  // dropdown left focused would keep swallowing every keyboard shortcut after
  // the user clicked back onto the stage — shortcuts dead with no visible
  // cause. Hand focus back to the stage explicitly.
  const ae=document.activeElement;
  if(ae && ae!==document.body && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) ae.blur();
  e.preventDefault();
  IC.setPointerCapture(e.pointerId);
  pressMoved=false;
  const {x,y}=clientToStage(e.clientX,e.clientY);
  // Hidden handles are not grabbable — an invisible corner-drag would warp the
  // mesh with no visual cause. With handles off, any drag moves the whole surface.
  const h=handlesVisible ? hitHandle(x,y) : null;
  if(h){
    dragHandle=h;
    dragOffset={x,y};
    return;
  }
  // No handle under the cursor. Find a surface body.
  const id=hitSurface(x,y);
  if(id){
    // Select it, then arm a WHOLE-SURFACE move. Dragging anywhere on the body
    // translates every control point together — the mesh keeps its exact shape
    // and never deforms, which the small center handle couldn't guarantee when
    // it overlapped a mesh point.
    selId=id; updateUI();
    dragHandle={surfId:id, type:'body'};
    dragOffset={x,y};
  } else {
    selId=null; updateUI();
  }
});

IC.addEventListener('pointermove', e=>{
  const {x,y}=clientToStage(e.clientX,e.clientY);
  // Hover feedback: show a move cursor over a selected surface's body.
  if(!dragHandle){
    if(selId && hitSurface(x,y)===selId && (!handlesVisible || !hitHandle(x,y))) IC.style.cursor='move';
    else IC.style.cursor='crosshair';
    return;
  }
  pressMoved=true;
  const s=surfaces.find(s=>s.id===dragHandle.surfId);
  if(!s) return;
  beginGesture();
  touchState();   // geometry changes here bypass input/change entirely
  if(dragHandle.type==='center' || dragHandle.type==='body'){
    // Rigid translate of the entire surface — no deformation.
    const dx=x-dragOffset.x, dy=y-dragOffset.y;
    for(let r=0;r<=s.rows;r++) for(let c=0;c<=s.cols;c++){
      s.pts[r][c].x+=dx; s.pts[r][c].y+=dy;
    }
    dragOffset={x,y};
  } else {
    s.pts[dragHandle.r][dragHandle.c]={x,y};
  }
});

IC.addEventListener('pointerup', e=>{
  dragHandle=null;
  endGesture();
  try{ IC.releasePointerCapture(e.pointerId); }catch(_){}
});

// Double-click to load media (kept). A double-click never moves the surface
// because no drag occurs between presses.
IC.addEventListener('dblclick', e=>{
  if(placeMode) return;
  const {x,y}=clientToStage(e.clientX,e.clientY);
  const id=hitSurface(x,y);
  if(id){ selId=id; updateUI(); document.getElementById('mediaLoad').click(); }
});

// ── Drag & Drop media ─────────────────────────
stageWrap.addEventListener('dragover', e=>{e.preventDefault();stageWrap.classList.add('drag-over')});
stageWrap.addEventListener('dragleave',()=>stageWrap.classList.remove('drag-over'));
stageWrap.addEventListener('drop', e=>{
  e.preventDefault();
  stageWrap.classList.remove('drag-over');
  const file=e.dataTransfer.files[0];
  if(!file) return;
  const {x,y}=clientToStage(e.clientX,e.clientY);
  let target=hitSurface(x,y);
  if(!target){
    // Auto-create if dropped on empty canvas
    const ns=makeSurface(x-120,y-80,240,160);
    surfaces.push(ns);
    target=ns.id;
  }
  loadMediaToSurface(surfaces.find(s=>s.id===target), file);
  selId=target; updateUI();
});

