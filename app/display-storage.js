// ══════════════════════════════════════════════════════════════════
//  THROW display-storage.js — where the display tab PUTS the bytes.
//
//  The display receives media as chunks and has to end up with something
//  <video> can play. Accumulating those chunks into an in-memory Blob is
//  what limited THROW to roughly 2.5GB of video across all surfaces: past
//  that Chrome refuses to serve the blob body (net::ERR_BLOB_OUT_OF_MEMORY)
//  and <video> reports it as MEDIA_ERR_SRC_NOT_SUPPORTED — a "codec" error
//  for a codec that was never the problem.
//
//  Writing the chunks to the Origin Private File System instead gives back a
//  File backed by DISK, which is not subject to that ceiling. Measured: a
//  2.77GB capture streams to OPFS byte-exact in ~17s and plays; nine clips
//  totalling 7GB play at once. That is the same property the editor already
//  relies on — a File straight from the file picker is disk-backed, which is
//  why the editor can thumbnail a clip it could never hold in memory.
//
//  Two rules this file exists to enforce, both learned by getting them wrong:
//
//  · A FILENAME BELONGS TO A TRANSFER, NOT AN ITEM. Re-sending the same item
//    (the editor force-resends everything on hello-display) used to reuse the
//    filename, so the deferred cleanup of the OLD transfer deleted the NEW
//    transfer's file out from under the writer.
//  · A DIRECTORY BELONGS TO A TAB. OPFS is per-ORIGIN. A second display tab
//    used to wipe the first tab's media on startup, mid-projection.
// ══════════════════════════════════════════════════════════════════

const DiskStore = (() => {
  const ROOT = 'throw-media';
  // Below this an item stays in memory: a disk round-trip is not worth it, and
  // small items are bounded by MEM_BUDGET anyway. Mutable purely so tests can
  // drive the disk path with byte-sized payloads — the alternative is writing
  // 64MB per assertion, which is why the disk code went untested long enough
  // to ship two lifecycle bugs.
  let SMALL = 64 * 1024 * 1024;

  // This tab's own storage area. Every display tab gets one, so two tabs can
  // hold the same itemId without colliding, and neither can delete the other's
  // files by name.
  const SESSION = (() => {
    try{ return crypto.randomUUID(); }
    catch(_){ return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  })();

  let rootDir = null, myDir = null;
  let available = null;             // null = untested

  const pending = new Map();        // itemId -> in-flight transfer record
  const nameOf  = new Map();        // itemId -> the filename that item owns NOW
  const noDisk  = new Set();        // itemIds whose disk write failed (quota)
  let nameSeq = 0;

  const newName = (itemId) =>
    'item-' + String(itemId).replace(/[^\w.-]/g, '_') + '-' + (++nameSeq) + '.bin';

  async function root(){
    if(rootDir) return rootDir;
    if(!(navigator.storage && navigator.storage.getDirectory)) throw new Error('no OPFS');
    rootDir = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, {create:true});
    return rootDir;
  }
  async function dir(){
    if(myDir) return myDir;
    myDir = await (await root()).getDirectoryHandle(SESSION, {create:true});
    return myDir;
  }

  // Probe once. A browser can advertise the API and still refuse to use it
  // (private mode, blocked site data), so actually write a byte.
  async function probe(){
    if(available !== null) return available;
    try{
      const d = await dir();
      const h = await d.getFileHandle('.probe', {create:true});
      const w = await h.createWritable();
      await w.write(new Uint8Array([1]));
      await w.close();
      await d.removeEntry('.probe').catch(()=>{});
      available = true;
    }catch(_){ available = false; }
    return available;
  }

  async function removeFile(name){
    if(!name) return;
    try{ const d = await dir(); await d.removeEntry(name); }catch(_){}
  }

  // Stop a record writing and drop its buffers. Never touches filenames — the
  // caller owns that, because only the caller knows whether the name has since
  // been handed to a newer transfer.
  async function retire(rec){
    if(!rec) return;
    if(rec.writable){
      try{ await rec.chain; }catch(_){}
      try{ await rec.writable.abort(); }catch(_){}
    }
    rec.queue.length = 0;
  }

  // MUST register the record synchronously. Chunks arrive straight from a
  // BroadcastChannel handler, which cannot await — so if this were async, every
  // chunk that landed before the OPFS file was open would find no record and be
  // silently dropped, and the clip would never arrive at all.
  function begin(itemId, meta){
    // Retire the previous transfer BY VALUE, synchronously, before the new one
    // exists. Its filename is captured here and is never reused, so the async
    // cleanup below cannot delete the file the new transfer is about to write.
    const prevRec  = pending.get(itemId);
    const prevName = nameOf.get(itemId);
    pending.delete(itemId);
    nameOf.delete(itemId);
    if(prevRec) retire(prevRec).then(()=>removeFile(prevName));
    else removeFile(prevName);

    const rec = { meta: meta || {}, queue: [], backend: 'blob',
                  handle: null, writable: null, chain: Promise.resolve(),
                  bytes: 0, failed: false, error: null, name: null };
    pending.set(itemId, rec);
    const size = (meta && meta.size) || 0;
    rec.ready = (async () => {
      if(size < SMALL) return 'blob';           // small: memory is simpler
      if(noDisk.has(itemId)) return 'blob';     // disk already refused this one
      if(!(await probe())) return 'blob';       // no OPFS here
      try{
        const d = await dir();
        const name = newName(itemId);
        rec.handle = await d.getFileHandle(name, {create:true});
        rec.writable = await rec.handle.createWritable();
        rec.name = name;
        nameOf.set(itemId, name);
        rec.backend = 'opfs';
        const q = rec.queue; rec.queue = [];    // drain what arrived meanwhile
        for(const b of q) rec.chain = rec.chain.then(()=>rec.writable.write(b));
        return 'opfs';
      }catch(_){ rec.backend = 'blob'; rec.handle = null; rec.writable = null; return 'blob'; }
    })();
    return rec.ready;
  }

  function write(itemId, buf){
    const rec = pending.get(itemId);
    if(!rec || rec.failed) return;
    rec.bytes += (buf && buf.byteLength) || 0;
    if(rec.writable){
      rec.chain = rec.chain.then(()=>rec.writable.write(buf)).catch(err=>{
        rec.failed = true; rec.error = err;   // surfaced by finish()
      });
    } else {
      rec.queue.push(buf);   // still opening, or staying in memory
    }
  }

  async function finish(itemId){
    const rec = pending.get(itemId);
    if(!rec) return null;
    pending.delete(itemId);
    try{ await rec.ready; }catch(_){}
    if(rec.backend === 'blob'){
      const blob = new Blob(rec.queue, {type: rec.meta.mime || ''});
      rec.queue.length = 0;
      return { file: blob, backend: 'blob', size: blob.size };
    }
    try{
      await rec.chain;
      if(rec.failed) throw rec.error || new Error('write failed');
      await rec.writable.close();
      const f = await rec.handle.getFile();
      return { file: f, backend: 'opfs', size: f.size, name: rec.name };
    }catch(err){
      try{ await rec.writable.abort(); }catch(_){}
      // Only drop the file if this transfer still owns the name; a newer
      // begin() may already have taken the item over.
      if(nameOf.get(itemId) === rec.name){ nameOf.delete(itemId); await removeFile(rec.name); }
      throw err;
    }
  }

  // Release ONE named file. This is what a stored item must use on disposal:
  // releasing by itemId instead deletes whatever file that id owns NOW, and
  // during a re-transfer that is the INCOMING file — so replacing an item
  // deleted its own new backing store the moment it was stored.
  async function releaseFile(name){
    if(!name) return;
    for(const [id, n] of nameOf) if(n === name) nameOf.delete(id);
    await removeFile(name);
  }

  // Drop an in-flight transfer AND the file this item currently owns.
  async function release(itemId){
    const rec  = pending.get(itemId);
    const name = nameOf.get(itemId);
    pending.delete(itemId);
    nameOf.delete(itemId);
    await retire(rec);
    await removeFile(name);
  }

  // ── Cross-tab reclaim ─────────────────────────────────────────────
  // A crashed session leaves a directory nobody owns, and only a sweep can
  // reclaim it. But a LIVE second tab's directory looks identical from here,
  // so the caller supplies the set of session ids currently answering — see
  // the display-alive handshake in display.html. Never removes our own.
  async function purgeStale(aliveIds){
    try{
      const r = await root();
      const alive = new Set(aliveIds || []);
      alive.add(SESSION);
      const names = [];
      for await (const name of r.keys()) names.push(name);
      let removed = 0;
      for(const n of names){
        if(alive.has(n)) continue;
        try{ await r.removeEntry(n, {recursive:true}); removed++; }catch(_){}
      }
      return removed;
    }catch(_){ return 0; }
  }

  // Best-effort tidy on close. The sweep above is the real reclaim, because
  // this never runs on a crash — which is exactly when it would be needed.
  async function purgeSelf(){
    try{
      const r = await root();
      await r.removeEntry(SESSION, {recursive:true});
      myDir = null; nameOf.clear();
    }catch(_){}
  }

  async function estimate(){
    try{
      if(!(navigator.storage && navigator.storage.estimate)) return null;
      const e = await navigator.storage.estimate();
      return { quota: e.quota || 0, usage: e.usage || 0 };
    }catch(_){ return null; }
  }

  // Disk refused this item (almost always quota — an incognito window gets a
  // far smaller OPFS allowance than navigator.storage.estimate() advertises).
  // Marking it sends the retry to memory instead of repeating a doomed write.
  function markNoDisk(itemId){ noDisk.add(itemId); }

  return { begin, write, finish, release, releaseFile, purgeStale, purgeSelf, probe, estimate, markNoDisk,
           get session(){ return SESSION; },
           get inflight(){ return pending.size; },
           get held(){ return nameOf.size; },
           get SMALL(){ return SMALL; },
           __setSmall(n){ SMALL = n; },     // test seam; see comment on SMALL
           // Test seam: what is ACTUALLY on disk, so a test can assert that the
           // bookkeeping in nameOf matches the filesystem. Chrome keeps an
           // unlinked file readable through an already-open handle, so reading
           // the returned File back proves nothing about whether the entry
           // still exists.
           async __listFiles(){
             try{ const d = await dir(); const out=[]; for await (const n of d.keys()) out.push(n); return out; }
             catch(_){ return []; }
           } };
})();
