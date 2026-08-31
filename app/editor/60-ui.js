// ══════════════════════════════════════════════════════════════════
//  THROW editor · 60 — mesh selector, layer rail, inspector, stage sizing.
//  updateUI() rebuilds the rails and is the funnel every discrete edit goes through.
// ══════════════════════════════════════════════════════════════════
// ── Mesh point selector ───────────────────────
function currentMeshRows(){ return parseInt(document.querySelector('#meshSel .mgbtn.active')?.dataset.r||2) }
function currentMeshCols(){ return parseInt(document.querySelector('#meshSel .mgbtn.active')?.dataset.c||2) }

document.getElementById('meshSel').querySelectorAll('.mgbtn').forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll('#meshSel .mgbtn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    // Apply to selected surface
    const s=surfaces.find(s=>s.id===selId);
    if(!s) return;
    pushUndo();
    const rows=parseInt(btn.dataset.r), cols=parseInt(btn.dataset.c);
    const b=surfaceBBox(s);
    s.rows=rows; s.cols=cols;
    s.pts=makeGrid(rows,cols,b.x,b.y,b.w,b.h);
    toast(`Mesh set to ${rows}×${cols}`);
  };
});

// ── Properties panel ──────────────────────────
document.getElementById('selBlend').onchange=function(){
  const s=surfaces.find(s=>s.id===selId); if(s){ pushUndo(); s.blend=this.value; }
};
document.getElementById('rngOpacity').oninput=function(){
  beginGesture();
  const v=parseInt(this.value);
  document.getElementById('lblOpacity').textContent=v+'%';
  const s=surfaces.find(s=>s.id===selId); if(s) s.opacity=v/100;
};

// ── Surfaces list + inspector ─────────────────
// Paint a surface's media into a thumbnail canvas (cover-fit). Videos get a ▶
// badge because the editor only ever holds a captured frame — it never plays.
function paintThumb(tc, media){
  const g=tc.getContext('2d');
  const W=tc.width, H=tc.height;
  g.clearRect(0,0,W,H);
  const msrc=media && (media.thumb || media.animCanvas);
  if(!msrc) return false;
  const sw=msrc.width, sh=msrc.height;
  if(!sw || !sh) return false;
  const sc=Math.max(W/sw, H/sh);   // cover-fit
  g.drawImage(msrc,(W-sw*sc)/2,(H-sh*sc)/2,sw*sc,sh*sc);
  if(media.type==='video'){
    g.fillStyle='rgba(0,0,0,.4)'; g.fillRect(0,0,W,H);
    g.fillStyle='rgba(255,255,255,.85)';
    g.font=Math.round(H*0.42)+'px monospace';
    g.textAlign='center'; g.textBaseline='middle'; g.fillText('▶',W/2,H/2);
  }
  return true;
}

// The rails are built from divs/spans for layout reasons, but they are
// controls: without this they were the only part of THROW with no keyboard
// path. role+tabindex expose them, and Enter/Space match native button
// semantics (Space must not scroll).
function asButton(el, label, fn){
  el.setAttribute('role','button');
  el.setAttribute('tabindex','0');
  if(label) el.setAttribute('aria-label',label);
  el.onclick=fn;
  el.onkeydown=(e)=>{
    if(e.key!=='Enter' && e.key!==' ') return;
    e.preventDefault(); e.stopPropagation();
    fn(e);
  };
  return el;
}

// How much media is loaded, and how heavy the playback will be.
//
// Two different limits, and conflating them is what made the old messages
// wrong. STORAGE is what the display has to hold — large now, since big clips
// stream to disk. DECODE is how many video streams play at once, and that is
// the one that actually causes stutter (NOTES §9b: a hardware decode block is
// roughly 4K60 per stream). Ten 1080p clips can be fine where two 4K clips are
// not, so the warning counts VIDEO streams and weights them by resolution
// rather than counting "clips", which would treat a 2MB logo like a 4K capture.
const SOFT_STREAMS = 10;     // advisory only — never blocks (NOTES §4)
function paintStoreMeter(){
  const el=document.getElementById('storeMeter');
  if(!el) return;
  let bytes=0, items=0, videos=0, heavy=0;
  for(const s of surfaces){
    if(!s.playlist) continue;
    for(const it of s.playlist.items){
      items++;
      if(it.file) bytes+=it.file.size;
      else if(typeof it.src==='string') bytes+=Math.floor(it.src.length*0.75);
      if(it.kind==='video'){ videos++; if((it._srcH||0)>1140) heavy++; }
    }
  }
  if(!items){ el.textContent=''; el.className=''; return; }
  const gb=bytes/1073741824;
  const size = gb>=1 ? gb.toFixed(1)+' GB' : Math.round(bytes/1048576)+' MB';
  // Split by where the display will actually PUT each clip, because the two
  // have completely different ceilings: anything under 64MB stays in the
  // display's memory (bounded ~2.5GB however big the disk is), everything
  // larger streams to disk (bounded by storage quota). A single total hides
  // which limit you are walking into.
  const SMALL_BYTES = 64*1024*1024;
  let memBytes=0, diskBytes=0;
  for(const s of surfaces){
    if(!s.playlist) continue;
    for(const it of s.playlist.items){
      const n = it.file ? it.file.size : (typeof it.src==='string' ? Math.floor(it.src.length*0.75) : 0);
      if(n >= SMALL_BYTES) diskBytes+=n; else memBytes+=n;
    }
  }
  const fmt = (n)=> n>=1073741824 ? (n/1073741824).toFixed(1)+' GB' : Math.round(n/1048576)+' MB';
  const split = (diskBytes && memBytes) ? ' ('+fmt(diskBytes)+' to disk · '+fmt(memBytes)+' in memory)' : '';
  // One surface only ever plays one item at a time, so concurrent streams is
  // bounded by surfaces holding video, not by total items.
  const streams = surfaces.filter(s=>s.playlist && s.playlist.items.some(i=>i.kind==='video')).length;
  const over = streams>SOFT_STREAMS || heavy>2;
  el.className = over ? 'warn' : '';
  el.textContent = items+' clip'+(items===1?'':'s')+' · '+size+split+
                   (streams?' · '+streams+' video surface'+(streams===1?'':'s'):'')+
                   (over ? (heavy>2 ? ' · '+heavy+' above 1080p — ⤓ Downscale to avoid stutter'
                                    : ' · past '+SOFT_STREAMS+' streams playback may stutter') : '');
}

function updateUI(){
  touchState();   // every discrete edit funnels through here
  const list=document.getElementById('layerList');
  list.textContent='';
  // Top of the list = top of the stack, so reverse (last drawn is topmost)
  [...surfaces].reverse().forEach(s=>{
    const item=document.createElement('div');
    item.className='layer-item'+(s.id===selId?' sel':'');

    const thumb=document.createElement('div');
    thumb.className='layer-thumb';
    const tc=document.createElement('canvas');
    tc.width=36; tc.height=24;
    thumb.appendChild(tc);
    paintThumb(tc, s.media);

    const body=document.createElement('div');
    body.className='layer-body';
    const nameEl=document.createElement('div');
    nameEl.className='layer-name';
    nameEl.textContent=s.name||'Surface';
    nameEl.title=s.name||'Surface';
    const metaEl=document.createElement('div');
    metaEl.className='layer-meta';
    metaEl.textContent=`${s.rows}×${s.cols} · ${s.blend||'normal'}`;
    body.append(nameEl, metaEl);

    const visEl=document.createElement('div');
    visEl.className='layer-vis';
    visEl.dataset.id=s.id;
    visEl.textContent=s.visible?'◉':'○';
    visEl.title=s.visible?'Visible — click to hide':'Hidden — click to show';

    item.append(thumb, body, visEl);
    asButton(item, 'Select '+(s.name||'Surface'), ()=>{ selId=s.id; updateUI(); });
    asButton(visEl, (s.visible?'Hide ':'Show ')+(s.name||'Surface'), (e)=>{
      e.stopPropagation();
      s.visible=!s.visible;
      updateUI();
    });
    list.appendChild(item);
  });
  if(!surfaces.length){
    const e=document.createElement('div');
    e.className='rail-empty';
    e.textContent='No surfaces yet — press A';
    list.appendChild(e);
  }
  document.getElementById('surfCount').textContent=surfaces.length;
  document.getElementById('stageEmpty').style.display=surfaces.length?'none':'block';

  const s=surfaces.find(s=>s.id===selId);

  // Inspector header — what's selected, always the acid-highlighted thing
  const inspName=document.getElementById('inspName');
  const inspMeta=document.getElementById('inspMeta');
  paintThumb(document.getElementById('inspThumb'), s && s.media);
  if(s){
    inspName.textContent=s.name||'Surface';
    inspName.title=s.name||'Surface';
    const items=(s.playlist&&s.playlist.items.length)||0;
    inspMeta.textContent=items
      ? `${items} item${items>1?'s':''} · ${s.rows}×${s.cols} mesh`
      : `no media · ${s.rows}×${s.cols} mesh`;
    inspMeta.classList.toggle('none', !items);
  } else {
    inspName.textContent='No selection';
    inspMeta.textContent='select a surface';
    inspMeta.classList.add('none');
  }

  // Mesh selector highlight
  if(s){
    document.querySelectorAll('#meshSel .mgbtn').forEach(b=>{
      b.classList.toggle('active',parseInt(b.dataset.r)===s.rows&&parseInt(b.dataset.c)===s.cols);
    });
    document.getElementById('selBlend').value=s.blend||'normal';
    document.getElementById('rngOpacity').value=Math.round(s.opacity*100);
    document.getElementById('lblOpacity').textContent=Math.round(s.opacity*100)+'%';
  }
  syncScaleUI();
  syncAdjustUI();
  syncCropUI();
  syncPlaylistUI();
  syncTrimUI();
  paintStoreMeter();
  document.getElementById('statusText').textContent=
    surfaces.length===0?'No surfaces — press A to add':
    selId?`${s?.name||'?'} — ${s?.rows||0}×${s?.cols||0} mesh · ${s?.blend||'normal'}`:`${surfaces.length} surface(s)`;
}

// ── Stage resize ──────────────────────────────
// Presets cover the common projector resolutions; Custom reveals manual W/H.
// Changing the stage only changes the projected backdrop bounds — surfaces keep
// their absolute positions and scale, and anything past the edge simply isn't
// projected (deliberate: the user may park media off-stage while calibrating).
const stagePresetSel=document.getElementById('stagePreset');
const stageCustomBox=document.getElementById('stageCustom');
function applyStageSize(w,h,save=true){
  if(!(w>0&&h>0)) return;
  resizeStage(w,h);
  document.getElementById('stageW').value=w;
  document.getElementById('stageH').value=h;
  if(save) safeSet('throw_stage', w+'x'+h);
}
function syncStagePresetUI(){
  const key=stageW+'x'+stageH;
  if([...stagePresetSel.options].some(o=>o.value===key)){
    stagePresetSel.value=key; stageCustomBox.style.display='none';
  } else {
    stagePresetSel.value='custom'; stageCustomBox.style.display='block';
  }
}
stagePresetSel.onchange=()=>{
  const v=stagePresetSel.value;
  if(v==='custom'){ stageCustomBox.style.display='block'; return; }
  stageCustomBox.style.display='none';
  const [w,h]=v.split('x').map(Number);
  applyStageSize(w,h);
  toast('Stage set to '+w+'×'+h);
};
document.getElementById('btnStageApply').onclick=()=>{
  const w=parseInt(document.getElementById('stageW').value);
  const h=parseInt(document.getElementById('stageH').value);
  applyStageSize(w,h);
};
function resizeStage(w,h){
  stageW=w; stageH=h;
  touchState();
  stageEl.style.width=Math.round(w*fitScale())+'px';
  stageEl.style.height=Math.round(h*fitScale())+'px';
  SC.width=w; SC.height=h;
  IC.width=w; IC.height=h;
  document.getElementById('stageDimLabel').textContent=w+' × '+h;
  fitStageToWrap();
}
function fitScale(){
  const wrap=stageWrap.getBoundingClientRect();
  return Math.min((wrap.width-40)/stageW,(wrap.height-40)/stageH)*0.95;
}
function fitStageToWrap(){
  const sc=fitScale();
  stageEl.style.width=Math.round(stageW*sc)+'px';
  stageEl.style.height=Math.round(stageH*sc)+'px';
  SC.style.width='100%'; SC.style.height='100%';
  IC.style.width='100%'; IC.style.height='100%';
}
window.addEventListener('resize',fitStageToWrap);
fitStageToWrap();

// Restore the last-used stage size (falls back to the 1920×1080 default)
(function(){
  const saved=safeGet('throw_stage');
  if(!saved) return;
  const [w,h]=saved.split('x').map(Number);
  if(!(w>0&&h>0)) return;
  applyStageSize(w,h,false);
  syncStagePresetUI();
})();

