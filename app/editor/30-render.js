// ══════════════════════════════════════════════════════════════════
//  THROW editor · 30 — editor rendering, the rAF loop, handles, hit testing.
//  Thumbnails only; the display tab owns video playback (docs/NOTES.md §5).
// ══════════════════════════════════════════════════════════════════
// ── Editor rendering ──────────────────────────
// The editor draws THUMBNAILS only (videos never play here — the Display tab
// owns playback). shared.js provides the warp renderer and placeholder.
function editorEl(m){ return m.animCanvas || m.thumb || m.el || null; }
// The look for whatever the editor is previewing: the previewed playlist item's,
// falling back to the surface default for media-less surfaces.
function editorAdjust(s){
  return (s.media && s.media.item && s.media.item.adjust) || s.adjust || DEF_ADJUST;
}
function editorCrop(s){
  return (s.media && s.media.item && s.media.item.crop) || null;
}

function mediaReady(s){
  const m=s.media; if(!m) return false;
  const el=editorEl(m); if(!el) return false;
  if(el.tagName==='CANVAS') return el.width>0 && el.height>0;
  if(el.tagName==='VIDEO')  return false;   // editor never draws video elements
  return el.complete && el.naturalWidth>0;
}

function clipToMask(dst, s){
  const mp = s.mask && maskStagePts(s);
  if(!mp) return false;
  dst.save();
  dst.beginPath();
  dst.moveTo(mp[0].x,mp[0].y);
  for(let i=1;i<mp.length;i++) dst.lineTo(mp[i].x,mp[i].y);
  dst.closePath(); dst.clip();
  return true;
}

function renderSurface(s, target){
  if(!s.visible) return;
  const dst = target || ctx;
  if(!mediaReady(s)){
    // clip the calibration target to the sticker shape so an empty sticker
    // still reads as its outline, not a full rectangle
    const clipped=clipToMask(dst, s);
    drawPlaceholderTo(dst, s);
    if(clipped) dst.restore();
    return;
  }
  const el = editorEl(s.media);
  const adj = editorAdjust(s);
  const crop = editorCrop(s);
  if(s.media.animCanvas){
    // animated frames change every tick — caching would be a lie
    renderSurfaceTo(dst, s, el, stageW, stageH, adj, crop);
    return;
  }
  // Static media (image thumbs, video poster frames): re-warp only when the
  // mesh/stage/media/flips/crop actually change. Blend, opacity and colour apply
  // at composite time, so those sliders never trigger a re-warp.
  const key = warpKey(s, el, stageW, stageH, adj, crop);
  if(s._warpKey !== key){
    if(!s._warpBuf) s._warpBuf = document.createElement('canvas');
    warpInto(s._warpBuf, s, el, stageW, stageH, adj, crop);
    s._warpKey = key;
  }
  compositeSurface(dst, s._warpBuf, s, adj);
}

// ── Render loop ───────────────────────────────
let raf;
let _renderErrShown = false;

function renderMain(){
  ctx.clearRect(0,0,stageW,stageH);
  for(const s of surfaces){
    try{
      renderSurface(s, ctx);
    }catch(err){
      // one broken surface must never blank the whole show
      if(!_renderErrShown){
        showError('A surface failed to render and was skipped', err.message);
        _renderErrShown=true;
      }
    }
  }
}

function render(){
  try{
    renderMain();
    drawHandles();
    broadcastState();   // geometry/outlines diff → Display tab
  }catch(err){
    showError('Render loop hiccup (recovering)', err.message);
  }
  raf=requestAnimationFrame(render);  // ALWAYS reschedule — loop can't die
}

function drawHandles(){
  ictx.clearRect(0,0,stageW,stageH);
  if(!handlesVisible) return;   // H toggle: clean view of the media, body-drag still moves surfaces
  const inv = 1/Math.max(0.0001, stageScale());  // keep handles a constant on-screen size
  for(const s of surfaces){
    if(!s.visible) continue;
    const isSel=(s.id===selId);

    // Mesh grid — bright acid-green so it reads as a calibration overlay
    ictx.strokeStyle=isSel?'rgba(196,255,46,0.65)':'rgba(196,255,46,0.18)';
    ictx.lineWidth=(isSel?1.4:0.8)*inv;
    for(let r=0;r<=s.rows;r++){
      ictx.beginPath();
      ictx.moveTo(s.pts[r][0].x, s.pts[r][0].y);
      for(let c=1;c<=s.cols;c++) ictx.lineTo(s.pts[r][c].x, s.pts[r][c].y);
      ictx.stroke();
    }
    for(let c=0;c<=s.cols;c++){
      ictx.beginPath();
      ictx.moveTo(s.pts[0][c].x, s.pts[0][c].y);
      for(let r=1;r<=s.rows;r++) ictx.lineTo(s.pts[r][c].x, s.pts[r][c].y);
      ictx.stroke();
    }

    if(!isSel) continue;

    // Control handles — large, glowing, with crosshairs so they're easy to grab
    // even on a bright projected surface with overscan. Their preferred size is
    // constant ON-SCREEN, but on dense meshes or a small editor window that
    // would make neighbouring handles overlap and bury the media — so cap them
    // at a fraction of the smallest gap between adjacent mesh points.
    let minGap=Infinity;
    for(let r=0;r<=s.rows;r++){
      for(let c=0;c<=s.cols;c++){
        const p=s.pts[r][c];
        if(c<s.cols) minGap=Math.min(minGap, dist(p.x,p.y,s.pts[r][c+1].x,s.pts[r][c+1].y));
        if(r<s.rows) minGap=Math.min(minGap, dist(p.x,p.y,s.pts[r+1][c].x,s.pts[r+1][c].y));
      }
    }
    const R    = Math.min(13*inv, minGap*0.18);   // inner dot radius (≤26px on screen)
    const RING = Math.min(22*inv, minGap*0.32);   // outer ring radius (≤44px target)
    for(let r=0;r<=s.rows;r++){
      for(let c=0;c<=s.cols;c++){
        const p=s.pts[r][c];
        const isCorner=(r===0||r===s.rows)&&(c===0||c===s.cols);
        const col = isCorner ? '#c4ff2e' : '#27e0c8';

        // glow (capped with the handle so halos don't merge on dense meshes)
        ictx.save();
        ictx.shadowColor=col; ictx.shadowBlur=Math.min(14*inv, RING);
        // crosshair
        ictx.strokeStyle=col; ictx.lineWidth=1.5*inv; ictx.globalAlpha=0.9;
        ictx.beginPath();
        ictx.moveTo(p.x-RING, p.y); ictx.lineTo(p.x+RING, p.y);
        ictx.moveTo(p.x, p.y-RING); ictx.lineTo(p.x, p.y+RING);
        ictx.stroke();
        // outer ring
        ictx.globalAlpha=0.55;
        ictx.beginPath(); ictx.arc(p.x,p.y,RING,0,Math.PI*2); ictx.stroke();
        ictx.restore();

        // solid centre
        ictx.beginPath();
        if(isCorner){
          ictx.save(); ictx.translate(p.x,p.y); ictx.rotate(Math.PI/4);
          ictx.rect(-R,-R,R*2,R*2); ictx.restore();
        } else {
          ictx.arc(p.x,p.y,R,0,Math.PI*2);
        }
        ictx.fillStyle=col; ictx.fill();
        ictx.strokeStyle='rgba(0,0,0,.7)'; ictx.lineWidth=2*inv; ictx.stroke();
      }
    }

    // Center move-handle (same overlap cap — on odd meshes it sits on an inner point)
    const CR=Math.min(18*inv, minGap*0.42);
    const ctr=surfaceCenter(s);
    ictx.save();
    ictx.shadowColor='#c4ff2e'; ictx.shadowBlur=Math.min(12*inv, CR);
    ictx.beginPath(); ictx.arc(ctr.x,ctr.y,CR,0,Math.PI*2);
    ictx.fillStyle='rgba(196,255,46,.18)'; ictx.fill();
    ictx.strokeStyle='rgba(196,255,46,.8)'; ictx.lineWidth=2*inv; ictx.stroke();
    ictx.restore();
    ictx.fillStyle='#c4ff2e';
    ictx.font='bold '+(CR*1.2)+'px monospace';
    ictx.textAlign='center'; ictx.textBaseline='middle';
    ictx.fillText('\u271B',ctr.x,ctr.y+inv);
  }
}

// ── Hit testing ───────────────────────────────
// (outline drawing now lives in shared.js drawOutlinesTo — used by the Display tab)
function hitHandle(sx,sy){
  const s=surfaces.find(s=>s.id===selId);
  if(!s) return null;
  const sc=stageScale();
  const hr=24/sc;  // generous, matches the larger handles
  // 1) Corners win — they're the primary warp handles and must stay grabbable.
  const corners=[[0,0],[0,s.cols],[s.rows,0],[s.rows,s.cols]];
  for(const [r,c] of corners){
    const p=s.pts[r][c];
    if(dist(sx,sy,p.x,p.y)<hr) return {surfId:s.id,type:'ctrl',r,c};
  }
  // 2) The centre grab MOVES the whole surface. Checking it BEFORE the inner
  //    points means that on odd meshes (3×3, 5×5…), where a control point sits
  //    exactly on the centre, grabbing the middle translates instead of
  //    deforming — which is the whole point of the ✛ handle.
  const ctr=surfaceCenter(s);
  if(dist(sx,sy,ctr.x,ctr.y)<hr) return {surfId:s.id,type:'center'};
  // 3) Remaining inner control points (fine warping).
  for(let r=0;r<=s.rows;r++){
    for(let c=0;c<=s.cols;c++){
      if((r===0||r===s.rows)&&(c===0||c===s.cols)) continue; // corners handled above
      const p=s.pts[r][c];
      if(dist(sx,sy,p.x,p.y)<hr) return {surfId:s.id,type:'ctrl',r,c};
    }
  }
  return null;
}

function hitSurface(sx,sy){
  // Find topmost surface containing point (reverse order = top first)
  for(let i=surfaces.length-1;i>=0;i--){
    const s=surfaces[i];
    if(!s.visible) continue;
    if(pointInSurface(s,sx,sy)) return s.id;
  }
  return null;
}

// (pointInSurface / pointInQuad / dist come from shared.js)

