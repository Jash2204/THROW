// ══════════════════════════════════════════════════════════════════
//  THROW editor · 10 — the BroadcastChannel link to display.html, and
//  error reporting. Media ships as bytes, geometry as a diffed snapshot.
// ══════════════════════════════════════════════════════════════════
// ── Display sync ──────────────────────────────
// The editor never plays video — it renders thumbnails only. Real playback
// happens in display.html, which receives geometry (as JSON) and media (as
// Blobs — they structured-clone across BroadcastChannel) and renders itself.
const bc = new BroadcastChannel('throw-sync');
// Ship BYTES, not Blob handles. A structured-clone Blob is a lazy
// cross-context reference — Chrome's media demuxer stalls mid-stream when
// reading through it (first frame works, playback freezes at readyState 2).
// An ArrayBuffer is fully materialized on the receiving side. Items are
// content-addressed by id and sent ONCE; playlist order/config rides the
// state broadcast, so reorders and removals never re-send megabytes.
// Media crosses the channel in CHUNKS, one clip at a time.
//
// It used to go as a single file.arrayBuffer() — the whole clip materialised in
// one contiguous in-memory ArrayBuffer, then structured-cloned by postMessage
// into a second copy. Screen captures are not small: a 2.7GB clip exceeds what
// a single ArrayBuffer can hold and the read fails outright, and six clips at
// once put GBs of pressure on the heap so even smaller ones fail intermittently
// — surfacing as a baffling "the requested file could not be read... permission
// problems", which is Chrome's wording for a read it could not satisfy, not an
// actual permission fault. Refreshing the display often "fixed" it because the
// resend happened to hit a moment with headroom.
//
// file.slice(a,b).arrayBuffer() reads ONLY that range, so peak memory is one
// chunk instead of the whole file. The display reassembles the chunks into a
// Blob, which Chrome can back with disk rather than RAM — and it is still fully
// materialised on the receiving side, which is the property NOTES §2 needed.
const SEND_CHUNK = 8 * 1024 * 1024;   // 8 MB
let _sendChain = Promise.resolve();   // clips transfer one at a time, not all at once
let _xferSeq = 0;                     // every transfer is tagged, so two transfers of
                                      // the SAME item can never interleave their chunks

function bcSendItem(surfId, it){
  if(!it) return;
  // Already going out? Do nothing. A multi-GB clip takes longer to ship than
  // the display's missing-item grace period, so without this the display asks
  // for a file that is halfway across and starts a SECOND transfer.
  if(it._sending) return;
  it._sent=true;
  if(it.file){
    it._sending=true;
    _sendChain = _sendChain.then(()=>sendFileChunked(surfId, it)).catch(()=>{}).then(()=>{ it._sending=false; });
  } else if(typeof it.src==='string' && it.src.startsWith('data:')){
    try{ bc.postMessage({type:'pl-src', surfId, itemId:it.id, src:it.src, name:it.name}); }catch(_){}
  }
}

async function sendFileChunked(surfId, it){
  const f=it.file; if(!f) return;
  const total=f.size, iid=it.id, nm=f.name||it.name||'media';
  const xfer=++_xferSeq;
  try{
    bc.postMessage({type:'pl-begin', surfId, itemId:iid, xfer, name:nm, mime:f.type||'', size:total});
    for(let off=0; off<total; ){
      const end=Math.min(off+SEND_CHUNK, total);
      let buf=null, lastErr=null;
      // A failed range read is often transient (the OS had the file busy);
      // a couple of retries beats blaming the user's file.
      for(let attempt=0; attempt<3 && !buf; attempt++){
        try{ buf=await f.slice(off,end).arrayBuffer(); }
        catch(err){ lastErr=err; await new Promise(r=>setTimeout(r, 150*(attempt+1))); }
      }
      if(!buf) throw lastErr || new Error('could not read the file');
      bc.postMessage({type:'pl-chunk', surfId, itemId:iid, xfer, off, total, buf});
      off=end;
      it._sendPct = total ? off/total : 1;
    }
    bc.postMessage({type:'pl-end', surfId, itemId:iid, xfer});
    it._sendPct=1;
  }catch(err){
    it._sent=false; it._sendPct=0;
    try{ bc.postMessage({type:'pl-abort', surfId, itemId:iid, xfer}); }catch(_){}
    showError('Couldn’t read “'+nm+'” to send it to the Display tab',
      'the file may have been moved, renamed or changed since you added it — re-add it to retry');
  }
}
function bcSendPlaylist(s, force){
  const pl=s.playlist; if(!pl) return;
  for(const it of pl.items){
    if(it._sent && !force) continue;
    bcSendItem(s.id, it);
  }
}
let _lastSnap='';
// The snapshot diff is exact, but rebuilding it 60×/second just to discover
// nothing changed cost a full JSON.stringify of every control point each frame
// (~650 points across eight 8×8 surfaces). Gate it on a dirty flag instead.
//
// A PURE dirty flag would be too risky here: one mutation site that forgets to
// mark dirty freezes the projector silently and forever. So the flag is only a
// fast path — every 500ms the snapshot is rebuilt regardless, which bounds any
// missed mark at half a second instead of "until reload".
let _stateDirty=true, _lastFullCheck=0;
function touchState(){ _stateDirty=true; }
function broadcastState(){
  const now=performance.now();
  if(!_stateDirty && now-_lastFullCheck < 500) return;
  _stateDirty=false; _lastFullCheck=now;
  const snap=JSON.stringify({
    stageW, stageH, outlines: outputShowOutlines,
    surfaces: surfaces.map(s=>({id:s.id, rows:s.rows, cols:s.cols, pts:s.pts,
                                blend:s.blend, opacity:s.opacity, visible:s.visible, mask:s.mask||null,
                                // order AND per-item look both ride the state
                                // diff — still no media bytes re-sent
                                pl: s.playlist ? {
                                  items: s.playlist.items.map(it=>({id:it.id, adjust:it.adjust||null, crop:it.crop||null, trimIn:it.trimIn||0, trimOut:it.trimOut||0})),
                                  transition: s.playlist.transition,
                                  xfDur: s.playlist.xfDur,
                                  imgDur: s.playlist.imgDur
                                } : null}))
  });
  if(snap!==_lastSnap){
    _lastSnap=snap;
    try{ bc.postMessage({type:'state', json:snap}); }catch(_){}
  }
}
// Every form control in the app (sliders, number fields, dropdowns) surfaces
// its edits as input/change, so capturing both at the document covers all of
// them at once — including any control added later.
document.addEventListener('input',  touchState, true);
document.addEventListener('change', touchState, true);
document.addEventListener('click',  touchState, true);   // toolbar/rail/mesh-grid buttons

bc.onmessage=(ev)=>{
  const d=ev.data||{};
  if(d.type==='hello-display'){
    _lastSnap='';                      // force a full state resend this frame
    touchState();                      // ...and open the dirty gate so it is actually rebuilt
                                       // (a channel message is not a click/input event)
    for(const s of surfaces) bcSendPlaylist(s, true);
    toast('Display tab connected');
    document.getElementById('btnOutput').classList.add('active');
  } else if(d.type==='need-item'){
    // The display is missing a blob its playlist order references. It PULLS
    // rather than us blind-pushing, so an undo costs zero bytes unless the
    // display genuinely pruned something (see restore()).
    const it=itemRegistry.get(d.itemId);
    if(it) bcSendItem(d.surfId, it);
  } else if(d.type==='display-error'){
    showError(d.msg, d.detail);        // display problems surface here too
  } else if(d.type==='display-bye'){
    document.getElementById('btnOutput').classList.remove('active');
  }
};

// ── Error reporting ───────────────────────────
// Nothing fails silently. Real reason is always shown to the user.
function showError(msg, detail){
  const banner=document.getElementById('errBanner');
  const msgEl=document.getElementById('errMsg');
  msgEl.textContent='';
  const main=document.createTextNode(msg);
  msgEl.appendChild(main);
  if(detail){
    const d=document.createElement('span');
    d.style.color='#ff9bb3';
    d.textContent=' ('+detail+')';
    msgEl.appendChild(d);
  }
  banner.style.display='block';
  console.error('[THROW]', msg, detail||'');
}
function clearError(){ document.getElementById('errBanner').style.display='none'; }
document.getElementById('errClose').onclick=clearError;

window.addEventListener('error', e=>{
  showError('Something went wrong: '+(e.message||'unknown error'),
            e.filename?('line '+e.lineno):'');
});
window.addEventListener('unhandledrejection', e=>{
  const r=e.reason;
  showError('A background task failed: '+((r&&r.message)||String(r)));
});

