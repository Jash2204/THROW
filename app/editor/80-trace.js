// ══════════════════════════════════════════════════════════════════
//  THROW editor · 80 — trace/place mode, the Display button, view toggles.
//  Trace fits a mesh to an outline, or clips it as a sticker (docs/NOTES.md §7c).
// ══════════════════════════════════════════════════════════════════
// ── Place Mode (ceiling fit / sticker mask) ───
let placeMode=false;
let placePts=[];
let traceMode='fit';   // 'fit' = warp mesh to outline · 'mask' = rectangular sticker clipped to outline
const placeOverlay=document.getElementById('placeOverlay');
const placeCanvas=document.getElementById('placeCanvas');
const pctx=placeCanvas.getContext('2d');
[document.getElementById('tmFit'), document.getElementById('tmMask')].forEach(btn=>{
  btn.onclick=()=>{
    traceMode=btn.dataset.mode;
    document.querySelectorAll('.tm-btn').forEach(b=>b.classList.toggle('active', b===btn));
  };
});

function enterPlaceMode(){
  placeMode=true; placePts=[];
  placeOverlay.classList.add('active');
  sizePlaceCanvas();
  drawPlaceCanvas();
}
function exitPlaceMode(confirm_){
  placeMode=false;
  placeOverlay.classList.remove('active');
  if(confirm_ && placePts.length>=3) fitSurfaceToPoints();
}
function sizePlaceCanvas(){
  const r=stageEl.getBoundingClientRect();
  // getBoundingClientRect is VIEWPORT-relative, but this canvas is positioned
  // absolutely inside #placeOverlay, which is itself absolutely positioned on
  // the stage wrap — so assigning r.left/r.top directly displaced the trace
  // surface by the overlay's own offset. Clicks then landed off the canvas and
  // traced shapes were built at the wrong stage coordinates. Subtract the
  // containing block's origin. (enterPlaceMode makes the overlay visible
  // before calling this, so its rect is real, not a display:none zero.)
  const o=placeOverlay.getBoundingClientRect();
  placeCanvas.style.position='absolute';
  placeCanvas.style.left=(r.left-o.left)+'px';
  placeCanvas.style.top=(r.top-o.top)+'px';
  // Back the canvas at device resolution but keep its CSS box (and therefore
  // every coordinate below, and placePts) in CSS pixels: the trace outline is
  // thin dashed line-work that was visibly soft on a HiDPI screen.
  const dpr=Math.max(1, window.devicePixelRatio||1);
  placeCanvas.style.width=r.width+'px';
  placeCanvas.style.height=r.height+'px';
  placeCanvas.width=Math.round(r.width*dpr);
  placeCanvas.height=Math.round(r.height*dpr);
  pctx.setTransform(dpr,0,0,dpr,0,0);
  placeCanvas._cssW=r.width; placeCanvas._cssH=r.height;
}

// Keep the trace overlay glued to the stage if the window changes mid-trace.
// placePts are CSS px on this canvas, and the canvas maps linearly onto the
// stage, so rescaling them by the size change preserves what they point at.
window.addEventListener('resize', ()=>{
  if(!placeMode) return;
  const oldW=placeCanvas._cssW||0, oldH=placeCanvas._cssH||0;
  sizePlaceCanvas();
  const newW=placeCanvas._cssW||0, newH=placeCanvas._cssH||0;
  if(oldW>0 && oldH>0 && (newW!==oldW || newH!==oldH)){
    const fx=newW/oldW, fy=newH/oldH;
    for(const p of placePts){ p.x*=fx; p.y*=fy; }
  }
  drawPlaceCanvas();
});
function drawPlaceCanvas(){
  // clear the full backing store regardless of the DPR transform in effect
  pctx.save(); pctx.setTransform(1,0,0,1,0,0);
  pctx.clearRect(0,0,placeCanvas.width,placeCanvas.height);
  pctx.restore();
  if(placePts.length===0) return;
  // Fill
  pctx.beginPath();
  pctx.moveTo(placePts[0].x,placePts[0].y);
  for(let i=1;i<placePts.length;i++) pctx.lineTo(placePts[i].x,placePts[i].y);
  pctx.closePath();
  pctx.fillStyle='rgba(255,176,32,0.1)';
  pctx.fill();
  pctx.strokeStyle='rgba(255,176,32,0.8)';
  pctx.lineWidth=2;
  pctx.setLineDash([6,3]);
  pctx.stroke();
  pctx.setLineDash([]);
  // Points
  placePts.forEach((p,i)=>{
    pctx.beginPath(); pctx.arc(p.x,p.y,7,0,Math.PI*2);
    pctx.fillStyle=i===0?'rgba(255,176,32,.9)':'rgba(255,255,255,.8)';
    pctx.fill();
    pctx.strokeStyle='rgba(0,0,0,.4)'; pctx.lineWidth=1.5; pctx.stroke();
    pctx.fillStyle='rgba(0,0,0,.8)'; pctx.font='bold 10px monospace';
    pctx.textAlign='center'; pctx.textBaseline='middle';
    pctx.fillText(i+1,p.x,p.y);
  });
}

placeCanvas.addEventListener('click', e=>{
  const r=placeCanvas.getBoundingClientRect();
  const px=e.clientX-r.left, py=e.clientY-r.top;
  // Close if clicking near first point
  if(placePts.length>=3){
    const d=dist(px,py,placePts[0].x,placePts[0].y);
    if(d<18){ exitPlaceMode(true); return; }
  }
  placePts.push({x:px,y:py});
  drawPlaceCanvas();
});
placeCanvas.addEventListener('contextmenu', e=>{
  e.preventDefault();
  if(placePts.length>=3) exitPlaceMode(true);
});

function fitSurfaceToPoints(){
  pushUndo();
  // Convert place canvas coords → stage coords
  const r=stageEl.getBoundingClientRect();
  const sc=stageScale();
  const stagePts=placePts.map(p=>({
    x:(p.x)/sc + 0,   // place canvas is positioned over stage exactly
    y:(p.y)/sc
  }));
  // use bounding box for mesh ref
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  stagePts.forEach(p=>{x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);x1=Math.max(x1,p.x);y1=Math.max(y1,p.y)});
  const w=x1-x0, h=y1-y0;

  const rows=currentMeshRows(), cols=currentMeshCols();

  if(traceMode==='mask'){
    // STICKER: rectangular mesh over the polygon's bounding box, media undistorted,
    // clipped to the traced outline. Store the polygon in mesh-UV so it warps with
    // the mesh — drag a corner and the whole sticker (outline included) stretches.
    const s=makeSurface(x0,y0,w,h,rows,cols);
    s.name='Sticker';
    s.mask=stagePts.map(p=>({
      u: w>0 ? Math.max(0,Math.min(1,(p.x-x0)/w)) : 0,
      v: h>0 ? Math.max(0,Math.min(1,(p.y-y0)/h)) : 0
    }));
    surfaces.push(s);
    selId=s.id;
    updateUI();
    toast('Sticker traced — drop media onto it, drag corners to place');
    return;
  }

  // FIT: build a surface whose mesh boundary follows the placed polygon.
  const s=makeSurface(x0,y0,w,h,rows,cols);
  s.name='Placed shape';
  if(stagePts.length>=4){
    applyPolygonToMeshBoundary(s, stagePts);
  } else if(stagePts.length===3){
    s.pts[0][0]={...stagePts[0]};
    s.pts[0][s.cols]={...stagePts[1]};
    s.pts[s.rows][s.cols]={...stagePts[2]};
    s.pts[s.rows][0]={x:(stagePts[0].x+stagePts[2].x)/2,y:(stagePts[0].y+stagePts[2].y)/2};
  }
  relaxInnerPoints(s);
  surfaces.push(s);
  selId=s.id;
  updateUI();
  toast('Surface fitted to shape! Drag inner points to fine-tune.');
}

function applyPolygonToMeshBoundary(s, poly){
  const N=poly.length;
  // Map the 4 corners of the mesh to the "cardinal" directions of the polygon
  // Simple: distribute polygon perimeter around the 4 edges of the mesh
  const perims=[];
  let total=0;
  for(let i=0;i<N;i++){
    const a=poly[i], b=poly[(i+1)%N];
    const d=dist(a.x,a.y,b.x,b.y);
    perims.push(d); total+=d;
  }
  // 4 edges of mesh: top, right, bottom, left
  // Sample points along polygon perimeter uniformly
  function samplePolyAt(t){
    let acc=0;
    for(let i=0;i<N;i++){
      const seg=perims[i]/total;
      if(t<=acc+seg){
        const u=(t-acc)/seg;
        const a=poly[i], b=poly[(i+1)%N];
        return {x:a.x+(b.x-a.x)*u, y:a.y+(b.y-a.y)*u};
      }
      acc+=seg;
    }
    return poly[0];
  }
  // top edge: t from 0 to 0.25
  for(let c=0;c<=s.cols;c++){
    const t=(c/s.cols)*0.25;
    Object.assign(s.pts[0][c], samplePolyAt(t));
  }
  // right edge: t from 0.25 to 0.5
  for(let r=0;r<=s.rows;r++){
    const t=0.25+(r/s.rows)*0.25;
    Object.assign(s.pts[r][s.cols], samplePolyAt(t));
  }
  // bottom edge (reversed): t from 0.5 to 0.75
  for(let c=0;c<=s.cols;c++){
    const t=0.5+((s.cols-c)/s.cols)*0.25;
    Object.assign(s.pts[s.rows][c], samplePolyAt(t));
  }
  // left edge (reversed): t from 0.75 to 1.0
  for(let r=0;r<=s.rows;r++){
    const t=0.75+((s.rows-r)/s.rows)*0.25;
    Object.assign(s.pts[r][0], samplePolyAt(t));
  }
}

function relaxInnerPoints(s){
  // Set interior points as bilinear blend of boundary
  for(let r=1;r<s.rows;r++){
    for(let c=1;c<s.cols;c++){
      const u=c/s.cols, v=r/s.rows;
      // Transfinite interpolation (Gordon-Coons patch)
      const top=lerp2(s.pts[0][0],s.pts[0][s.cols],u);
      const bot=lerp2(s.pts[s.rows][0],s.pts[s.rows][s.cols],u);
      const lft=lerp2(s.pts[0][0],s.pts[s.rows][0],v);
      const rgt=lerp2(s.pts[0][s.cols],s.pts[s.rows][s.cols],v);
      const bl=lerp2(lerp2(s.pts[0][0],s.pts[0][s.cols],u),lerp2(s.pts[s.rows][0],s.pts[s.rows][s.cols],u),v);
      s.pts[r][c]={
        x: lft.x*(1-u)+rgt.x*u + top.x*(1-v)+bot.x*v - bl.x,
        y: lft.y*(1-u)+rgt.y*u + top.y*(1-v)+bot.y*v - bl.y,
      };
    }
  }
}
function lerp2(a,b,t){ return {x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t} }

document.getElementById('btnPlace').onclick=()=>enterPlaceMode();

// ── Display tab ───────────────────────────────
// Opens display.html in a NEW TAB (same origin over localhost). The display
// renders itself from BroadcastChannel state and owns its own video
// elements — fullscreen it on the projector and keep editing here.
const btnOutputEl=document.getElementById('btnOutput');
btnOutputEl.onclick=openDisplay;
function openDisplay(){
  if(IS_FILE){
    showError('The Display tab needs the local server',
      'double-click start.bat (or run: python -m http.server 8420), then open http://localhost:8420/THROW.html');
    return;
  }
  const w=window.open('display.html','THROW_DISPLAY');
  if(!w){ showError('The Display tab was blocked','allow pop-ups for THROW (one-time browser prompt), then click ⧉ Display again'); return; }
  toast('Display tab open — fullscreen it on the projector; edits sync live');
}

// ── Outlines toggle ───────────────────────────
const btnOutlines=document.getElementById('btnOutlines');
function setOutlines(on){
  outputShowOutlines=on;
  touchState();
  btnOutlines.classList.toggle('active', on);
  toast(on?'Outlines ON \u2014 surface footprints show on the projector':'Outlines OFF \u2014 clean projection');
}
btnOutlines.onclick=()=>setOutlines(!outputShowOutlines);

// ── Handles toggle (editor only) ──────────────
const btnHandles=document.getElementById('btnHandles');
function setHandles(on){
  handlesVisible=on;
  btnHandles.classList.toggle('active', on);
  toast(on?'Handles ON':'Handles hidden — drags move whole surfaces (H to show)');
}
btnHandles.onclick=()=>setHandles(!handlesVisible);

document.getElementById('btnCenter').onclick=()=>recenterSel();

