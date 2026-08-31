// Drives the real two-tab flow with REAL capture files and reports what the
// display actually ends up with. Usage:
//   node tests/real-media.js <count>            (default 2, smallest first)
//   node tests/real-media.js all
// Requires MEDIA_DIR to point at a folder of real clips:
//   MEDIA_DIR="D:/clips" node tests/real-media.js 3
const { chromium } = require('@playwright/test');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');

// No default: this script reads whatever real clips YOU point it at. Set
// MEDIA_DIR, or pass a directory as the last argument.
const MEDIA_DIR = process.env.MEDIA_DIR || process.env.THROW_MEDIA_DIR || null;
const ARG = process.argv[2] || '2';

const root = path.resolve(__dirname, '..', 'app');
const srv = http.createServer((q, r) => {
  const fp = path.resolve(root, '.' + (q.url === '/' ? '/THROW.html' : decodeURIComponent(q.url.split('?')[0])));
  if (fp !== root && !fp.startsWith(root + path.sep)) { r.writeHead(403); r.end(); return; }
  try {
    const d = fs.readFileSync(fp);
    r.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript' }[path.extname(fp)] || 'text/plain' });
    r.end(d);
  } catch { r.writeHead(404); r.end('nf'); }
});

const MB = (n) => (n / 1048576).toFixed(0) + ' MB';

(async () => {
  if (!MEDIA_DIR || !fs.existsSync(MEDIA_DIR)) {
    console.error([
      'Point this at a folder of real video files:',
      '  MEDIA_DIR="D:/clips" npm run test:media 6',
      '  MEDIA_DIR="D:/clips" node tests/real-media.js all',
      MEDIA_DIR ? '' : null,
      MEDIA_DIR ? '(not found: ' + MEDIA_DIR + ')' : null
    ].filter(l => l !== null).join('\n'));
    process.exit(2);
  }
  const files = fs.readdirSync(MEDIA_DIR)
    .filter(f => /\.(mp4|mkv|mov|webm|m4v)$/i.test(f))
    .map(f => ({ name: f, full: path.join(MEDIA_DIR, f), size: fs.statSync(path.join(MEDIA_DIR, f)).size }))
    .sort((a, b) => process.env.MEDIA_PICK === 'largest' ? b.size - a.size : a.size - b.size);
  if (!files.length) { console.error('no video files in ' + MEDIA_DIR); process.exit(1); }
  if (process.env.MEDIA_MATCH) {
    const m = process.env.MEDIA_MATCH.toLowerCase();
    const hit = files.filter(f => f.name.toLowerCase().includes(m));
    if (!hit.length) { console.error('no file matching ' + m); process.exit(1); }
    files.length = 0; files.push(...hit);
  }

  const picked = ARG === 'all' ? files : files.slice(0, parseInt(ARG, 10) || 2);
  console.log('Using ' + picked.length + ' of ' + files.length + ' clips from ' + MEDIA_DIR + ':');
  for (const f of picked) console.log('  ' + MB(f.size).padStart(8) + '  ' + f.name);
  console.log('');

  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/THROW.html`;
  // Default to the INSTALLED Chrome, not the bundled Chromium: the bundled
  // build has no HEVC, and screen captures are frequently HEVC — testing there
  // reports a codec failure that the user's real browser would never hit.
  // BROWSER=chromium forces the bundled one.
  // A PERSISTENT profile, not browser.newContext(). newContext() gives an
  // incognito-style context, and incognito gets a drastically smaller OPFS
  // allowance than navigator.storage.estimate() advertises — a 2.7GB clip dies
  // with QuotaExceededError there while succeeding in a normal window. Testing
  // in incognito would condemn a feature that works fine for real users.
  // Installed Chrome by default too: the bundled Chromium has no HEVC, and game
  // captures often do.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'throw-media-'));
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir,
      { channel: 'chrome', viewport: { width: 1400, height: 900 } });
    console.log('(installed Chrome, persistent profile)\n');
  } catch {
    ctx = await chromium.launchPersistentContext(profileDir,
      { viewport: { width: 1400, height: 900 } });
    console.log('(bundled Chromium, persistent profile — no HEVC)\n');
  }

  const editor = await ctx.newPage();
  const edErrors = [];
  editor.on('pageerror', e => edErrors.push('editor pageerror: ' + e.message));
  await editor.goto(base, { waitUntil: 'domcontentloaded' });
  if (await editor.locator('#helpClose').isVisible()) await editor.locator('#helpClose').click();

  const display = await ctx.newPage();
  const dpErrors = [];
  display.on('pageerror', e => dpErrors.push('display pageerror: ' + e.message));
  await display.goto(base.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(400);

  // Load each clip onto its own surface, exactly as a user would.
  await editor.bringToFront();
  for (let i = 0; i < picked.length; i++) {
    const t0 = Date.now();
    await editor.click('#btnAdd');
    await editor.waitForTimeout(120);
    await editor.setInputFiles('#mediaLoad', picked[i].full);
    await editor.waitForTimeout(300);
    console.log('  loaded #' + (i + 1) + ' ' + picked[i].name + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's into the editor)');
  }

  // Give the transfer time proportional to the payload.
  const totalBytes = picked.reduce((a, f) => a + f.size, 0);
  // disk-backed transfer is steady but not instant; allow ~45ms/MB and a
  // generous ceiling so multi-GB sets are not cut off mid-transfer
  const waitMs = Math.min(600000, 30000 + totalBytes / 1048576 * 45);
  console.log('\nwaiting up to ' + (waitMs / 1000).toFixed(0) + 's for transfer + playback...\n');

  const deadline = Date.now() + waitMs;
  let report = null;
  while (Date.now() < deadline) {
    await display.waitForTimeout(2500);
    report = await display.evaluate(() => {
      const out = [];
      for (const s of window.surfaceList || []) {
        const st = window.plState(s.id);
        out.push({ id: s.id, items: st ? st.items : 0, cur: st ? st.cur : null,
                   order: st ? st.order.length : 0 });
      }
      return { surfaces: out, vids: window.__vidStats ? window.__vidStats() : null };
    });
    const got = report.surfaces.filter(s => s.items > 0).length;
    process.stdout.write('  display holds media for ' + got + '/' + report.surfaces.length + ' surfaces\r');
    if (got === picked.length) break;
  }
  console.log('');

  // Are the videos actually MOVING?
  const playing = await display.evaluate(async () => {
    const vids = [...document.querySelectorAll('video')];
    const t0 = vids.map(v => v.currentTime);
    await new Promise(r => setTimeout(r, 1500));
    return vids.map((v, i) => ({
      readyState: v.readyState, paused: v.paused,
      advanced: +(v.currentTime - t0[i]).toFixed(2),
      err: v.error ? v.error.code : null
    }));
  });

  const banners = {
    editor: await editor.evaluate(() => {
      const b = document.getElementById('errBanner');
      return b.style.display === 'block' ? document.getElementById('errMsg').textContent : null;
    }),
    display: await display.evaluate(() => {
      const b = document.getElementById('banner');
      return b.style.display === 'block' ? b.textContent : null;
    })
  };

  console.log('RESULT');
  console.log('  surfaces in display : ' + report.surfaces.length);
  console.log('  with media received : ' + report.surfaces.filter(s => s.items > 0).length);
  console.log('  <video> elements    : ' + playing.length);
  playing.forEach((p, i) => console.log('    #' + (i + 1) + ' readyState=' + p.readyState +
    ' paused=' + p.paused + ' advanced=' + p.advanced + 's' + (p.err ? ' ERRCODE=' + p.err : '')));
  console.log('  editor banner : ' + (banners.editor || 'none'));
  console.log('  display banner: ' + (banners.display || 'none'));
  if (edErrors.length || dpErrors.length) console.log('  page errors: ' + [...edErrors, ...dpErrors].join(' | '));

  const ok = report.surfaces.filter(s => s.items > 0).length === picked.length
          && playing.length === picked.length && playing.every(p => p.advanced > 0.1);
  console.log('\n' + (ok ? 'PASS — every clip transferred and is playing' : 'FAIL — see above'));

  await ctx.close(); srv.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exit(ok ? 0 : 1);
})();
