// ══════════════════════════════════════════════════════════════════
//  Phase 0 measurement spike — replaces guesses with numbers.
//
//  Answers, on THIS machine:
//    1. What quota does Chrome really grant? (throwaway vs persistent profile)
//    2. How large an in-memory Blob can be read back before it fails?
//    3. Does OPFS createWritable really need 2x the space?
//    4. Do mode:'exclusive' or a worker SyncAccessHandle avoid that?
//    5. THE DECISIVE ONE: can <video> play a multi-GB OPFS-backed file?
//
//  Usage:  node tests/storage-probe.js [pathToBigVideo]
//  Everything it writes is cleaned up; the profile dir is temporary.
// ══════════════════════════════════════════════════════════════════
const { chromium } = require('@playwright/test');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');

// Optional: pass a path to a LARGE video to test multi-GB OPFS playback.
// Without one, steps 1-4 still run and report this machine's real numbers.
const BIG = process.argv[2] || process.env.THROW_BIG_FILE || null;
const GB = (n) => (n / 1073741824).toFixed(2) + ' GB';

const WORKER_JS = `
self.onmessage = async (e) => {
  const { name, totalMB, chunkMB } = e.data;
  try {
    const dir = await navigator.storage.getDirectory();
    const h = await dir.getFileHandle(name, { create: true });
    if (!h.createSyncAccessHandle) { self.postMessage({ ok:false, err:'createSyncAccessHandle unavailable' }); return; }
    const ah = await h.createSyncAccessHandle();
    const chunk = new Uint8Array(chunkMB * 1048576);
    let off = 0;
    const total = totalMB * 1048576;
    while (off < total) { const n = Math.min(chunk.length, total - off); ah.write(chunk.subarray(0, n), { at: off }); off += n; }
    ah.flush(); const size = ah.getSize(); ah.close();
    self.postMessage({ ok:true, size });
  } catch (err) { self.postMessage({ ok:false, err: err.name + ': ' + err.message }); }
};
`;

const PAGE = `<!doctype html><title>storage probe</title><input type="file" id="f">`;

function serve() {
  return http.createServer((q, r) => {
    if (q.url.startsWith('/worker.js')) { r.writeHead(200, {'Content-Type':'text/javascript'}); r.end(WORKER_JS); return; }
    r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(PAGE);
  });
}

async function estimate(p) { return p.evaluate(() => navigator.storage.estimate()); }

(async () => {
  const srv = serve();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const URLBASE = 'http://127.0.0.1:' + srv.address().port + '/';
  const results = [];

  // ── 1. Quota: throwaway profile vs persistent profile ─────────────
  console.log('── 1. Storage quota by profile type ──');
  {
    const b = await chromium.launch();
    const p = await (await b.newContext()).newPage();
    await p.goto(URLBASE);
    const e = await estimate(p);
    console.log('  bundled Chromium, throwaway profile : quota ' + GB(e.quota));
    results.push(['quota (throwaway, bundled)', GB(e.quota)]);
    await b.close();
  }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'throw-probe-'));
  let ctx;
  try { ctx = await chromium.launchPersistentContext(profileDir, { channel: 'chrome' }); console.log('  (persistent profile on installed Chrome)'); }
  catch { ctx = await chromium.launchPersistentContext(profileDir, {}); console.log('  (persistent profile on bundled Chromium — Chrome unavailable)'); }
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('     console: ' + m.text().slice(0, 110)); });
  await page.goto(URLBASE);
  {
    const e = await estimate(page);
    console.log('  installed Chrome, persistent profile: quota ' + GB(e.quota) + ', used ' + GB(e.usage));
    results.push(['quota (persistent, Chrome)', GB(e.quota)]);
  }

  // ── 2. In-memory Blob ceiling ─────────────────────────────────────
  console.log('\n── 2. Largest in-memory Blob that can be READ BACK ──');
  const canRead = async (mb) => page.evaluate(async (mb) => {
    const CH = 64 * 1048576, parts = [];
    try { for (let i = 0; i < Math.ceil(mb / 64); i++) parts.push(new ArrayBuffer(Math.min(CH, mb * 1048576 - i * CH))); }
    catch { return false; }
    let url;
    try { const bl = new Blob(parts); parts.length = 0; url = URL.createObjectURL(bl);
          const r = await fetch(url); const b2 = await r.blob(); URL.revokeObjectURL(url); return b2.size > 0; }
    catch { if (url) URL.revokeObjectURL(url); return false; }
  }, mb);
  let lo = 256, hi = 4096;
  if (!(await canRead(lo))) { console.log('  even ' + lo + ' MB failed'); hi = lo; }
  else {
    while (hi - lo > 128) {
      const mid = Math.floor((lo + hi) / 2);
      const ok = await canRead(mid);
      console.log('    ' + String(mid).padStart(5) + ' MB  ' + (ok ? 'readable' : 'FAILED'));
      if (ok) lo = mid; else hi = mid;
    }
  }
  console.log('  => in-memory blob ceiling is between ' + lo + ' and ' + hi + ' MB');
  results.push(['in-memory blob ceiling', lo + '–' + hi + ' MB']);

  // ── 3/4. OPFS write amplification, and ways to avoid it ───────────
  console.log('\n── 3. OPFS write amplification (does createWritable need 2x?) ──');
  const opfsWrite = async (mb, opts) => page.evaluate(async ({ mb, opts }) => {
    const before = (await navigator.storage.estimate()).usage;
    try {
      const dir = await navigator.storage.getDirectory();
      const h = await dir.getFileHandle('amp.bin', { create: true });
      const w = await h.createWritable(opts || undefined);
      const CH = 32 * 1048576, chunk = new ArrayBuffer(CH);
      let peak = before, off = 0, total = mb * 1048576;
      while (off < total) {
        const n = Math.min(CH, total - off);
        await w.write(n === CH ? chunk : chunk.slice(0, n));
        off += n;
        if (off % (256 * 1048576) === 0) {
          const u = (await navigator.storage.estimate()).usage;
          if (u > peak) peak = u;
        }
      }
      await w.close();
      const after = (await navigator.storage.estimate()).usage;
      const f = await h.getFile();
      await dir.removeEntry('amp.bin').catch(() => {});
      return { ok: true, fileSize: f.size, peakDelta: peak - before, finalDelta: after - before };
    } catch (e) {
      try { const dir = await navigator.storage.getDirectory(); await dir.removeEntry('amp.bin'); } catch {}
      return { ok: false, err: e.name + ': ' + e.message };
    }
  }, { mb, opts });

  for (const [label, opts] of [['createWritable (default)', null], ["createWritable {mode:'exclusive'}", { mode: 'exclusive' }]]) {
    const r = await opfsWrite(1024, opts);
    console.log('  ' + label.padEnd(34) + (r.ok
      ? 'wrote ' + GB(r.fileSize) + ' | peak usage +' + GB(r.peakDelta) + ' | amplification ' + (r.peakDelta / r.fileSize).toFixed(2) + 'x'
      : 'ERROR ' + r.err));
    if (r.ok) results.push([label + ' amplification', (r.peakDelta / r.fileSize).toFixed(2) + 'x']);
  }

  console.log('\n── 4. Worker + createSyncAccessHandle (writes in place) ──');
  {
    const r = await page.evaluate(async (base) => {
      const before = (await navigator.storage.estimate()).usage;
      const w = new Worker(base + 'worker.js');
      const res = await new Promise(rs => { w.onmessage = e => rs(e.data); w.postMessage({ name:'sync.bin', totalMB:1024, chunkMB:32 }); });
      w.terminate();
      const after = (await navigator.storage.estimate()).usage;
      try { const dir = await navigator.storage.getDirectory(); await dir.removeEntry('sync.bin'); } catch {}
      return { ...res, delta: after - before };
    }, URLBASE);
    console.log('  ' + (r.ok ? 'wrote ' + GB(r.size) + ' | usage +' + GB(r.delta) + ' | amplification ' + (r.delta / r.size).toFixed(2) + 'x'
                             : 'ERROR ' + r.err));
    if (r.ok) results.push(['worker SyncAccessHandle amplification', (r.delta / r.size).toFixed(2) + 'x']);
  }

  // ── 5. THE DECISIVE TEST: play a real multi-GB file from OPFS ─────
  console.log('\n── 5. Can <video> play a multi-GB OPFS-backed file? ──');
  if (!BIG || !fs.existsSync(BIG)) {
    console.log('  skipped — pass a large video path to test this:');
    console.log('           node tests/storage-probe.js "D:/clips/big.mp4"');
  } else {
    const realSize = fs.statSync(BIG).size;
    console.log('  source: ' + path.basename(BIG) + ' (' + GB(realSize) + ')');
    await page.setInputFiles('#f', BIG);
    const r = await page.evaluate(async () => {
      const file = document.getElementById('f').files[0];
      const t0 = performance.now();
      try {
        const dir = await navigator.storage.getDirectory();
        const h = await dir.getFileHandle('big.mp4', { create: true });
        const w = await h.createWritable();
        const CH = 8 * 1048576;
        // Stream it exactly the way the display would: slice, read, write.
        for (let off = 0; off < file.size; off += CH) {
          await w.write(await file.slice(off, Math.min(off + CH, file.size)).arrayBuffer());
        }
        await w.close();
        const f = await h.getFile();
        const wrote = performance.now() - t0;
        const url = URL.createObjectURL(f);
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.src = url;
        document.body.appendChild(v);
        const outcome = await new Promise(rs => {
          const done = (o) => rs(o);
          v.addEventListener('error', () => done({ stage:'error', code: v.error ? v.error.code : null }));
          v.addEventListener('loadeddata', () => done({ stage:'loadeddata' }));
          setTimeout(() => done({ stage:'timeout', readyState: v.readyState }), 45000);
        });
        let advanced = null;
        if (outcome.stage === 'loadeddata') {
          await v.play().catch(() => {});
          const a = v.currentTime; await new Promise(rs => setTimeout(rs, 2000));
          advanced = +(v.currentTime - a).toFixed(2);
        }
        const opfsSize = f.size;
        v.pause(); v.removeAttribute('src'); v.load();
        URL.revokeObjectURL(url);
        await dir.removeEntry('big.mp4').catch(() => {});
        return { ok:true, opfsSize, writeSec:+(wrote/1000).toFixed(1), outcome, advanced,
                 readyState: v.readyState, err: v.error ? v.error.code : null };
      } catch (e) {
        try { const dir = await navigator.storage.getDirectory(); await dir.removeEntry('big.mp4'); } catch {}
        return { ok:false, err: e.name + ': ' + e.message };
      }
    });
    if (!r.ok) { console.log('  FAILED: ' + r.err); results.push(['multi-GB OPFS playback', 'FAILED: ' + r.err]); }
    else {
      console.log('  wrote to OPFS in ' + r.writeSec + 's, file size ' + r.opfsSize + ' (exact: ' + (r.opfsSize === realSize) + ')');
      console.log('  video: ' + JSON.stringify(r.outcome) + '  advanced=' + r.advanced + 's');
      const played = r.outcome.stage === 'loadeddata' && r.advanced > 0.1;
      console.log('  => ' + (played ? 'PLAYS. OPFS lifts the ceiling.' : 'DOES NOT PLAY.'));
      results.push(['multi-GB OPFS playback', played ? 'PLAYS' : 'does not play']);
    }
  }

  console.log('\n══ SUMMARY ══');
  for (const [k, v] of results) console.log('  ' + k.padEnd(38) + v);

  await ctx.close(); srv.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
})();
