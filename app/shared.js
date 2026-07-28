// ══════════════════════════════════════════════════════════════════
//  THROW shared.js — warp math, rendering, and media helpers used by
//  BOTH the editor (THROW.html) and the display tab (display.html).
// ══════════════════════════════════════════════════════════════════

// ── Format recognition ────────────────────────────────────────────
// Wide net: anything the browser MIGHT decode is accepted; what actually
// plays is decided by the browser, and failures get honest, format-aware
// messages (see mediaErrText / playbackHint).
const VIDEO_EXT = /\.(mp4|m4v|mov|qt|webm|ogv|ogg|mkv|avi|wmv|flv|mpe?g|m2v|3gp|3g2|ts|mts|m2ts|vob|f4v|asf|divx)$/i;
const IMAGE_EXT = /\.(png|jpe?g|jfif|gif|webp|avif|bmp|svg|ico|tiff?|heic|heif)$/i;
const ANIMATED_EXT = /\.(gif|webp|avif|apng)$/i;

function isVideoFile(file){
  const name = file.name || '';
  const isImg = /^image\//.test(file.type||'') || IMAGE_EXT.test(name);
  return (/^video\//.test(file.type||'') || VIDEO_EXT.test(name)) && !isImg;
}
function isImageFile(file){
  return /^image\//.test(file.type||'') || IMAGE_EXT.test(file.name||'');
}

function guessVideoMime(name){
  name=(name||'').toLowerCase();
  if(/\.webm$/.test(name)) return 'video/webm';
  if(/\.(ogv|ogg)$/.test(name)) return 'video/ogg';
  if(/\.(3gp|3g2)$/.test(name)) return 'video/3gpp';
  if(/\.(ts|mts|m2ts)$/.test(name)) return 'video/mp2t';
  if(/\.mkv$/.test(name)) return 'video/x-matroska';
  if(/\.avi$/.test(name)) return 'video/x-msvideo';
  if(/\.wmv$/.test(name)) return 'video/x-ms-wmv';
  if(/\.flv$/.test(name)) return 'video/x-flv';
  if(/\.(mpe?g|m2v|vob)$/.test(name)) return 'video/mpeg';
  return 'video/mp4'; // mp4/m4v/mov/qt/f4v/divx/unknown
}
function guessImageMime(name){
  name=(name||'').toLowerCase();
  if(/\.png$/.test(name)) return 'image/png';
  if(/\.gif$/.test(name)) return 'image/gif';
  if(/\.webp$/.test(name)) return 'image/webp';
  if(/\.avif$/.test(name)) return 'image/avif';
  if(/\.(tiff?)$/.test(name)) return 'image/tiff';
  if(/\.bmp$/.test(name)) return 'image/bmp';
  if(/\.svg$/.test(name)) return 'image/svg+xml';
  if(/\.(heic|heif)$/.test(name)) return 'image/heic';
  return 'image/jpeg';
}

// Force a correct MIME on typeless blobs — a real-world cause of Chrome
// rejecting a valid .mp4 with "source not supported".
function typedBlobURL(file, video){
  let blob=file;
  const t=(file.type||'').toLowerCase();
  if(video && !/^video\//.test(t)){
    try{ blob=file.slice(0,file.size, guessVideoMime(file.name)); }catch(_){ }
  } else if(!video && !/^image\//.test(t)){
    try{ blob=file.slice(0,file.size, guessImageMime(file.name)); }catch(_){ }
  }
  return URL.createObjectURL(blob);
}

// ── Honest error text ─────────────────────────────────────────────
function mediaErrText(code){
  switch(code){
    case 1: return 'the load was interrupted';
    case 2: return 'a file/network read error';
    case 3: return 'a decode error (the clip may be partly corrupt)';
    case 4: return 'this browser can’t decode that codec';
    default: return 'an unknown playback error';
  }
}
function playbackHint(name, code){
  if(code!==3 && code!==4) return '';
  name=(name||'').toLowerCase();
  if(/\.(mkv|avi|wmv|flv|mpe?g|m2v|vob|asf|divx|rm|rmvb)$/.test(name))
    return 'this container isn’t playable in-browser — convert it to .mp4 (H.264) or .webm (free: HandBrake → “Fast 1080p30”), then drop it back in';
  return 'the codec inside likely isn’t browser-playable (often H.265/HEVC or AV1 from “live wallpaper” clips) — re-encode to H.264 .mp4 (free: HandBrake → “Fast 1080p30”) and drop it back in';
}

// Advisory-only codec sniff: scans ONLY the pre-'mdat' metadata region
// (FourCCs occur by chance inside frame data — scanning it gives false
// positives). Never blocks playback; the MediaError is the source of truth.
async function sniffVideoCodec(file){
  try{
    const buf = new Uint8Array(await file.slice(0, 1024*512).arrayBuffer());
    let scanEnd = buf.length;
    for(let i=0;i<buf.length-4;i++){
      if(buf[i]===0x6d&&buf[i+1]===0x64&&buf[i+2]===0x61&&buf[i+3]===0x74){ scanEnd=i; break; } // 'mdat'
    }
    let s=''; for(let i=0;i<scanEnd;i++) s+=String.fromCharCode(buf[i]);
    const has=(t)=>s.indexOf(t)!==-1;
    const probe=(c)=>{ try{ return document.createElement('video').canPlayType('video/mp4; codecs="'+c+'"')!==''; }catch(_){ return false; } };
    if(has('hvc1')||has('hev1')) return {name:'H.265 / HEVC', ok: probe('hvc1.1.6.L93.B0')};
    if(has('av01'))              return {name:'AV1',          ok: probe('av01.0.05M.08')};
    if(has('vp09')||has('vp08')) return {name:'VP9',          ok: probe('vp09.00.10.08')};
    if(has('avcC'))              return {name:'H.264 / AVC',  ok:true};
    return {name:null, ok:true};
  }catch(_){ return {name:null, ok:true}; }
}

// ── Geometry ──────────────────────────────────────────────────────
function makeGrid(rows,cols,x,y,w,h){
  const pts=[];
  for(let r=0;r<=rows;r++){
    pts[r]=[];
    for(let c=0;c<=cols;c++){
      pts[r][c]={ x: x + (c/cols)*w, y: y + (r/rows)*h };
    }
  }
  return pts;
}
function surfaceBBox(s){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(let r=0;r<=s.rows;r++) for(let c=0;c<=s.cols;c++){
    const p=s.pts[r][c];
    x0=Math.min(x0,p.x); y0=Math.min(y0,p.y);
    x1=Math.max(x1,p.x); y1=Math.max(y1,p.y);
  }
  return {x:x0,y:y0,w:x1-x0,h:y1-y0};
}
function surfaceCenter(s){
  const b=surfaceBBox(s);
  return {x:b.x+b.w/2, y:b.y+b.h/2};
}
function biquad(tl,tr,bl,br,u,v){
  return {
    x:(1-u)*(1-v)*tl.x + u*(1-v)*tr.x + (1-u)*v*bl.x + u*v*br.x,
    y:(1-u)*(1-v)*tl.y + u*(1-v)*tr.y + (1-u)*v*bl.y + u*v*br.y
  };
}
function subdivFor(s){
  return Math.max(1, Math.round(6 / Math.max(s.rows, s.cols)));
}

// ── Sticker masks ─────────────────────────────────────────────────
// A surface's mask is a polygon stored in mesh-UV (0..1 of its bounding box at
// trace time), so it warps WITH the mesh. meshMapUV maps any (u,v) through the
// full mesh to stage coordinates; maskStagePts gives the mask outline in stage
// space for clipping/stencilling.
function meshMapUV(s, u, v){
  u=Math.max(0,Math.min(1,u)); v=Math.max(0,Math.min(1,v));
  const c=Math.min(s.cols-1, Math.floor(u*s.cols));
  const r=Math.min(s.rows-1, Math.floor(v*s.rows));
  const lu=u*s.cols-c, lv=v*s.rows-r;
  return biquad(s.pts[r][c], s.pts[r][c+1], s.pts[r+1][c], s.pts[r+1][c+1], lu, lv);
}
function maskStagePts(s){
  if(!s.mask || s.mask.length<3) return null;
  return s.mask.map(m=>meshMapUV(s, m.u, m.v));
}
// Ear-clipping triangulation (handles concave polygons). Returns a flat
// [x0,y0, x1,y1, ...] of triangle vertices, or [] if degenerate.
function _pointInTri(p,a,b,c){
  const d1=sign2(p.x,p.y,a,b), d2=sign2(p.x,p.y,b,c), d3=sign2(p.x,p.y,c,a);
  const neg=(d1<0)||(d2<0)||(d3<0), pos=(d1>0)||(d2>0)||(d3>0);
  return !(neg&&pos);
}
function earClip(pts){
  const n=pts.length;
  if(n<3) return [];
  let idx=[...Array(n).keys()];
  let area=0; for(let i=0;i<n;i++){ const a=pts[i], b=pts[(i+1)%n]; area+=a.x*b.y-b.x*a.y; }
  if(area<0) idx.reverse();   // want CCW
  const out=[]; let guard=0;
  while(idx.length>2 && guard++ < n*n+8){
    let clipped=false;
    for(let i=0;i<idx.length;i++){
      const a=pts[idx[(i-1+idx.length)%idx.length]], b=pts[idx[i]], c=pts[idx[(i+1)%idx.length]];
      if((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x) <= 0) continue;   // reflex, not an ear
      let ok=true;
      for(let j=0;j<idx.length;j++){
        const q=pts[idx[j]];
        if(q===a||q===b||q===c) continue;
        if(_pointInTri(q,a,b,c)){ ok=false; break; }
      }
      if(!ok) continue;
      out.push(a.x,a.y, b.x,b.y, c.x,c.y);
      idx.splice(i,1); clipped=true; break;
    }
    if(!clipped) break;   // degenerate — bail with what we have
  }
  return out;
}
function dist(ax,ay,bx,by){ return Math.sqrt((ax-bx)**2+(ay-by)**2) }
function sign2(px,py,a,b){ return (b.x-a.x)*(py-a.y)-(b.y-a.y)*(px-a.x) }
function pointInQuad(px,py,a,b,c,d){
  return sign2(px,py,a,b)>=0 && sign2(px,py,b,c)>=0 &&
         sign2(px,py,c,d)>=0 && sign2(px,py,d,a)>=0;
}
function pointInSurface(s,px,py){
  for(let r=0;r<s.rows;r++){
    for(let c=0;c<s.cols;c++){
      const tl=s.pts[r][c], tr=s.pts[r][c+1];
      const bl=s.pts[r+1][c], br=s.pts[r+1][c+1];
      if(pointInQuad(px,py,tl,tr,br,bl)) return true;
    }
  }
  return false;
}

// ── Rendering ─────────────────────────────────────────────────────
// Affine texture-mapped triangle. try/finally guarantees restore() even if
// drawImage throws — one bad frame must never leak clip/transform state into
// subsequent surfaces (the single most important correctness invariant here).
function texTri(g, img, p0,p1,p2, u0,v0,u1,v1,u2,v2){
  g.save();
  try{
    g.beginPath();
    g.moveTo(p0.x,p0.y); g.lineTo(p1.x,p1.y); g.lineTo(p2.x,p2.y); g.closePath();
    g.clip();
    const denom = u0*(v1-v2) - u1*(v0-v2) + u2*(v0-v1);
    if(Math.abs(denom) < 1e-6){ return; }
    const a = (p0.x*(v1-v2) - p1.x*(v0-v2) + p2.x*(v0-v1)) / denom;
    const b = (p0.y*(v1-v2) - p1.y*(v0-v2) + p2.y*(v0-v1)) / denom;
    const c = (p0.x*(u2-u1) - p1.x*(u2-u0) + p2.x*(u1-u0)) / denom;
    const d = (p0.y*(u2-u1) - p1.y*(u2-u0) + p2.y*(u1-u0)) / denom;
    const e = (p0.x*(u1*v2-u2*v1) - p1.x*(u0*v2-u2*v0) + p2.x*(u0*v1-u1*v0)) / denom;
    const f = (p0.y*(u1*v2-u2*v1) - p1.y*(u0*v2-u2*v0) + p2.y*(u0*v1-u1*v0)) / denom;
    g.setTransform(a,b,c,d,e,f);
    g.drawImage(img, 0, 0);
    g.setTransform(1,0,0,1,0,0);
  } finally {
    g.restore();
  }
}

// Per-document offscreen buffer (each page that loads shared.js gets its own).
const _off = document.createElement('canvas');
const _octx = _off.getContext('2d');

// Warp one surface's media into an arbitrary buffer canvas with NORMAL
// compositing (so triangle seams never double-blend). Split out from the
// composite step so callers can CACHE the warped buffer: a static image only
// needs re-warping when the mesh moves, not every frame.
// Normalise a crop rect (source sub-rectangle, 0..1) to a safe default.
function cropRect(c){
  if(c && c.w>0 && c.h>0) return {x:c.x||0, y:c.y||0, w:c.w, h:c.h};
  return {x:0, y:0, w:1, h:1};
}

// `adj` is the LOOK being rendered — brightness/contrast/saturation/hue/flips.
// `crop` selects a source sub-rectangle (0..1) mapped across the whole mesh.
// Both are passed in rather than read off the surface because each playlist item
// carries its own, and a crossfade draws two different items in one frame.
function warpInto(buf, s, el, stageW, stageH, adj, crop){
  if(buf.width!==stageW || buf.height!==stageH){ buf.width=stageW; buf.height=stageH; }
  const g = buf.getContext('2d');
  g.setTransform(1,0,0,1,0,0);
  g.imageSmoothingEnabled=true;
  g.imageSmoothingQuality='high';
  g.globalCompositeOperation='source-over';
  g.globalAlpha=1;
  g.clearRect(0,0,stageW,stageH);

  const mw = el.videoWidth || el.naturalWidth || el.width;
  const mh = el.videoHeight || el.naturalHeight || el.height;
  const sub = subdivFor(s);
  // Crop selects the visible source region; flips mirror WITHIN that region.
  // Matches the display's shader: crop.xy + abs(flip - uv) * crop.wh.
  const cr = cropRect(crop);
  const fH = !!(adj && adj.flipH);
  const fV = !!(adj && adj.flipV);
  const U = (u)=> ( cr.x + (fH ? 1-u : u)*cr.w ) * mw;
  const V = (v)=> ( cr.y + (fV ? 1-v : v)*cr.h ) * mh;

  for(let r=0;r<s.rows;r++){
    for(let c=0;c<s.cols;c++){
      const tl=s.pts[r][c], tr=s.pts[r][c+1];
      const bl=s.pts[r+1][c], br=s.pts[r+1][c+1];
      const u0=c/s.cols, u1=(c+1)/s.cols;
      const v0=r/s.rows, v1=(r+1)/s.rows;
      for(let si=0;si<sub;si++){
        for(let sj=0;sj<sub;sj++){
          const ua=sj/sub, ub=(sj+1)/sub;
          const va=si/sub, vb=(si+1)/sub;
          const a00=biquad(tl,tr,bl,br,ua,va);
          const a10=biquad(tl,tr,bl,br,ub,va);
          const a01=biquad(tl,tr,bl,br,ua,vb);
          const a11=biquad(tl,tr,bl,br,ub,vb);
          const mua=U(u0+ua*(u1-u0)), mub=U(u0+ub*(u1-u0));
          const mva=V(v0+va*(v1-v0)), mvb=V(v0+vb*(v1-v0));
          texTri(g, el, a00,a10,a11, mua,mva, mub,mva, mub,mvb);
          texTri(g, el, a00,a11,a01, mua,mva, mub,mvb, mua,mvb);
        }
      }
    }
  }
}

// CSS-filter string for a look's colour adjustments ('' when neutral).
// Applied at COMPOSITE time so tweaking sliders never invalidates warp caches.
function adjustFilter(a){
  if(!a) return '';
  const br=(typeof a.br==='number')?a.br:1;
  const ct=(typeof a.ct==='number')?a.ct:1;
  const sat=(typeof a.sat==='number')?a.sat:1;
  const hue=a.hue||0;
  if(br===1 && ct===1 && sat===1 && !hue) return '';
  return 'brightness('+br+') contrast('+ct+') saturate('+sat+') hue-rotate('+hue+'deg)';
}

// Composite a warped buffer onto dst ONCE with the surface's blend + opacity
// (+ the item's colour adjustments via canvas filter — GPU-side in Chromium).
function compositeSurface(dst, buf, s, adj){
  dst.save();
  try{
    // sticker mask: clip the composite to the traced polygon (warped with mesh)
    const mp=maskStagePts(s);
    if(mp){
      dst.beginPath();
      dst.moveTo(mp[0].x,mp[0].y);
      for(let i=1;i<mp.length;i++) dst.lineTo(mp[i].x,mp[i].y);
      dst.closePath(); dst.clip();
    }
    dst.globalCompositeOperation = s.blend==='add' ? 'lighter' : (s.blend||'normal');
    dst.globalAlpha = (typeof s.opacity==='number') ? s.opacity : 1;
    const f=adjustFilter(adj);
    if(f) dst.filter=f;   // unsupported browsers ignore the assignment — honest degradation
    dst.drawImage(buf, 0, 0);
  } finally {
    dst.restore();
  }
}

// Convenience: warp + composite in one call (uncached path).
function renderSurfaceTo(dst, s, el, stageW, stageH, adj, crop){
  warpInto(_off, s, el, stageW, stageH, adj, crop);
  compositeSurface(dst, _off, s, adj);
}

// Cache key for a warped buffer: changes when anything that affects the WARP
// changes (geometry, mesh density, stage size, media identity). Blend and
// opacity are deliberately NOT included — they apply at composite time.
function warpKey(s, el, stageW, stageH, adj, crop){
  const a=adj||{}, cr=cropRect(crop);
  return stageW+'x'+stageH+'|'+s.rows+'x'+s.cols+'|'+
         (el.width||el.naturalWidth||0)+'|'+(a.flipH?'H':'')+(a.flipV?'V':'')+'|'+
         cr.x+','+cr.y+','+cr.w+','+cr.h+'|'+JSON.stringify(s.pts);
}

// Calibration target for an empty / still-loading surface: checkerboard +
// bold border + centre crosshair, warped through the same mesh.
function drawPlaceholderTo(dst, s){
  const N=4;
  for(let r=0;r<s.rows;r++){
    for(let c=0;c<s.cols;c++){
      const tl=s.pts[r][c], tr=s.pts[r][c+1], bl=s.pts[r+1][c], br=s.pts[r+1][c+1];
      for(let i=0;i<N;i++){
        for(let j=0;j<N;j++){
          const ua=i/N, ub=(i+1)/N, va=j/N, vb=(j+1)/N;
          const a=biquad(tl,tr,bl,br,ua,va), b=biquad(tl,tr,bl,br,ub,va);
          const cc=biquad(tl,tr,bl,br,ub,vb), d=biquad(tl,tr,bl,br,ua,vb);
          dst.beginPath();
          dst.moveTo(a.x,a.y); dst.lineTo(b.x,b.y); dst.lineTo(cc.x,cc.y); dst.lineTo(d.x,d.y); dst.closePath();
          dst.fillStyle=((i+j)%2)?'rgba(196,255,46,0.10)':'rgba(196,255,46,0.03)';
          dst.fill();
        }
      }
      dst.beginPath();
      dst.moveTo(tl.x,tl.y); dst.lineTo(tr.x,tr.y); dst.lineTo(br.x,br.y); dst.lineTo(bl.x,bl.y); dst.closePath();
      dst.strokeStyle='rgba(196,255,46,0.22)'; dst.lineWidth=1; dst.stroke();
    }
  }
  const c0=s.pts[0][0], c1=s.pts[0][s.cols], c2=s.pts[s.rows][s.cols], c3=s.pts[s.rows][0];
  dst.beginPath();
  dst.moveTo(c0.x,c0.y); dst.lineTo(c1.x,c1.y); dst.lineTo(c2.x,c2.y); dst.lineTo(c3.x,c3.y); dst.closePath();
  dst.strokeStyle='rgba(196,255,46,0.55)'; dst.lineWidth=2; dst.stroke();
  const ctr=surfaceCenter(s);
  const rad=Math.min(surfaceBBox(s).w,surfaceBBox(s).h)*0.12;
  dst.strokeStyle='rgba(196,255,46,0.5)'; dst.lineWidth=1.5;
  dst.beginPath();
  dst.moveTo(ctr.x-rad,ctr.y); dst.lineTo(ctr.x+rad,ctr.y);
  dst.moveTo(ctr.x,ctr.y-rad); dst.lineTo(ctr.x,ctr.y+rad);
  dst.stroke();
}

// Alignment overlay: outer boundary + light grid + corner dots + centre tick,
// in stage coordinates, no grab handles. lw is in stage units.
function drawOutlinesTo(g, surfaceList, lw){
  lw = lw || 2;
  for(const s of surfaceList){
    if(s.visible===false) continue;
    g.strokeStyle='rgba(196,255,46,0.30)';
    g.lineWidth=lw*0.6;
    for(let r=0;r<=s.rows;r++){
      g.beginPath();
      g.moveTo(s.pts[r][0].x, s.pts[r][0].y);
      for(let c=1;c<=s.cols;c++) g.lineTo(s.pts[r][c].x, s.pts[r][c].y);
      g.stroke();
    }
    for(let c=0;c<=s.cols;c++){
      g.beginPath();
      g.moveTo(s.pts[0][c].x, s.pts[0][c].y);
      for(let r=1;r<=s.rows;r++) g.lineTo(s.pts[r][c].x, s.pts[r][c].y);
      g.stroke();
    }
    const c0=s.pts[0][0], c1=s.pts[0][s.cols], c2=s.pts[s.rows][s.cols], c3=s.pts[s.rows][0];
    g.strokeStyle='rgba(196,255,46,0.95)';
    g.lineWidth=lw;
    g.beginPath();
    g.moveTo(c0.x,c0.y); g.lineTo(c1.x,c1.y); g.lineTo(c2.x,c2.y); g.lineTo(c3.x,c3.y); g.closePath();
    g.stroke();
    [c0,c1,c2,c3].forEach(p=>{
      g.beginPath(); g.arc(p.x,p.y,lw*2.2,0,Math.PI*2);
      g.fillStyle='rgba(196,255,46,0.95)'; g.fill();
    });
    const ctr=surfaceCenter(s);
    const rad=Math.min(surfaceBBox(s).w,surfaceBBox(s).h)*0.10;
    g.strokeStyle='rgba(196,255,46,0.8)'; g.lineWidth=lw*0.8;
    g.beginPath();
    g.moveTo(ctr.x-rad,ctr.y); g.lineTo(ctr.x+rad,ctr.y);
    g.moveTo(ctr.x,ctr.y-rad); g.lineTo(ctr.x,ctr.y+rad);
    g.stroke();
  }
}

// ── Animated images (WebCodecs) ───────────────────────────────────
// Decodes GIF / animated WebP / AVIF / APNG into a self-advancing canvas.
// Resolves to {canvas, frames} or rejects with a format-specific message.
// Falls back to null (caller should use a plain <img>) when unavailable.
function createAnimatedCanvas(file){
  return new Promise(async (resolve, reject)=>{
    if(typeof ImageDecoder === 'undefined'){ resolve(null); return; }
    const ext = ((file.name||'').match(/\.(\w+)$/)||[])[1]?.toLowerCase() || '';
    const fmtErrors = {
      gif:  'GIF decode failed — the file may be corrupt or use an unusual variant',
      webp: 'WebP decode failed — if this is an animated WebP, try re-saving it',
      avif: 'AVIF decode failed — animated AVIF requires Chrome 113+; try a different format',
      apng: 'APNG decode failed — try re-exporting the animation from your source app',
    };
    let decoder;
    try{
      const buf = await file.arrayBuffer();
      decoder = new ImageDecoder({data: buf, type: guessImageMime(file.name||''), preferAnimation: true});
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      const frameCount = track ? (track.frameCount || 1) : 1;
      const frames = [];
      for(let i=0;i<frameCount;i++){
        const res = await decoder.decode({frameIndex:i});
        const dur = res.image.duration != null ? res.image.duration/1000 : 100;
        frames.push({image: res.image, duration: Math.max(20, dur)});
      }
      const fc = document.createElement('canvas');
      fc.width = frames[0].image.displayWidth;
      fc.height = frames[0].image.displayHeight;
      const fctx = fc.getContext('2d');
      fctx.drawImage(frames[0].image, 0, 0);
      let idx=0, last=0, dead=false;
      fc._stop = ()=>{ dead=true; };
      function advance(now){
        if(dead) return;
        const f=frames[idx];
        if(now-last >= f.duration){
          fctx.clearRect(0,0,fc.width,fc.height);
          fctx.drawImage(f.image,0,0);
          idx=(idx+1)%frameCount;
          last=now;
        }
        requestAnimationFrame(advance);
      }
      requestAnimationFrame(advance);
      resolve({canvas: fc, frames: frameCount});
    }catch(err){
      if(decoder) try{ decoder.close(); }catch(_){}
      reject(new Error((fmtErrors[ext]||'Animated image decode failed')+' — '+err.message));
    }
  });
}
