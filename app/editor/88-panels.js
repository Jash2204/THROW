// ══════════════════════════════════════════════════════════════════
//  THROW editor · 88 — the inspector panels: adjust, crop, trim, transcode,
//  playlist. Colour applies at composite time so sliders never re-warp.
// ══════════════════════════════════════════════════════════════════
// ── Adjust panel ──────────────────────────────
// Per-surface colour adjustments + flips. Colour applies at composite time
// (editor: canvas filter; display: GL uniforms) so sliders never re-warp.
const DEF_ADJUST={br:1, ct:1, sat:1, hue:0, flipH:false, flipV:false};
const DEF_CROP={x:0, y:0, w:1, h:1};   // full source frame (normalised)
// Edits land on the SELECTED PLAYLIST ITEM (adjustTarget), so two clips on one
// surface can look completely different — and a crossfade keeps each one's look.
function adjustOf(s){ return adjustTarget(s); }
function bindAdjust(sliderId, labelId, prop, toVal, toLabel){
  const el=document.getElementById(sliderId), lbl=document.getElementById(labelId);
  el.oninput=function(){
    beginGesture();
    lbl.textContent=toLabel(this.value);
    const s=surfaces.find(s=>s.id===selId);
    const a=adjustOf(s);
    if(a) a[prop]=toVal(this.value);
  };
}
bindAdjust('adjBr','lblBr','br',   v=>v/100, v=>v);
bindAdjust('adjCt','lblCt','ct',   v=>v/100, v=>v);
bindAdjust('adjSat','lblSat','sat',v=>v/100, v=>v);
bindAdjust('adjHue','lblHue','hue',v=>+v,    v=>v+'°');
['rngOpacity','adjBr','adjCt','adjSat','adjHue','rngScale','rngXfDur','rngImgDur'].forEach(id=>{
  document.getElementById(id).addEventListener('change', endGesture);
});

const btnFlipH=document.getElementById('btnFlipH');
const btnFlipV=document.getElementById('btnFlipV');
btnFlipH.onclick=()=>{
  const s=surfaces.find(s=>s.id===selId); if(!s){ toast('Select a surface first'); return; }
  pushUndo(); const a=adjustOf(s); a.flipH=!a.flipH; updateUI();
};
btnFlipV.onclick=()=>{
  const s=surfaces.find(s=>s.id===selId); if(!s){ toast('Select a surface first'); return; }
  pushUndo(); const a=adjustOf(s); a.flipV=!a.flipV; updateUI();
};
document.getElementById('btnAdjReset').onclick=()=>{
  const s=surfaces.find(s=>s.id===selId); if(!s){ toast('Select a surface first'); return; }
  pushUndo();
  const it=selItem(s);
  if(it) it.adjust={...DEF_ADJUST}; else s.adjust={...DEF_ADJUST};
  updateUI(); toast(it?'Reset: '+(it.name||'item'):'Adjustments reset');
};

// ── Crop panel ────────────────────────────────
// Like ADJUST, crop targets the SELECTED ITEM (or the surface seed with no
// media). Stored normalised 0..1; the UI works in %.
function cropTargetOf(s){
  if(!s) return null;
  const it=selItem(s);
  if(it){ if(!it.crop) it.crop={...DEF_CROP}; return it.crop; }
  if(!s.cropSeed) s.cropSeed={...DEF_CROP};
  return s.cropSeed;
}
const cropX=document.getElementById('cropX'), cropY=document.getElementById('cropY');
const cropW=document.getElementById('cropW'), cropH=document.getElementById('cropH');
function readCropUI(){
  // clamp so the rect stays inside the source (x+w ≤ 100)
  let x=Math.max(0,Math.min(99, +cropX.value||0));
  let y=Math.max(0,Math.min(99, +cropY.value||0));
  let w=Math.max(1,Math.min(100, +cropW.value||100));
  let h=Math.max(1,Math.min(100, +cropH.value||100));
  if(x+w>100) w=100-x;
  if(y+h>100) h=100-y;
  return {x:x/100, y:y/100, w:w/100, h:h/100};
}
function applyCropFromUI(){
  const s=surfaces.find(s=>s.id===selId);
  if(!s){ syncCropUI(); toast('Select a surface first'); return; }
  const c=cropTargetOf(s);
  const nc=readCropUI();
  Object.assign(c, nc);
  syncCropUI();   // reflect any clamping
}
[cropX,cropY,cropW,cropH].forEach(inp=>{
  inp.addEventListener('focus', ()=>{ beginGesture(); });
  inp.addEventListener('input', applyCropFromUI);
  inp.addEventListener('change', ()=>{ applyCropFromUI(); endGesture(); });
});
document.getElementById('btnCropSquare').onclick=()=>{
  const s=surfaces.find(s=>s.id===selId); if(!s){ toast('Select a surface first'); return; }
  pushUndo();
  // largest centred square in the SOURCE aspect (based on the previewed media)
  const el=s.media && editorEl(s.media);
  const mw=(el&&(el.videoWidth||el.naturalWidth||el.width))||1;
  const mh=(el&&(el.videoHeight||el.naturalHeight||el.height))||1;
  const c=cropTargetOf(s);
  if(mw>=mh){ const w=mh/mw; Object.assign(c,{x:(1-w)/2,y:0,w:w,h:1}); }
  else{ const h=mw/mh; Object.assign(c,{x:0,y:(1-h)/2,w:1,h:h}); }
  updateUI(); toast('Square crop');
};
document.getElementById('btnCropReset').onclick=()=>{
  const s=surfaces.find(s=>s.id===selId); if(!s){ toast('Select a surface first'); return; }
  pushUndo();
  Object.assign(cropTargetOf(s), DEF_CROP);
  updateUI(); toast('Full frame');
};
function syncCropUI(){
  const s=surfaces.find(s=>s.id===selId);
  const c=cropTargetOf(s) || DEF_CROP;
  cropX.value=Math.round(c.x*100); cropY.value=Math.round(c.y*100);
  cropW.value=Math.round(c.w*100); cropH.value=Math.round(c.h*100);
  const it=selItem(s);
  const tgt=document.getElementById('cropTarget');
  tgt.textContent = it ? (it.name||'ITEM') : 'SURFACE';
}

// ── Trim (video items only) ───────────────────
const trimInEl=document.getElementById('trimIn'), trimOutEl=document.getElementById('trimOut');
function applyTrimFromUI(){
  const s=surfaces.find(s=>s.id===selId); const it=selItem(s);
  if(!it || it.kind!=='video') return;
  it.trimIn=Math.max(0, +trimInEl.value||0);
  it.trimOut=Math.max(0, +trimOutEl.value||0);
}
[trimInEl,trimOutEl].forEach(inp=>{
  inp.addEventListener('focus', ()=>beginGesture());
  inp.addEventListener('input', applyTrimFromUI);
  inp.addEventListener('change', ()=>{ applyTrimFromUI(); endGesture(); });
});
function syncTrimUI(){
  const s=surfaces.find(s=>s.id===selId); const it=selItem(s);
  const row=document.getElementById('trimRow');
  if(it && it.kind==='video'){
    row.style.display='block';
    document.getElementById('trimName').textContent=it.name||'clip';
    trimInEl.value=it.trimIn||0; trimOutEl.value=it.trimOut||0;
    const hint=document.getElementById('downscaleHint');
    if(it._srcH && it._srcH>1140){
      hint.style.display='block';
      hint.textContent='Source is '+it._srcH+'p — larger than a 1080p projector can show. Downscaling makes multi-clip playback much smoother.';
    } else hint.style.display='none';
  } else {
    row.style.display='none';
  }
}

// ── Transcode on import (native MediaRecorder — zero deps) ────────
// The honest fix for 4K/120fps stutter: a hardware decode block is ~4K60 per
// stream, so oversized clips fall back to software decode. Re-encoding at the
// projector's resolution removes quality that physically can't reach the wall
// anyway. This plays the source through ONCE, drawing each frame into a
// target-size canvas whose captureStream() feeds a WebM recorder.
function transcodeVideo(file, targetH, onProgress){
  return new Promise((resolve, reject)=>{
    if(typeof MediaRecorder==='undefined'){ reject(new Error('this browser has no MediaRecorder')); return; }
    const url=typedBlobURL(file, true);
    const v=document.createElement('video');
    v.muted=true; v.playsInline=true; v.preload='auto';
    let raf=0, settled=false, wasHidden=false, hideCleanup=null;
    const cleanup=()=>{ try{ cancelAnimationFrame(raf); }catch(_){}
      try{ if(hideCleanup) hideCleanup(); }catch(_){}
      try{ v.pause(); v.removeAttribute('src'); v.load(); }catch(_){}
      try{ URL.revokeObjectURL(url); }catch(_){} };
    const fail=(e)=>{ if(settled) return; settled=true; cleanup(); reject(e instanceof Error?e:new Error(String(e))); };
    v.addEventListener('error', ()=>fail(new Error(mediaErrText(v.error?v.error.code:0))));
    v.addEventListener('loadedmetadata', ()=>{
      const sw=v.videoWidth, sh=v.videoHeight, dur=v.duration||0;
      if(!sw||!sh){ fail(new Error('could not read the video dimensions')); return; }
      const scale=Math.min(1, targetH/sh);
      const tw=Math.max(2, Math.round(sw*scale/2)*2), th=Math.max(2, Math.round(sh*scale/2)*2);
      const cv=document.createElement('canvas'); cv.width=tw; cv.height=th;
      const g=cv.getContext('2d'); g.imageSmoothingQuality='high';
      let rec, chunks=[];
      try{
        const stream=cv.captureStream(30);
        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9'
                   : MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
        rec=new MediaRecorder(stream, {mimeType:mime, videoBitsPerSecond:8000000});
      }catch(err){ fail(new Error('recording not supported: '+err.message)); return; }
      rec.ondataavailable=e=>{ if(e.data&&e.data.size) chunks.push(e.data); };
      rec.onstop=()=>{ if(settled) return; settled=true; cleanup();
        chunks.length ? resolve({blob:new Blob(chunks,{type:'video/webm'}), wasHidden}) : reject(new Error('no frames captured')); };
      rec.onerror=()=>fail(new Error('the recorder failed'));
      // requestAnimationFrame stops in a hidden tab, so nothing gets drawn into
      // the recorded canvas while the user is away — but MediaRecorder keeps
      // recording, producing a clip frozen on one frame. We cannot fix that
      // (rAF throttling is the browser's call); we CAN refuse to hand back a
      // silently broken file, so track it and let the caller tell the truth.
      const onHide=()=>{ if(document.hidden) wasHidden=true; };
      document.addEventListener('visibilitychange', onHide);
      hideCleanup=()=>document.removeEventListener('visibilitychange', onHide);
      if(document.hidden) wasHidden=true;
      const loop=()=>{
        if(settled) return;
        try{ g.drawImage(v,0,0,tw,th); }catch(_){}
        if(onProgress && dur) onProgress(Math.min(0.999, v.currentTime/dur));
        raf=requestAnimationFrame(loop);
      };
      v.addEventListener('ended', ()=>{ cancelAnimationFrame(raf); try{ rec.stop(); }catch(_){ fail(new Error('could not finish encoding')); } });
      try{ rec.start(); }catch(err){ fail(err); return; }
      v.play().then(loop).catch(fail);
    });
    v.src=url;
  });
}

let _transcoding=false;
document.getElementById('btnDownscale').onclick=async ()=>{
  if(_transcoding){ toast('Already transcoding…'); return; }
  const s=surfaces.find(s=>s.id===selId); const it=selItem(s);
  if(!it || it.kind!=='video' || !it.file){ toast('Select a video clip first'); return; }
  const targetH=Math.min(1080, stageH||1080);
  const nm=it.name||'clip';
  _transcoding=true;
  const btn=document.getElementById('btnDownscale');
  btn.textContent='Transcoding… 0%';
  try{
    toast('Transcoding is real time — keep this tab visible until it finishes', 3000);
    const {blob, wasHidden}=await transcodeVideo(it.file, targetH, p=>{ btn.textContent='Transcoding… '+Math.round(p*100)+'%'; });
    if(wasHidden){
      // Frames are captured by requestAnimationFrame, which a hidden tab stops.
      // The recording still ran, so the file exists and looks fine in the list
      // while being frozen on one frame. Say so instead of quietly swapping it in.
      showError('Transcode abandoned: the tab was hidden while “'+nm+'” was encoding',
        'frame capture pauses in a background tab, so the result would be frozen — the original clip is untouched; run it again and leave this tab visible');
      return;
    }
    pushUndo();
    it.file=new File([blob], nm.replace(/\.[^.]+$/,'')+'_'+targetH+'p.webm', {type:'video/webm'});
    it._thumb=null; it._sent=false; it._sniffed=true; it._srcH=targetH;
    if(s.media && s.media.item===it) buildEditorMedia(s, it);
    bcSendPlaylist(s, true);
    updateUI();
    toast('Downscaled '+nm+' to '+targetH+'p — smaller & smoother');
  }catch(err){
    showError('Couldn’t transcode '+nm, err.message);
  }finally{
    _transcoding=false;
    btn.textContent='⤓ Downscale to 1080p';
  }
};

// ── Playlist panel ────────────────────────────
const selTransition=document.getElementById('selTransition');
const rngXfDur=document.getElementById('rngXfDur');
const rngImgDur=document.getElementById('rngImgDur');
selTransition.onchange=function(){
  const s=surfaces.find(s=>s.id===selId); if(!s) return;
  pushUndo(); playlistOf(s).transition=this.value;
  syncPlaylistUI();
};
rngXfDur.oninput=function(){
  beginGesture();
  const v=this.value/10;
  document.getElementById('lblXfDur').textContent=v.toFixed(1)+'s';
  const s=surfaces.find(s=>s.id===selId); if(s) playlistOf(s).xfDur=v;
};
rngImgDur.oninput=function(){
  beginGesture();
  document.getElementById('lblImgDur').textContent=this.value+'s';
  const s=surfaces.find(s=>s.id===selId); if(s) playlistOf(s).imgDur=+this.value;
};

function syncPlaylistUI(){
  const s=surfaces.find(s=>s.id===selId);
  const pl=(s && s.playlist) ? s.playlist : null;
  const list=document.getElementById('plList');
  list.textContent='';
  const cur=selItem(s);
  if(pl && pl.items.length){
    pl.items.forEach((it,i)=>{
      // item 0 is where the display starts (cyan); the selected row is the one
      // the stage is previewing and ADJUST is editing (acid)
      const row=document.createElement('div');
      row.className='pl-row'+(i===0?' first':'')+((cur&&cur.id===it.id)?' sel':'');
      row.title='Click to preview this item and edit its look';
      asButton(row, 'Preview '+(it.name||'item'), (e)=>{
        if(e.target.classList.contains('pl-btn')) return;
        selectPlItem(s, it.id);
      });
      const idx=document.createElement('span'); idx.className='pl-idx';
      idx.textContent=String(i+1).padStart(2,'0');
      const gl=document.createElement('span'); gl.className='pl-glyph';
      gl.textContent=(it.kind==='video')?'▶':'▦';
      const nm=document.createElement('span'); nm.className='pl-name';
      nm.textContent=it.name||'media';
      nm.title=it.name||'media';
      const ctrls=document.createElement('span'); ctrls.className='pl-ctrls';
      const up=document.createElement('span'); up.className='pl-btn'; up.textContent='↑'; up.title='Move earlier';
      const dn=document.createElement('span'); dn.className='pl-btn'; dn.textContent='↓'; dn.title='Move later';
      const rm=document.createElement('span'); rm.className='pl-btn rm'; rm.textContent='×'; rm.title='Remove from playlist';
      asButton(up, 'Move '+(it.name||'item')+' earlier', (ev)=>{ ev.stopPropagation(); plMoveItem(s,i,-1); });
      asButton(dn, 'Move '+(it.name||'item')+' later',   (ev)=>{ ev.stopPropagation(); plMoveItem(s,i,1); });
      asButton(rm, 'Remove '+(it.name||'item'),            (ev)=>{ ev.stopPropagation(); plRemoveItem(s,i); });
      ctrls.append(up,dn,rm);
      row.append(idx,gl,nm,ctrls);
      list.appendChild(row);
    });
  } else {
    const e=document.createElement('div'); e.className='pl-empty';
    e.textContent=s?'No media — drop a file or ＋ Add':'Select a surface';
    list.appendChild(e);
  }
  const cfg=pl||{transition:'cut',xfDur:1,imgDur:8};
  document.getElementById('plTransLabel').textContent=
    (cfg.transition==='fadeblack'?'FADE TO BLACK':cfg.transition.toUpperCase());
  selTransition.value=cfg.transition;
  rngXfDur.value=Math.round(cfg.xfDur*10);
  document.getElementById('lblXfDur').textContent=cfg.xfDur.toFixed(1)+'s';
  document.getElementById('rowXfDur').style.display=(cfg.transition==='cut')?'none':'flex';
  rngImgDur.value=cfg.imgDur;
  document.getElementById('lblImgDur').textContent=cfg.imgDur+'s';
  // duration rows only matter with 2+ items, transitions too
  document.getElementById('rowImgDur').style.display=(pl && pl.items.some(it=>it.kind!=='video'))?'flex':'none';
}

// reflect the selected surface's adjustments in the panel
function syncAdjustUI(){
  const s=surfaces.find(s=>s.id===selId);
  const a=adjustTarget(s) || DEF_ADJUST;
  // say plainly what these sliders are about to change
  const it=selItem(s);
  const tgt=document.getElementById('adjTarget');
  tgt.textContent = it ? (it.name||'ITEM') : 'SURFACE';
  tgt.title = it ? 'Editing this playlist item’s look' : 'No media — this is the surface default, inherited by clips you add';
  document.getElementById('adjBr').value=Math.round(a.br*100);
  document.getElementById('lblBr').textContent=Math.round(a.br*100);
  document.getElementById('adjCt').value=Math.round(a.ct*100);
  document.getElementById('lblCt').textContent=Math.round(a.ct*100);
  document.getElementById('adjSat').value=Math.round(a.sat*100);
  document.getElementById('lblSat').textContent=Math.round(a.sat*100);
  document.getElementById('adjHue').value=a.hue||0;
  document.getElementById('lblHue').textContent=(a.hue||0)+'°';
  btnFlipH.classList.toggle('active', !!a.flipH);
  btnFlipV.classList.toggle('active', !!a.flipV);
}

window.addEventListener('beforeunload',()=>{ try{ bc.postMessage({type:'editor-bye'}); }catch(_){} });

