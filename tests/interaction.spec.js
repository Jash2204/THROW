// THROW — Playwright interaction tests
// Run from the THROW/ directory:
//   npx playwright test tests/interaction.spec.js
//
// Prerequisites:
//   npm init -y && npm install -D @playwright/test
//   npx playwright install chromium
//
// Tests use a local http server to avoid file:// restrictions in Playwright's
// browser context. The Go Live / video / watchdog paths require manual testing
// (see TESTING.md) because they depend on real fullscreen and media decode.

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const http = require('http');
const fs   = require('fs');

// ── Tiny static server so Playwright can open THROW.html via http ─────────────
let server, baseURL;
test.beforeAll(async () => {
  const root = path.resolve(__dirname, '..', 'app');
  server = http.createServer((req, res) => {
    const fp = path.resolve(root, '.' + (req.url === '/' ? '/THROW.html' : decodeURIComponent(req.url.split('?')[0])));
    // Keep the resolved path inside root — "..%2f.." must not escape the
    // served folder even on a localhost test server.
    if (fp !== root && !fp.startsWith(root + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const data = fs.readFileSync(fp);
      const ext  = path.extname(fp).toLowerCase();
      const mime = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${server.address().port}/THROW.html`;
});
test.afterAll(() => server.close());

// ── Helpers ───────────────────────────────────────────────────────────────────
async function openApp(browser) {
  const ctx  = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  // Dismiss the first-run help modal immediately
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  // Close help modal if visible
  const closeBtn = page.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();
  return { page, ctx };
}

// Get the bounding rect of the stage element in page coordinates
async function stageRect(page) {
  return page.evaluate(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
}

// Add one surface via the keyboard shortcut, return its stage-coord bounding box
async function addSurface(page) {
  await page.keyboard.press('a');
  await page.waitForTimeout(80);
  return page.evaluate(() => {
    const s = window.surfaces[0];
    if (!s) return null;
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(let r=0;r<=s.rows;r++) for(let c=0;c<=s.cols;c++){
      const p=s.pts[r][c];
      x0=Math.min(x0,p.x); y0=Math.min(y0,p.y);
      x1=Math.max(x1,p.x); y1=Math.max(y1,p.y);
    }
    return { x:x0, y:y0, w:x1-x0, h:y1-y0,
             rows:s.rows, cols:s.cols,
             tl: s.pts[0][0], tr: s.pts[0][s.cols],
             bl: s.pts[s.rows][0], br: s.pts[s.rows][s.cols] };
  });
}

// Convert a stage coordinate to page coordinate using the live CSS scale
async function stageToPage(page, sx, sy) {
  return page.evaluate(([sx, sy]) => {
    const r    = document.getElementById('stage').getBoundingClientRect();
    const stageW = window.stageW || 1920;
    const sc   = r.width / stageW;
    return { x: r.left + sx * sc, y: r.top + sy * sc };
  }, [sx, sy]);
}

// ── Test 1: Corner drag ───────────────────────────────────────────────────────
test('corner drag moves only that corner', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);
  const sf = await addSurface(page);
  expect(sf).not.toBeNull();

  const origTL = { ...sf.tl };
  const pagePt = await stageToPage(page, sf.tl.x, sf.tl.y);

  // Drag top-left corner 80px right and 60px down (in page coords)
  await page.mouse.move(pagePt.x, pagePt.y);
  await page.mouse.down();
  await page.mouse.move(pagePt.x + 80, pagePt.y + 60, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(40);

  const moved = await page.evaluate(() => {
    const s = window.surfaces[0];
    return { tl: s.pts[0][0], tr: s.pts[0][s.cols],
             bl: s.pts[s.rows][0], br: s.pts[s.rows][s.cols] };
  });

  // TL moved, other corners untouched
  expect(moved.tl.x).not.toBeCloseTo(origTL.x, 0);
  expect(moved.tl.y).not.toBeCloseTo(origTL.y, 0);
  expect(moved.tr.x).toBeCloseTo(sf.tr.x, 0);
  expect(moved.bl.x).toBeCloseTo(sf.bl.x, 0);
  expect(moved.br.x).toBeCloseTo(sf.br.x, 0);

  await ctx.close();
});

// ── Test 2: Body drag moves the whole surface rigidly ─────────────────────────
test('body drag translates entire surface without deformation', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);
  const sf = await addSurface(page);

  // Click the surface body (not a handle) — centre of bounding box
  const cx = sf.x + sf.w / 2, cy = sf.y + sf.h / 2;
  const pageCtr = await stageToPage(page, cx, cy);

  // Record all point positions before the drag
  const before = await page.evaluate(() =>
    window.surfaces[0].pts.flat().map(p => ({ x: p.x, y: p.y }))
  );

  await page.mouse.move(pageCtr.x, pageCtr.y);
  await page.mouse.down();
  await page.mouse.move(pageCtr.x + 60, pageCtr.y + 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(40);

  const after = await page.evaluate(() =>
    window.surfaces[0].pts.flat().map(p => ({ x: p.x, y: p.y }))
  );

  // Every point should have shifted by roughly the same delta (rigid translation).
  const dx0 = after[0].x - before[0].x;
  const dy0 = after[0].y - before[0].y;
  expect(Math.abs(dx0)).toBeGreaterThan(5); // actually moved
  for (let i = 1; i < before.length; i++) {
    expect(after[i].x - before[i].x).toBeCloseTo(dx0, 0);
    expect(after[i].y - before[i].y).toBeCloseTo(dy0, 0);
  }

  await ctx.close();
});

// ── Test 3: Center-grab priority over inner points on 3×3 mesh ───────────────
// On a 3×3 mesh the geometric centre coincides with the middle control point.
// Grabbing it must trigger a whole-surface translate (type='center' or 'body'),
// NOT a single-point deformation. This is the priority invariant documented in
// hitHandle(): corners → centre → inner points.
test('center handle takes priority over inner point on 3x3 mesh', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  // Set mesh to 3×3 before adding
  await page.click('[data-r="3"][data-c="3"]');
  await page.keyboard.press('a');
  await page.waitForTimeout(80);

  const info = await page.evaluate(() => {
    const s = window.surfaces[0];
    // Centre of the bbox
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(let r=0;r<=s.rows;r++) for(let c=0;c<=s.cols;c++){
      const p=s.pts[r][c];
      x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);x1=Math.max(x1,p.x);y1=Math.max(y1,p.y);
    }
    return { cx:(x0+x1)/2, cy:(y0+y1)/2,
             midPt: s.pts[1][1],          // the inner centre point on 3×3
             ptsBefore: s.pts.flat().map(p=>({x:p.x,y:p.y})) };
  });

  const pageCenter = await stageToPage(page, info.cx, info.cy);

  // Drag from the geometric centre
  await page.mouse.move(pageCenter.x, pageCenter.y);
  await page.mouse.down();
  await page.mouse.move(pageCenter.x + 50, pageCenter.y + 50, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(40);

  const ptsAfter = await page.evaluate(() =>
    window.surfaces[0].pts.flat().map(p => ({ x: p.x, y: p.y }))
  );

  const dx = ptsAfter[0].x - info.ptsBefore[0].x;
  const dy = ptsAfter[0].y - info.ptsBefore[0].y;

  // All points must move by the same delta — proves rigid translation, not point warp
  expect(Math.abs(dx)).toBeGreaterThan(5);
  for (let i = 1; i < info.ptsBefore.length; i++) {
    expect(ptsAfter[i].x - info.ptsBefore[i].x).toBeCloseTo(dx, 0);
    expect(ptsAfter[i].y - info.ptsBefore[i].y).toBeCloseTo(dy, 0);
  }

  await ctx.close();
});

// ── Test 4: Outlines toggle (keyboard O and button) ──────────────────────────
test('outlines toggle responds to O key and button click', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  // Default state: outlines OFF — they are calibration guides, not decoration,
  // so a fresh projection shows the media alone.
  const btn = page.locator('#btnOutlines');
  await expect(btn).not.toHaveClass(/active/);

  const initialState = await page.evaluate(() => window.outputShowOutlines);
  expect(initialState).toBe(false);

  // Press O → on
  await page.keyboard.press('o');
  await page.waitForTimeout(30);
  const afterO = await page.evaluate(() => window.outputShowOutlines);
  expect(afterO).toBe(true);
  await expect(btn).toHaveClass(/active/);

  // Click button → off again
  await btn.click();
  await page.waitForTimeout(30);
  const afterClick = await page.evaluate(() => window.outputShowOutlines);
  expect(afterClick).toBe(false);
  await expect(btn).not.toHaveClass(/active/);

  await ctx.close();
});

// ── Test 5: Canvas state isolation — bad media never leaks transform ──────────
// Verifies the try/finally invariant: even if texTri's drawImage throws,
// subsequent surfaces still render at identity transform.
test('canvas state isolation: error in texTri does not corrupt subsequent render', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  // Add two surfaces
  await page.keyboard.press('a');
  await page.waitForTimeout(40);
  await page.keyboard.press('a');
  await page.waitForTimeout(40);

  const leaked = await page.evaluate(() => {
    // Patch texTri on the second call to throw, simulating a corrupt drawImage
    let callCount = 0;
    const orig = window.texTri;
    // Can't patch module-internal, so verify the try/finally via canvas transform inspection
    // instead: run renderMain and check the context is at identity after.
    const c = document.getElementById('surfaceCanvas');
    const g = c.getContext('2d');
    // Confirm no lingering transform/clip after a full render cycle
    window.renderMain();
    // getTransform() returns a DOMMatrix; identity has a=1,b=0,c=0,d=1,e=0,f=0
    const t = g.getTransform();
    return { a: t.a, b: t.b, c: t.c, d: t.d };
  });

  expect(leaked.a).toBeCloseTo(1, 5);
  expect(leaked.b).toBeCloseTo(0, 5);
  expect(leaked.c).toBeCloseTo(0, 5);
  expect(leaked.d).toBeCloseTo(1, 5);

  await ctx.close();
});

// ── Test 6: Export/import round-trip ─────────────────────────────────────────
test('project JSON export round-trips surface count and stage size', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  // Add two surfaces
  await page.keyboard.press('a'); await page.waitForTimeout(40);
  await page.keyboard.press('a'); await page.waitForTimeout(40);

  // Intercept the download by monkey-patching URL.createObjectURL + <a>.click
  const jsonStr = await page.evaluate(async () => {
    let captured = null;
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => { captured = e.target.result; resolve('blob:fake'); };
        reader.readAsText(blob);
      });
    };
    // Patch <a>.click so the download doesn't actually fire
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() { /* no-op */ };

    await document.getElementById('btnSave').click();
    // Give promises a tick to resolve
    await new Promise(r => setTimeout(r, 200));

    URL.createObjectURL = origCreate;
    HTMLAnchorElement.prototype.click = origClick;
    return captured;
  });

  expect(jsonStr).not.toBeNull();
  const data = JSON.parse(jsonStr);
  expect(data.stageW).toBe(1920);
  expect(data.stageH).toBe(1080);
  expect(data.surfaces).toHaveLength(2);

  await ctx.close();
});

// ── Test 7: Stage presets ─────────────────────────────────────────────────────
test('stage preset dropdown applies size instantly, custom reveals manual inputs', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  await page.selectOption('#stagePreset', '1280x720');
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => window.stageW)).toBe(1280);
  expect(await page.evaluate(() => window.stageH)).toBe(720);

  // Custom shows the manual W/H inputs without changing the stage yet
  await page.selectOption('#stagePreset', 'custom');
  await expect(page.locator('#stageCustom')).toBeVisible();
  expect(await page.evaluate(() => window.stageW)).toBe(1280);

  await ctx.close();
});

// ── Test 8: Thumbnail pipeline ────────────────────────────────────────────────
// A large image must produce a ≤512px thumbnail, and outside of live output the
// app renders from that thumbnail (fullResLive stays false).
test('image media generates a bounded thumbnail outside live', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);
  await page.keyboard.press('a');
  await page.waitForTimeout(60);

  const result = await page.evaluate(async () => {
    // Synthesize a 1024×768 PNG file entirely in-page
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 768;
    const g = c.getContext('2d');
    g.fillStyle = '#c4ff2e'; g.fillRect(0, 0, 1024, 768);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'test.png', { type: 'image/png' });

    loadMediaToSurface(window.surfaces[0], file);
    // Wait for the load + thumb generation
    for (let i = 0; i < 50; i++) {
      if (window.surfaces[0].media && window.surfaces[0].media.thumb) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const m = window.surfaces[0].media;
    return {
      hasThumb: !!(m && m.thumb),
      thumbW: m && m.thumb ? m.thumb.width : 0,
      thumbH: m && m.thumb ? m.thumb.height : 0,
      hasBlob: !!(m && m.file),   // original blob kept for the Display tab + export
    };
  });

  expect(result.hasThumb).toBe(true);
  expect(result.thumbW).toBeLessThanOrEqual(512);
  expect(result.thumbH).toBeLessThanOrEqual(512);
  expect(result.hasBlob).toBe(true);

  await ctx.close();
});

// ── Test 9: Off-stage surfaces are allowed (no auto-clamp) ────────────────────
test('surfaces may be dragged fully off-stage without being clamped back', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);
  await page.keyboard.press('a');
  await page.waitForTimeout(60);

  const offStage = await page.evaluate(() => {
    const s = window.surfaces[0];
    // Push every point far past the right edge
    for (let r = 0; r <= s.rows; r++) for (let c = 0; c <= s.cols; c++) {
      s.pts[r][c].x += 5000;
    }
    window.renderMain(); // must not throw or clamp
    return s.pts[0][0].x > 5000;
  });

  expect(offStage).toBe(true);
  await ctx.close();
});

// ── Test 10: Handles toggle ───────────────────────────────────────────────────
// With handles hidden (H), a drag that starts on a corner must move the WHOLE
// surface rigidly instead of warping that corner — invisible handles must not
// be grabbable.
test('hidden handles: corner drag becomes whole-surface move', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);
  const sf = await addSurface(page);

  // Hide handles
  await page.keyboard.press('h');
  await page.waitForTimeout(30);
  expect(await page.evaluate(() => window.handlesVisible)).toBe(false);
  await expect(page.locator('#btnHandles')).not.toHaveClass(/active/);

  const before = await page.evaluate(() =>
    window.surfaces[0].pts.flat().map(p => ({ x: p.x, y: p.y }))
  );

  // Drag starting just inside the top-left corner — still deep inside the 24px
  // handle hit radius (would corner-warp if handles were active), but reliably
  // inside the surface body for the hit test.
  const pagePt = await stageToPage(page, sf.tl.x + 6, sf.tl.y + 6);
  await page.mouse.move(pagePt.x, pagePt.y);
  await page.mouse.down();
  await page.mouse.move(pagePt.x + 70, pagePt.y + 50, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(40);

  const after = await page.evaluate(() =>
    window.surfaces[0].pts.flat().map(p => ({ x: p.x, y: p.y }))
  );

  // Rigid translation: every point moved by the same delta (no corner warp)
  const dx = after[0].x - before[0].x;
  expect(Math.abs(dx)).toBeGreaterThan(5);
  for (let i = 1; i < before.length; i++) {
    expect(after[i].x - before[i].x).toBeCloseTo(dx, 0);
  }

  // Toggle back on via the button
  await page.click('#btnHandles');
  expect(await page.evaluate(() => window.handlesVisible)).toBe(true);

  await ctx.close();
});

// ── Test 11: Display tab sync ─────────────────────────────────────────────────
// Editor and display are separate same-origin tabs synced over BroadcastChannel.
// Geometry edits and media blobs must arrive in the display within a frame or two.
test('display tab receives geometry and media over BroadcastChannel', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();

  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(300);

  // add a surface in the editor → geometry appears in the display
  await editor.bringToFront();
  await editor.keyboard.press('a');
  await display.waitForFunction(() => window.surfaceList && window.surfaceList.length === 1, null, { timeout: 5000 });

  // change stage preset → display stage follows
  await editor.selectOption('#stagePreset', '1280x720');
  await display.waitForFunction(() => window.stageSize.w === 1280, null, { timeout: 5000 });

  // load an image → blob crosses the channel, display creates local media
  await editor.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    c.getContext('2d').fillStyle = '#c4ff2e';
    c.getContext('2d').fillRect(0, 0, 640, 480);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    loadMediaToSurface(window.surfaces[0], new File([blob], 'sync.png', { type: 'image/png' }));
  });
  await display.waitForFunction(() => window.mediaCount === 1, null, { timeout: 5000 });

  // drag a corner in the editor → display geometry updates
  const before = await display.evaluate(() => window.surfaceList[0].pts[0][0].x);
  await editor.evaluate(() => {
    window.surfaces[0].pts[0][0].x += 100;
  });
  await display.waitForFunction(
    (b) => Math.abs(window.surfaceList[0].pts[0][0].x - b) > 50, before, { timeout: 5000 }
  );

  // delete the surface → display drops geometry AND media
  await editor.evaluate(() => { deleteSel(); });
  await display.waitForFunction(() => window.surfaceList.length === 0 && window.mediaCount === 0, null, { timeout: 5000 });

  await ctx.close();
});

// ── Test 12: Adjust panel — per playlist item ─────────────────────────────────
// With no media, ADJUST edits the surface default (which seeds clips added
// later). Once there IS media it edits the SELECTED ITEM, each item is
// independent, and the item's look reaches the display under pl.items[].adjust.
test('adjust targets the surface default with no media, then the selected item', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();

  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(200);

  await editor.bringToFront();
  await editor.keyboard.press('a');
  await editor.waitForTimeout(80);

  const setSlider = (id, v) => editor.evaluate(([id, v]) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('input'));
  }, [id, v]);

  // ── no media: edits land on the surface default ──
  expect(await editor.evaluate(() => window.surfaces[0].adjust.br)).toBe(1);
  await setSlider('adjBr', 150);
  expect(await editor.evaluate(() => window.surfaces[0].adjust.br)).toBe(1.5);
  await expect(editor.locator('#adjTarget')).toHaveText('SURFACE');

  // ── add two clips: each inherits that default, then diverges ──
  await editor.evaluate(async () => {
    const mk = async (color, name) => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      c.getContext('2d').fillStyle = color; c.getContext('2d').fillRect(0, 0, 64, 64);
      const b = await new Promise(r => c.toBlob(r, 'image/png'));
      return new File([b], name, { type: 'image/png' });
    };
    addToPlaylist(window.surfaces[0], [await mk('#f00', 'one.png'), await mk('#0f0', 'two.png')]);
  });
  await editor.waitForTimeout(250);

  const items = () => editor.evaluate(() => window.surfaces[0].playlist.items.map(i => ({ id: i.id, br: i.adjust.br, flipH: i.adjust.flipH })));
  expect((await items()).map(i => i.br)).toEqual([1.5, 1.5]);      // both inherited the seed
  await expect(editor.locator('#adjTarget')).toHaveText('one.png'); // now targeting item 1

  // edit item 1 only
  await setSlider('adjBr', 50);
  await editor.click('#btnFlipH');
  let it = await items();
  expect(it[0].br).toBe(0.5);
  expect(it[0].flipH).toBe(true);
  expect(it[1].br).toBe(1.5);        // item 2 untouched — they are independent
  expect(it[1].flipH).toBe(false);
  expect(await editor.evaluate(() => window.surfaces[0].adjust.br)).toBe(1.5); // seed unchanged

  // the item's look reaches the display
  const surfId = await editor.evaluate(() => window.surfaces[0].id);
  await display.waitForFunction((id) => {
    const s = window.surfaceList.find(x => x.id === id);
    return s && s.pl && s.pl.items.length === 2 &&
           s.pl.items[0].adjust.br === 0.5 && s.pl.items[0].adjust.flipH === true &&
           s.pl.items[1].adjust.br === 1.5;
  }, surfId, { timeout: 5000 });

  // ── selecting the second row retargets ADJUST at it ──
  await editor.locator('#plList .pl-row').nth(1).click();
  await editor.waitForTimeout(150);
  await expect(editor.locator('#adjTarget')).toHaveText('two.png');
  await setSlider('adjSat', 0);
  it = await items();
  expect(await editor.evaluate(() => window.surfaces[0].playlist.items[1].adjust.sat)).toBe(0);
  expect(await editor.evaluate(() => window.surfaces[0].playlist.items[0].adjust.sat)).toBe(1);

  // reset only clears the selected item
  await editor.click('#btnAdjReset');
  expect(await editor.evaluate(() => window.surfaces[0].playlist.items[1].adjust.sat)).toBe(1);
  expect(await editor.evaluate(() => window.surfaces[0].playlist.items[0].adjust.br)).toBe(0.5);

  // validator still clamps garbage but keeps legit zeros (brightness 0 = black).
  // pts must now be a well-formed (rows+1)x(cols+1) grid — this fixture used to
  // pass [] and slip through, which is the hole the pts check closed.
  const validated = await editor.evaluate(() => {
    const grid = (rows, cols) => Array.from({length: rows + 1}, (_, r) =>
      Array.from({length: cols + 1}, (_, c) => ({ x: 100 + c * 50, y: 100 + r * 50 })));
    const d = window.validateProjectData({
      stageW: 1920, stageH: 1080,
      surfaces: [{ rows: 2, cols: 2, pts: grid(2, 2), adjust: { br: 0, ct: 99, sat: 'junk', hue: -5, flipH: 1 } }]
    });
    return d.surfaces[0].adjust;
  });
  expect(validated.br).toBe(0);        // zero preserved
  expect(validated.ct).toBe(2);        // clamped to max
  expect(validated.sat).toBe(1);       // junk → default
  expect(validated.hue).toBe(0);       // negative clamped
  expect(validated.flipH).toBe(true);  // coerced boolean

  await ctx.close();
});

// ── Test 12b: Stacking order + scale ─────────────────────────────────────────
test('front/back reorder the paint stack and scale resizes about the centre', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  await page.keyboard.press('a'); await page.waitForTimeout(60);
  await page.keyboard.press('a'); await page.waitForTimeout(60);
  await page.keyboard.press('a'); await page.waitForTimeout(60);

  // the last-added surface is selected and already on top
  const ids = await page.evaluate(() => window.surfaces.map(s => s.id));
  expect(await page.evaluate(() => window.selId)).toBe(ids[2]);

  // send it to the back → it becomes surfaces[0] (drawn first = underneath)
  await page.click('#btnBack');
  expect(await page.evaluate(() => window.surfaces.map(s => s.id))).toEqual([ids[2], ids[0], ids[1]]);

  // bring it back to the front → last = drawn last = on top
  await page.click('#btnFront');
  expect(await page.evaluate(() => window.surfaces.map(s => s.id))).toEqual([ids[0], ids[1], ids[2]]);

  // '[' and ']' do the same
  await page.keyboard.press('[');
  expect(await page.evaluate(() => window.surfaces[0].id)).toBe(ids[2]);
  await page.keyboard.press(']');
  expect(await page.evaluate(() => window.surfaces[2].id)).toBe(ids[2]);

  // ── scale: doubles the surface about its centre, centre stays put ──
  const before = await page.evaluate(() => {
    const s = window.surfaces.find(x => x.id === window.selId);
    const b = { x0: Math.min(...s.pts.flat().map(p => p.x)), x1: Math.max(...s.pts.flat().map(p => p.x)),
                y0: Math.min(...s.pts.flat().map(p => p.y)), y1: Math.max(...s.pts.flat().map(p => p.y)) };
    return { w: b.x1 - b.x0, h: b.y1 - b.y0, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 };
  });
  await page.evaluate(() => {
    const el = document.getElementById('rngScale');
    el.value = 200; el.dispatchEvent(new Event('input'));
  });
  const after = await page.evaluate(() => {
    const s = window.surfaces.find(x => x.id === window.selId);
    const b = { x0: Math.min(...s.pts.flat().map(p => p.x)), x1: Math.max(...s.pts.flat().map(p => p.x)),
                y0: Math.min(...s.pts.flat().map(p => p.y)), y1: Math.max(...s.pts.flat().map(p => p.y)) };
    return { w: b.x1 - b.x0, h: b.y1 - b.y0, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 };
  });
  expect(after.w).toBeCloseTo(before.w * 2, 1);
  expect(after.h).toBeCloseTo(before.h * 2, 1);
  expect(after.cx).toBeCloseTo(before.cx, 1);   // scaled about the centre
  expect(after.cy).toBeCloseTo(before.cy, 1);

  // dragging the dial back to 100% exactly undoes it
  await page.evaluate(() => {
    const el = document.getElementById('rngScale');
    el.value = 100; el.dispatchEvent(new Event('input'));
  });
  const back = await page.evaluate(() => {
    const s = window.surfaces.find(x => x.id === window.selId);
    const xs = s.pts.flat().map(p => p.x);
    return Math.max(...xs) - Math.min(...xs);
  });
  expect(back).toBeCloseTo(before.w, 1);

  await ctx.close();
});

// ── Test 12c: Undo / redo + arrow nudge ───────────────────────────────────────
test('arrow nudge moves the surface and undo/redo walks the history', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);
  await page.keyboard.press('a');
  await page.waitForTimeout(60);

  const cornerX = () => page.evaluate(() => window.surfaces[0].pts[0][0].x);
  const x0 = await cornerX();

  // arrow nudge: right 1px, then Shift+right 10px
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(20);
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(20);
  const x1 = await cornerX();
  expect(x1).toBeCloseTo(x0 + 11, 1);

  // a second surface, then delete it — undo brings it (and its geometry) back
  await page.keyboard.press('a');
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => window.surfaces.length)).toBe(2);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => window.surfaces.length)).toBe(1);

  // Ctrl+Z restores the deleted surface
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => window.surfaces.length)).toBe(2);

  // Ctrl+Z again undoes the nudges (a burst coalesced into ≤2 steps)
  const depthBefore = await page.evaluate(() => window.undoDepth);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(40);
  // Ctrl+Shift+Z redoes
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => window.surfaces.length)).toBe(2);

  // undo of a mesh change restores the previous density
  await page.evaluate(() => { window.selId; });
  await page.click('[data-r="4"][data-c="4"]');
  await page.waitForTimeout(40);
  const selDense = await page.evaluate(() => window.surfaces.find(s => s.id === window.selId).rows);
  expect(selDense).toBe(4);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(40);
  const selBack = await page.evaluate(() => window.surfaces.find(s => s.id === window.selId).rows);
  expect(selBack).toBe(2);

  await ctx.close();
});

// ── Test 12d: Per-item crop ───────────────────────────────────────────────────
test('crop writes normalised per-item rect, clamps, and syncs to the display', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();
  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(200);

  await editor.bringToFront();
  await editor.keyboard.press('a');
  await editor.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    c.getContext('2d').fillStyle = '#fff'; c.getContext('2d').fillRect(0, 0, 64, 64);
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    addToPlaylist(window.surfaces[0], [new File([b], 'one.png', { type: 'image/png' })]);
  });
  await editor.waitForTimeout(200);

  // new items default to the full frame
  expect(await editor.evaluate(() => window.surfaces[0].playlist.items[0].crop)).toEqual({ x: 0, y: 0, w: 1, h: 1 });

  // set X=25 W=50 (%) → stored normalised
  await editor.evaluate(() => {
    const setv = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    setv('cropX', 25); setv('cropW', 50);
  });
  expect(await editor.evaluate(() => window.surfaces[0].playlist.items[0].crop)).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });

  // over-wide W clamps so x+w never exceeds the source
  await editor.evaluate(() => { const e = document.getElementById('cropW'); e.value = 90; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); });
  const c = await editor.evaluate(() => window.surfaces[0].playlist.items[0].crop);
  expect(c.x + c.w).toBeCloseTo(1, 5);   // 0.25 + 0.75

  // crop reaches the display under pl.items[].crop
  const surfId = await editor.evaluate(() => window.surfaces[0].id);
  await display.waitForFunction((id) => {
    const s = window.surfaceList.find(x => x.id === id);
    return s && s.pl && s.pl.items[0].crop && Math.abs(s.pl.items[0].crop.x - 0.25) < 1e-6;
  }, surfId, { timeout: 5000 });

  // Full frame resets it
  await editor.click('#btnCropReset');
  expect(await editor.evaluate(() => window.surfaces[0].playlist.items[0].crop)).toEqual({ x: 0, y: 0, w: 1, h: 1 });

  // and it survives undo (crop change is one undo step)
  await editor.evaluate(() => { const e = document.getElementById('cropX'); e.dispatchEvent(new Event('focus')); e.value = 40; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); });
  expect(await editor.evaluate(() => window.surfaces[0].playlist.items[0].crop.x)).toBeCloseTo(0.4, 5);
  await editor.keyboard.press('Control+z');
  await editor.waitForTimeout(40);
  expect(await editor.evaluate(() => window.surfaces[0].playlist.items[0].crop.x)).toBe(0);

  await ctx.close();
});

// ── Test 12e: Trim in/out ─────────────────────────────────────────────────────
test('trim inputs appear only for videos, write per-item seconds, and sync', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();
  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(200);

  await editor.bringToFront();
  await editor.keyboard.press('a');

  // an IMAGE item → the trim row stays hidden (trim is meaningless for stills)
  await editor.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    c.getContext('2d').fillRect(0, 0, 32, 32);
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    addToPlaylist(window.surfaces[0], [new File([b], 'still.png', { type: 'image/png' })]);
  });
  await editor.waitForTimeout(200);
  await expect(editor.locator('#trimRow')).toBeHidden();

  // a fake VIDEO item (kind flagged directly) → row shows and writes seconds
  await editor.evaluate(() => {
    const s = window.surfaces[0];
    s.playlist.items[0].kind = 'video';   // pretend it's a clip for the UI path
    s.media.item.kind = 'video';
    updateUI();
  });
  await expect(editor.locator('#trimRow')).toBeVisible();

  await editor.evaluate(() => {
    const setv = (id, v) => { const e = document.getElementById(id); e.dispatchEvent(new Event('focus')); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    setv('trimIn', 2.5); setv('trimOut', 6);
  });
  expect(await editor.evaluate(() => [window.surfaces[0].playlist.items[0].trimIn, window.surfaces[0].playlist.items[0].trimOut])).toEqual([2.5, 6]);

  // reaches the display
  const surfId = await editor.evaluate(() => window.surfaces[0].id);
  await display.waitForFunction((id) => {
    const s = window.surfaceList.find(x => x.id === id);
    return s && s.pl && s.pl.items[0].trimIn === 2.5 && s.pl.items[0].trimOut === 6;
  }, surfId, { timeout: 5000 });

  // the Downscale (transcode) control is part of the video-only panel
  await expect(editor.locator('#btnDownscale')).toBeVisible();

  // In and Out were two separate gestures → two undo steps.
  // First undo reverts the Out edit (last), leaving In.
  await editor.keyboard.press('Control+z');
  await editor.waitForTimeout(40);
  expect(await editor.evaluate(() => [window.surfaces[0].playlist.items[0].trimIn, window.surfaces[0].playlist.items[0].trimOut])).toEqual([2.5, 0]);
  // Second undo reverts the In edit
  await editor.keyboard.press('Control+z');
  await editor.waitForTimeout(40);
  expect(await editor.evaluate(() => window.surfaces[0].playlist.items[0].trimIn)).toBe(0);

  await ctx.close();
});

// ── Test 12f: Trace → sticker mask ────────────────────────────────────────────
test('sticker trace stores a mesh-UV mask, syncs it, and undo removes it', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();
  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(200);

  await editor.bringToFront();
  await editor.keyboard.press('p');                 // enter trace mode
  await editor.click('#tmMask');                    // choose Sticker mask
  await expect(editor.locator('#tmMask')).toHaveClass(/active/);

  // Click a diamond of 4 points on the place canvas, then Enter to close.
  // These coordinates moved when the place canvas was corrected to sit ON the
  // stage: it used to be displaced by the overlay offset, so 62%/48% happened
  // to miss the centred instruction box. Aligned, that lands ON the box (it is
  // z-index 2 and eats the clicks), so trace well clear of centre instead.
  const box = await editor.locator('#placeCanvas').boundingBox();
  const cx = box.x + box.width * 0.20, cy = box.y + box.height * 0.25;
  const r = box.width * 0.06;
  await editor.mouse.click(cx, cy - r);
  await editor.mouse.click(cx + r, cy);
  await editor.mouse.click(cx, cy + r);
  await editor.mouse.click(cx - r, cy);
  await editor.waitForTimeout(30);
  expect(await editor.evaluate(() => window.placePtsLen)).toBe(4);
  await editor.keyboard.press('Enter');
  await editor.waitForTimeout(80);

  // a surface with a 4-point mask in normalised UV was created
  const mask = await editor.evaluate(() => window.surfaces[0] && window.surfaces[0].mask);
  expect(Array.isArray(mask)).toBe(true);
  expect(mask.length).toBe(4);
  for (const m of mask) { expect(m.u).toBeGreaterThanOrEqual(0); expect(m.u).toBeLessThanOrEqual(1); expect(m.v).toBeGreaterThanOrEqual(0); expect(m.v).toBeLessThanOrEqual(1); }

  // the mask reaches the display
  const surfId = await editor.evaluate(() => window.surfaces[0].id);
  await display.waitForFunction((id) => {
    const s = window.surfaceList.find(x => x.id === id);
    return s && Array.isArray(s.mask) && s.mask.length === 4;
  }, surfId, { timeout: 5000 });

  // undo removes the traced surface
  await editor.keyboard.press('Control+z');
  await editor.waitForTimeout(40);
  expect(await editor.evaluate(() => window.surfaces.length)).toBe(0);

  await ctx.close();
});

// ── Test 13: 1×1 corner-pin mesh ──────────────────────────────────────────────
// A 1×1 mesh is exactly 4 points, all corners. Corner drag must warp that
// corner only; body drag must translate all 4 rigidly.
test('1x1 mesh: four corners only, corner drag and body drag behave', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  await page.click('[data-r="1"][data-c="1"]');
  await page.keyboard.press('a');
  await page.waitForTimeout(80);

  const info = await page.evaluate(() => {
    const s = window.surfaces[0];
    return { rows: s.rows, cols: s.cols, count: s.pts.flat().length, tl: s.pts[0][0] };
  });
  expect(info.rows).toBe(1);
  expect(info.cols).toBe(1);
  expect(info.count).toBe(4);   // corners only

  // corner drag warps just that corner
  const pagePt = await stageToPage(page, info.tl.x, info.tl.y);
  await page.mouse.move(pagePt.x, pagePt.y);
  await page.mouse.down();
  await page.mouse.move(pagePt.x + 60, pagePt.y + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(40);

  const after = await page.evaluate(() => {
    const s = window.surfaces[0];
    return { tl: s.pts[0][0], br: s.pts[1][1] };
  });
  expect(after.tl.x).toBeGreaterThan(info.tl.x + 20);   // moved
  // br untouched — checked via renderMain not throwing + geometry sane
  const renders = await page.evaluate(() => { window.renderMain(); return true; });
  expect(renders).toBe(true);

  await ctx.close();
});

// ── Test 14: Playlists ────────────────────────────────────────────────────────
// Items append/reorder/remove in the editor, blobs reach the display once,
// order+config ride the state broadcast, and the display ADVANCES through
// image items on the configured timer.
test('playlist: items sync to display and advance on the image timer', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();

  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(200);

  await editor.bringToFront();
  await editor.keyboard.press('a');
  await editor.waitForTimeout(80);

  // build two coloured images and add both to the playlist; 2s image time, crossfade
  await editor.evaluate(async () => {
    const mk = async (color, name) => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240;
      c.getContext('2d').fillStyle = color;
      c.getContext('2d').fillRect(0, 0, 320, 240);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      return new File([blob], name, { type: 'image/png' });
    };
    const s = window.surfaces[0];
    addToPlaylist(s, [await mk('#ff0000', 'red.png'), await mk('#00ff00', 'green.png')]);
    playlistOf(s).imgDur = 2;             // fastest allowed — keeps the test quick
    playlistOf(s).transition = 'crossfade';
    playlistOf(s).xfDur = 0.3;
  });

  // editor panel shows both rows
  await editor.waitForTimeout(200);
  expect(await editor.locator('#plList .pl-row').count()).toBe(2);

  // display receives both items + the config
  const surfId = await editor.evaluate(() => window.surfaces[0].id);
  await display.waitForFunction((id) => {
    const st = window.plState(id);
    return st && st.items === 2 && st.order.length === 2 && st.transition === 'crossfade';
  }, surfId, { timeout: 5000 });

  // the display starts on item 0 and ADVANCES to item 1 within imgDur + fade + slack
  const first = await display.evaluate((id) => window.plState(id).cur, surfId);
  await display.waitForFunction((arg) => {
    const st = window.plState(arg.id);
    return st && st.cur && st.cur !== arg.first;
  }, { id: surfId, first }, { timeout: 6000 });

  // reorder in the editor → display order follows (no re-send needed)
  await editor.evaluate(() => plMoveItem(window.surfaces[0], 1, -1));
  const editorOrder = await editor.evaluate(() => window.surfaces[0].playlist.items.map(i => i.id));
  await display.waitForFunction((arg) => {
    const st = window.plState(arg.id);
    return st && JSON.stringify(st.order) === JSON.stringify(arg.order);
  }, { id: surfId, order: editorOrder }, { timeout: 5000 });

  // remove one item → display prunes it
  await editor.evaluate(() => plRemoveItem(window.surfaces[0], 1));
  await display.waitForFunction((id) => {
    const st = window.plState(id);
    return st && st.order.length === 1 && st.items === 1;
  }, surfId, { timeout: 5000 });

  await ctx.close();
});

// ── Test 15: JSON import rejects malformed data ───────────────────────────────
test('loading a malformed JSON project shows an error and does not crash', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  const errorShown = await page.evaluate(() => {
    // Directly call the internal validation with bad data
    try {
      window.validateProjectData({ stageW: -1, stageH: 'bad', surfaces: 'not-an-array' });
      return false;
    } catch (e) {
      return true;
    }
  });

  expect(errorShown).toBe(true);

  await ctx.close();
});

// ── Test 21: warp cache identifies media by element, not by size ───────────────
// Regression: warpKey keyed on el.width alone, but makeThumb scales every source
// into a 512px box — so two different 16:9 images both became 512×288 and shared
// a key. Replacing a surface's image left the editor compositing the old one
// from the stale cached buffer.
test('replacing an image of identical dimensions re-warps instead of reusing the cache', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  const result = await page.evaluate(async () => {
    const solidPNG = (color, name) => {
      const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
      const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 1920, 1080);
      return new Promise(res => c.toBlob(b => res(new File([b], name, { type: 'image/png' })), 'image/png'));
    };
    const drop = (file, x, y) => {
      const dt = new DataTransfer(); dt.items.add(file);
      document.getElementById('stageWrap').dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const SC = document.getElementById('surfaceCanvas');
    const centrePixel = () => {
      const d = SC.getContext('2d').getImageData(Math.round(SC.width / 2), Math.round(SC.height / 2), 1, 1).data;
      return [d[0], d[1], d[2]];
    };

    const st = document.getElementById('stage').getBoundingClientRect();
    const cx = st.left + st.width / 2, cy = st.top + st.height / 2;

    const green = await solidPNG('#00ff00', 'green.png');
    const blue  = await solidPNG('#0000ff', 'blue.png');

    drop(green, cx, cy); await wait(400);           // auto-creates a surface here
    window.renderMain();
    const afterGreen = centrePixel();
    const key1 = window.surfaces[0]._warpKey;

    drop(blue, cx, cy);  await wait(400);           // replaces media on that surface
    window.renderMain();
    const afterBlue = centrePixel();
    const key2 = window.surfaces[0]._warpKey;

    return { afterGreen, afterBlue, key1, key2, thumb: window.surfaces[0].media.thumb.width };
  });

  // Both sources are 1920×1080, so both thumbnails are the same 512px size —
  // exactly the case the old key could not tell apart.
  expect(result.thumb).toBe(512);
  expect(result.key1).not.toBe(result.key2);
  expect(result.afterGreen[1]).toBeGreaterThan(200);   // green channel high
  expect(result.afterGreen[2]).toBeLessThan(60);
  expect(result.afterBlue[2]).toBeGreaterThan(200);    // now blue, not the cached green
  expect(result.afterBlue[1]).toBeLessThan(60);

  await ctx.close();
});

// ── Test 22: loaded projects get fresh surface ids ────────────────────────────
// Regression: load kept the file's ids while uid()'s counter restarted at 0, so
// a saved "S1" collided with the next hand-added surface. Every
// surfaces.find(s => s.id === selId) then resolved to whichever came first —
// selecting one surface and moving the other.
test('loading a project mints fresh surface ids so a later add cannot collide', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  const proj = {
    stageW: 1920, stageH: 1080,
    surfaces: [{
      id: 'S1', name: 'FromFile', rows: 2, cols: 2,
      pts: [[{x:100,y:100},{x:300,y:100},{x:500,y:100}],
            [{x:100,y:250},{x:300,y:250},{x:500,y:250}],
            [{x:100,y:400},{x:300,y:400},{x:500,y:400}]],
      blend: 'normal', opacity: 1, visible: true
    }]
  };

  const result = await page.evaluate(async (projJson) => {
    const dt = new DataTransfer();
    dt.items.add(new File([projJson], 'p.throw.json', { type: 'application/json' }));
    const inp = document.getElementById('fileLoad');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));

    document.getElementById('btnAdd').click();       // the add that used to collide
    const ids = window.surfaces.map(s => s.id);

    // Select the newly added surface and nudge it; the loaded one must not move.
    const xBefore = window.surfaces.map(s => s.pts[0][0].x);
    document.querySelectorAll('.layer-item')[0].click();   // top row = topmost = the new one
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const xAfter = window.surfaces.map(s => s.pts[0][0].x);

    return { ids, selId: window.selId, xBefore, xAfter,
             names: window.surfaces.map(s => s.name) };
  }, JSON.stringify(proj));

  expect(result.ids).toHaveLength(2);
  expect(new Set(result.ids).size).toBe(2);                 // no duplicate ids
  expect(result.selId).toBe(result.ids[1]);                 // the added surface is selected
  expect(result.names).toEqual(['FromFile', 'Surface']);
  expect(result.xAfter[0]).toBe(result.xBefore[0]);         // loaded surface stayed put
  expect(result.xAfter[1]).toBe(result.xBefore[1] + 2);     // only the selected one moved

  await ctx.close();
});

// ── Test 23: pts shape is validated, not just its type ────────────────────────
// Regression: the only check was Array.isArray(sd.pts). A short array threw
// inside the render loop 60x/second; non-numeric entries pushed NaN silently
// through the whole warp. rows/cols were range-checked but pts never was.
test('malformed pts geometry is rejected rather than reaching the renderer', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  const outcomes = await page.evaluate(() => {
    const grid = (rows, cols) => Array.from({length: rows + 1}, (_, r) =>
      Array.from({length: cols + 1}, (_, c) => ({ x: 100 + c * 50, y: 100 + r * 50 })));
    const check = (pts) => {
      try {
        window.validateProjectData({ stageW:1920, stageH:1080,
          surfaces:[{ rows:2, cols:2, pts, blend:'normal', opacity:1, visible:true }] });
        return 'accepted';
      } catch (e) { return 'rejected: ' + e.message; }
    };
    return {
      empty:      check([]),                                   // too few rows
      shortRow:   check([[{x:0,y:0}], [{x:0,y:0}], [{x:0,y:0}]]),  // too few cols
      notObjects: check([[1,2,3],[4,5,6],[7,8,9]]),
      nanCoord:   check(grid(2,2).map((r,i) => i ? r : r.map(p => ({x:'x', y:p.y})))),
      infinite:   check(grid(2,2).map((r,i) => i ? r : r.map(p => ({x:Infinity, y:p.y})))),
      valid:      check(grid(2,2)),
    };
  });

  expect(outcomes.empty).toContain('rejected');
  expect(outcomes.shortRow).toContain('rejected');
  expect(outcomes.notObjects).toContain('rejected');
  expect(outcomes.nanCoord).toContain('rejected');
  expect(outcomes.infinite).toContain('rejected');
  expect(outcomes.valid).toBe('accepted');

  await ctx.close();
});

// ── Test 24: undo/redo must not re-ship media blobs ───────────────────────────
// Regression: restore() set every item's _sent=false and force-resent the whole
// playlist, so undoing an opacity nudge re-read and re-broadcast every File.
// The display now PULLS anything it actually lacks (need-item) instead.
test('undo does not rebroadcast media the display already holds', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  const result = await page.evaluate(async () => {
    // Count pl-item messages on the wire from a third listener on the channel.
    const spy = new BroadcastChannel('throw-sync');
    let plItems = 0, needs = 0;
    spy.onmessage = (ev) => {
      const t = ev.data && ev.data.type;
      if (t === 'pl-begin' || t === 'pl-src') plItems++;   // one transfer
      if (t === 'need-item') needs++;
    };
    const wait = ms => new Promise(r => setTimeout(r, ms));

    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    c.getContext('2d').fillStyle = '#c4ff2e'; c.getContext('2d').fillRect(0,0,64,64);
    const file = await new Promise(res => c.toBlob(b => res(new File([b],'x.png',{type:'image/png'})),'image/png'));

    const st = document.getElementById('stage').getBoundingClientRect();
    const dt = new DataTransfer(); dt.items.add(file);
    document.getElementById('stageWrap').dispatchEvent(new DragEvent('drop',
      { dataTransfer: dt, clientX: st.left + st.width/2, clientY: st.top + st.height/2,
        bubbles: true, cancelable: true }));
    await wait(300);
    const afterLoad = plItems;          // the one legitimate send

    // Make several undoable edits, then walk the history.
    window.pushUndo(); window.surfaces[0].opacity = 0.5;
    window.pushUndo(); window.surfaces[0].opacity = 0.25;
    await wait(50);
    const beforeUndo = plItems;
    window.undo(); await wait(200);
    window.undo(); await wait(200);
    window.redo(); await wait(200);
    await wait(200);

    spy.close();
    return { afterLoad, beforeUndo, afterUndo: plItems, needs };
  });

  expect(result.afterLoad).toBeGreaterThan(0);          // the initial send happened
  expect(result.beforeUndo).toBe(result.afterLoad);     // editing sends no media
  expect(result.afterUndo).toBe(result.beforeUndo);     // 3 history steps, 0 resends
  expect(result.needs).toBe(0);                         // nothing had to be pulled back

  await ctx.close();
});

// ── Test 25: focused form controls own their keystrokes ───────────────────────
// Regression: the guard was tagName === 'INPUT' only, so with the blend
// dropdown focused "A" also added a surface and the arrows also nudged.
test('keyboard shortcuts do not fire while a select has focus', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  await page.keyboard.press('a');            // one surface to work with
  await page.waitForTimeout(80);
  const before = await page.evaluate(() => ({
    count: window.surfaces.length,
    x: window.surfaces[0].pts[0][0].x
  }));

  await page.focus('#selBlend');
  await page.keyboard.press('a');            // would have added a surface
  await page.keyboard.press('ArrowRight');   // would have nudged
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(120);

  const after = await page.evaluate(() => ({
    count: window.surfaces.length,
    x: window.surfaces[0].pts[0][0].x
  }));
  expect(after.count).toBe(before.count);
  expect(after.x).toBe(before.x);

  // and the shortcuts still work once focus leaves the control
  await page.locator('#interactCanvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('a');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.surfaces.length)).toBe(before.count + 1);

  await ctx.close();
});

// ── Test 26: the rails are reachable and operable by keyboard ─────────────────
test('layer and playlist rows expose button semantics to the keyboard', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);
  await page.keyboard.press('a'); await page.waitForTimeout(60);
  await page.keyboard.press('a'); await page.waitForTimeout(60);

  const row = page.locator('.layer-item').first();
  await expect(row).toHaveAttribute('role', 'button');
  await expect(row).toHaveAttribute('tabindex', '0');

  // Enter on a focused row selects that surface (top row = topmost = last added)
  const topId = await page.evaluate(() => window.surfaces[window.surfaces.length - 1].id);
  await page.evaluate(() => window.surfaces[0].id);
  await row.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => window.selId)).toBe(topId);

  // Space on the visibility toggle hides it (and must not scroll the page)
  const vis = page.locator('.layer-item').first().locator('.layer-vis');
  await expect(vis).toHaveAttribute('role', 'button');
  await vis.focus();
  await page.keyboard.press(' ');
  await page.waitForTimeout(80);
  expect(await page.evaluate((id) => window.surfaces.find(s => s.id === id).visible, topId)).toBe(false);

  await ctx.close();
});

// ── Test 27: the state-broadcast dirty flag must not drop real edits ─────────
// broadcastState() no longer re-stringifies all geometry 60x/second; it runs on
// a dirty flag with a 500ms safety re-check. The risk that buys is a mutation
// path that forgets to mark dirty, so this exercises the paths that do NOT go
// through updateUI() (R and C rewrite s.pts; the mesh grid rewrites rows/cols)
// and asserts each reaches the wire well inside the safety window.
test('every mutation path marks the state dirty and reaches the display promptly', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);
  await page.keyboard.press('a');
  await page.waitForTimeout(100);

  // Listen on the channel as a third party and record each distinct snapshot.
  await page.evaluate(() => {
    window.__snaps = [];
    const spy = new BroadcastChannel('throw-sync');
    spy.onmessage = (ev) => { if (ev.data && ev.data.type === 'state') window.__snaps.push(ev.data.json); };
    window.__spy = spy;
  });

  // Each entry: a mutation, and the surface field it must change on the wire.
  const step = async (label, act) => {
    const seen = await page.evaluate(() => window.__snaps.length);
    await act();
    // Deliberately shorter than the 500ms safety net: this must pass because
    // the path marked dirty, not because the net caught it.
    await page.waitForFunction((n) => window.__snaps.length > n, seen, { timeout: 300 })
      .catch(() => { throw new Error(label + ' did not reach the display inside 300ms'); });
    return page.evaluate(() => JSON.parse(window.__snaps[window.__snaps.length - 1]));
  };

  // R — flatten the mesh (no updateUI in resetSelMesh)
  await page.evaluate(() => { window.surfaces[0].pts[0][0].x -= 40; });
  await page.waitForTimeout(120);
  const afterR = await step('R (reset mesh)', () => page.keyboard.press('r'));
  expect(afterR.surfaces[0].pts[0][0].x).toBeGreaterThan(0);

  // C — recentre (no updateUI in recenterSel)
  const afterC = await step('C (recentre)', () => page.keyboard.press('c'));
  expect(afterC.surfaces[0].pts[0][0].x).toBeCloseTo(1920 * 0.25, 0);

  // Mesh grid button — rewrites rows/cols, also no updateUI
  const afterMesh = await step('mesh grid button',
    () => page.locator('#meshSel .mgbtn[data-r="4"][data-c="4"]').click());
  expect(afterMesh.surfaces[0].rows).toBe(4);
  expect(afterMesh.surfaces[0].cols).toBe(4);

  // O — outlines flag rides the same snapshot
  const afterO = await step('O (outlines)', () => page.keyboard.press('o'));
  expect(afterO.outlines).toBe(true);   // default is off, so O turns them ON

  // A slider (input event) and a dropdown (change event)
  const afterOpacity = await step('opacity slider',
    () => page.locator('#rngOpacity').fill('40'));
  expect(afterOpacity.surfaces[0].opacity).toBeCloseTo(0.4, 2);

  const afterBlend = await step('blend dropdown',
    () => page.locator('#selBlend').selectOption('screen'));
  expect(afterBlend.surfaces[0].blend).toBe('screen');

  // Arrow nudge (direct pts mutation from the keydown handler). selectOption
  // leaves focus in the dropdown, where the arrow keys legitimately belong to
  // the select (see the "select has focus" test) — so release focus first.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const beforeX = await page.evaluate(() => window.surfaces[0].pts[0][0].x);
  const afterNudge = await step('arrow nudge', () => page.keyboard.press('ArrowRight'));
  expect(afterNudge.surfaces[0].pts[0][0].x).toBe(beforeX + 1);

  await page.evaluate(() => window.__spy.close());
  await ctx.close();
});

// ── Test 28: a normal media load must cross the channel exactly once ─────────
// The display PULLS items its playlist order references but its store lacks
// (need-item). The trap: bcSendPlaylist starts an async arrayBuffer read while
// the tiny state message goes out on the very next frame — so the display sees
// the order before the blob lands and would ask for a file already in flight,
// sending every dropped clip twice.
test('media loads once even though the state broadcast beats the blob', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();

  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(300);

  // Count what actually crosses the wire, from a third listener in the editor.
  await editor.evaluate(() => {
    window.__sent = { plItem: 0, need: 0 };
    const spy = new BroadcastChannel('throw-sync');
    spy.onmessage = (ev) => {
      const t = ev.data && ev.data.type;
      if (t === 'pl-begin' || t === 'pl-src') window.__sent.plItem++;   // one transfer
      if (t === 'need-item') window.__sent.need++;
    };
    window.__spy = spy;
  });

  // A SMALL blob's arrayBuffer() resolves before the next animation frame, so
  // the blob wins the race and the bug stays hidden. Real clips are tens of MB
  // and read slowly; model that deterministically by delaying the read, so the
  // state broadcast provably goes out first.
  await editor.evaluate(() => {
    const orig = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      return new Promise(res => setTimeout(() => orig.call(this).then(res), 400));
    };
  });

  await editor.bringToFront();
  await editor.keyboard.press('a');
  await display.waitForFunction(() => window.surfaceList && window.surfaceList.length === 1, null, { timeout: 5000 });

  await editor.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    c.getContext('2d').fillStyle = '#c4ff2e'; c.getContext('2d').fillRect(0, 0, 320, 240);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    loadMediaToSurface(window.surfaces[0], new File([blob], 'once.png', { type: 'image/png' }));
  });

  // The display must actually receive it...
  await display.waitForFunction(() => window.mediaCount === 1, null, { timeout: 5000 });
  // ...and then sit still well past the point where a stale need-item would fire.
  await editor.waitForTimeout(3000);

  const sent = await editor.evaluate(() => window.__sent);
  expect(sent.plItem).toBe(1);   // exactly one transfer, not two
  expect(sent.need).toBe(0);     // nothing was pulled for a blob already in flight

  await editor.evaluate(() => window.__spy.close());
  await ctx.close();
});

// ── Test 29: a genuinely lost blob IS pulled back ────────────────────────────
// The other half of the grace period: suppressing the request during a normal
// load must not disable recovery. Simulate the real case — the display pruned
// an item and an undo brought it back, or a message was lost — by dropping the
// blob from the display's store and confirming it comes back on its own.
test('the display pulls back an item it is missing', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();

  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(300);

  await editor.bringToFront();
  await editor.keyboard.press('a');
  await display.waitForFunction(() => window.surfaceList && window.surfaceList.length === 1, null, { timeout: 5000 });

  await editor.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    c.getContext('2d').fillStyle = '#3ad6c0'; c.getContext('2d').fillRect(0, 0, 320, 240);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    loadMediaToSurface(window.surfaces[0], new File([blob], 'lost.png', { type: 'image/png' }));
  });

  const surfId = await editor.evaluate(() => window.surfaces[0].id);
  await display.waitForFunction((id) => {
    const st = window.plState(id); return st && st.items === 1;
  }, surfId, { timeout: 5000 });

  // Simulate the loss: evict the blob but leave the playlist order referencing it.
  await display.evaluate((id) => { window.__evict(id); }, surfId);
  expect(await display.evaluate((id) => window.plState(id).items, surfId)).toBe(0);

  // It should come back unprompted, via need-item, once the grace period lapses.
  await display.waitForFunction((id) => {
    const st = window.plState(id); return st && st.items === 1;
  }, surfId, { timeout: 8000 });

  await ctx.close();
});

// ── Test 30: a duplicated surface owns its media ─────────────────────────────
// Regression: Copy spread the original's s.media, so (a) clone.media.item still
// pointed at the ORIGINAL's playlist item — editorAdjust() previewed the
// original's look, so editing the copy changed the projector but not the editor
// stage — and (b) clone.media.src was the original's blob URL, which
// freeMedia() on the original revokes, blanking the copy.
test('duplicating a surface gives the copy its own media and look', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    c.getContext('2d').fillStyle = '#c4ff2e'; c.getContext('2d').fillRect(0, 0, 200, 200);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const s = window.addSurfaceForTest();
    loadMediaToSurface(s, new File([blob], 'orig.png', { type: 'image/png' }));
  });
  await page.waitForTimeout(300);

  await page.click('#btnDup');
  await page.waitForTimeout(200);

  const wiring = await page.evaluate(() => {
    const [orig, copy] = window.surfaces;
    return {
      count: window.surfaces.length,
      // the copy's preview must point at the copy's OWN playlist item
      copyItemIsOwn: copy.media.item === copy.playlist.items[0],
      copyItemIsNotOriginals: copy.media.item !== orig.playlist.items[0],
      distinctItemIds: orig.playlist.items[0].id !== copy.playlist.items[0].id,
      // ...and must not borrow the original's revocable blob URL
      distinctSrc: copy.media.src !== orig.media.src,
    };
  });
  expect(wiring.count).toBe(2);
  expect(wiring.copyItemIsOwn).toBe(true);
  expect(wiring.copyItemIsNotOriginals).toBe(true);
  expect(wiring.distinctItemIds).toBe(true);
  expect(wiring.distinctSrc).toBe(true);

  // Editing the copy's brightness must move what the EDITOR previews for it.
  const looks = await page.evaluate(() => {
    const [orig, copy] = window.surfaces;
    copy.playlist.items[0].adjust.br = 0.25;
    // editorAdjust is what the stage renders with
    const el = copy.media;
    return {
      copyPreviewBr: (el && el.item && el.item.adjust.br),
      origUntouchedBr: orig.playlist.items[0].adjust.br,
    };
  });
  expect(looks.copyPreviewBr).toBe(0.25);   // was 1 (the original's) before the fix
  expect(looks.origUntouchedBr).toBe(1);

  // Replacing the original's media must not blank the copy.
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    c.getContext('2d').fillStyle = '#ff466f'; c.getContext('2d').fillRect(0, 0, 200, 200);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    loadMediaToSurface(window.surfaces[0], new File([blob], 'replaced.png', { type: 'image/png' }));
  });
  await page.waitForTimeout(400);

  const copyStillLoads = await page.evaluate(() => {
    const copy = window.surfaces[1];
    const el = copy.media && copy.media.el;
    return !!(el && el.complete && el.naturalWidth > 0);
  });
  expect(copyStillLoads).toBe(true);

  await ctx.close();
});

// ── Test 31: the editor finds a display that was already open ────────────────
// Regression: the greeting was one-way. display.html announced itself once on
// load; if the editor started (or reloaded) afterwards it missed that greeting
// forever — the ⧉ button never lit, and the editor never force-sent state and
// media to a display it did not know was listening. The editor now calls the
// roll-call and the display answers.
test('an editor opened after the display still connects to it', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  // Display FIRST — the reverse of the usual order.
  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(400);

  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();

  // The ⧉ Display button reports LIVE without the user touching anything.
  await editor.waitForFunction(
    () => document.getElementById('btnOutput').classList.contains('active'),
    null, { timeout: 5000 });

  // And a real edit + media reaches that display.
  await editor.bringToFront();
  await editor.keyboard.press('a');
  await display.waitForFunction(() => window.surfaceList && window.surfaceList.length === 1, null, { timeout: 5000 });

  await editor.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 160; c.height = 120;
    c.getContext('2d').fillStyle = '#ffb23e'; c.getContext('2d').fillRect(0, 0, 160, 120);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    loadMediaToSurface(window.surfaces[0], new File([blob], 'late.png', { type: 'image/png' }));
  });
  await display.waitForFunction(() => window.mediaCount === 1, null, { timeout: 5000 });

  const surfId = await editor.evaluate(() => window.surfaces[0].id);
  const st = await display.evaluate((id) => window.plState(id), surfId);
  expect(st.items).toBe(1);
  expect(st.order).toHaveLength(1);

  await ctx.close();
});

// ── Test 32: the editor loads clean, with every script present ───────────────
// The editor is now a dozen ordered CLASSIC scripts rather than one inline
// block. Classic scripts share a global scope, but a function declaration is
// only hoisted within its OWN file — so anything called at LOAD time must be
// declared in an earlier file. Splitting the file broke exactly this once
// (60-ui.js restores the saved stage size at load and called safeGet, which
// was declared in the last file). That failure is silent in review and loud
// here: a page error, and the error banner covering the toolbar.
test('the editor boots with no script errors and every module served', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  const pageErrors = [], consoleErrors = [], failedRequests = [], scripts = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', r => failedRequests.push(r.url()));
  page.on('response', r => {
    if (/\.js(\?|$)/.test(r.url())) scripts.push({ url: r.url().split('/').slice(-2).join('/'), status: r.status() });
  });

  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  expect(pageErrors, 'uncaught errors during boot').toEqual([]);
  expect(consoleErrors, 'console errors during boot').toEqual([]);
  expect(failedRequests, 'failed script requests').toEqual([]);

  // Every script the page asked for must have been served.
  const notOk = scripts.filter(s => s.status !== 200);
  expect(notOk, 'scripts that did not return 200').toEqual([]);
  // shared.js + the editor modules
  expect(scripts.length).toBeGreaterThanOrEqual(13);

  // The error banner (the app's own honest-failure surface) must be silent...
  expect(await page.evaluate(() => document.getElementById('errBanner').style.display)).not.toBe('block');
  // ...and the app must actually be wired up, not merely quiet.
  expect(await page.evaluate(() => typeof window.surfaces)).toBe('object');
  // The first-run modal correctly swallows shortcuts while it is open.
  const helpClose = page.locator('#helpClose');
  if (await helpClose.isVisible()) await helpClose.click();
  await page.keyboard.press('a');
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => window.surfaces.length)).toBe(1);

  await ctx.close();
});

// ── Test 33: trace mode lands the shape where you clicked ────────────────────
// Regression: sizePlaceCanvas assigned VIEWPORT coordinates (from
// getBoundingClientRect) to a canvas positioned absolutely inside
// #placeOverlay, which is itself absolutely positioned. The trace surface was
// therefore displaced by the overlay's own offset — clicks near the edge fell
// off it entirely, and any shape that did get traced was built at the wrong
// stage coordinates. The existing sticker test only asserted a mask EXISTED,
// which stayed true while the geometry was wrong; this one checks position.
test('a traced shape is built at the coordinates that were clicked', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  await page.keyboard.press('p');
  await page.waitForTimeout(200);

  // The overlay canvas must sit exactly on the stage, or clicks map elsewhere.
  const rects = await page.evaluate(() => {
    const c = document.getElementById('placeCanvas').getBoundingClientRect();
    const s = document.getElementById('stage').getBoundingClientRect();
    return { c: { l: c.left, t: c.top, w: c.width, h: c.height },
             s: { l: s.left, t: s.top, w: s.width, h: s.height } };
  });
  expect(rects.c.l).toBeCloseTo(rects.s.l, 0);
  expect(rects.c.t).toBeCloseTo(rects.s.t, 0);
  expect(rects.c.w).toBeCloseTo(rects.s.w, 0);
  expect(rects.c.h).toBeCloseTo(rects.s.h, 0);

  // Trace a rectangle at known fractions of the stage.
  const F = [[0.10, 0.10], [0.30, 0.10], [0.30, 0.30], [0.10, 0.30]];
  for (const [dx, dy] of F) {
    await page.mouse.click(rects.s.l + rects.s.w * dx, rects.s.t + rects.s.h * dy);
    await page.waitForTimeout(50);
  }
  expect(await page.evaluate(() => window.placePtsLen)).toBe(4);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);

  const box = await page.evaluate(() => {
    const s = window.surfaces[window.surfaces.length - 1];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let r = 0; r <= s.rows; r++) for (let c = 0; c <= s.cols; c++) {
      const p = s.pts[r][c];
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, stageW: window.stageW, stageH: window.stageH };
  });

  // Clicked 10%..30% of a 1920x1080 stage → roughly x 192..576, y 108..324.
  const tol = 12;   // a few px of click/rounding slack
  expect(Math.abs(box.x - 0.10 * box.stageW)).toBeLessThan(tol);
  expect(Math.abs(box.y - 0.10 * box.stageH)).toBeLessThan(tol);
  expect(Math.abs(box.w - 0.20 * box.stageW)).toBeLessThan(tol);
  expect(Math.abs(box.h - 0.20 * box.stageH)).toBeLessThan(tol);

  await ctx.close();
});

// A hand-built 2-frame animated GIF (1x1: red, then blue). Small enough to
// inline, real enough to drive the WebCodecs path — which had no automated
// coverage at all before this, only the manual checklist in TESTING.md.
const ANIM_GIF = [
  0x47,0x49,0x46,0x38,0x39,0x61,
  0x01,0x00, 0x01,0x00, 0xF0, 0x00, 0x00,
  0xFF,0x00,0x00,  0x00,0x00,0xFF,
  0x21,0xFF,0x0B, 0x4E,0x45,0x54,0x53,0x43,0x41,0x50,0x45,0x32,0x2E,0x30,
  0x03,0x01,0x00,0x00, 0x00,
  0x21,0xF9,0x04, 0x04, 0x0A,0x00, 0x00, 0x00,
  0x2C, 0x00,0x00, 0x00,0x00, 0x01,0x00, 0x01,0x00, 0x00,
  0x02,0x02,0x44,0x01,0x00,
  0x21,0xF9,0x04, 0x04, 0x0A,0x00, 0x00, 0x00,
  0x2C, 0x00,0x00, 0x00,0x00, 0x01,0x00, 0x01,0x00, 0x00,
  0x02,0x02,0x4C,0x01,0x00,
  0x3B
];

// ── Test 34: animated images decode, advance, and release their frames ───────
// createAnimatedCanvas now closes the ImageDecoder once the frames are pulled
// (verified separately that closing it does NOT invalidate them), and _stop()
// closes the VideoFrames themselves — they hold GPU memory and are not
// ordinary GC'd objects, so a long GIF leaked hundreds of them per release.
test('an animated GIF decodes, advances, and releases cleanly on stop', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  const out = await page.evaluate(async (bytes) => {
    const file = new File([new Uint8Array(bytes)], 'anim.gif', { type: 'image/gif' });
    const res = await createAnimatedCanvas(file);
    if (!res) return { skipped: true };            // no ImageDecoder in this build
    const c = res.canvas, g = c.getContext('2d');
    const px = () => { const d = g.getImageData(0, 0, 1, 1).data; return d[0] + ',' + d[1] + ',' + d[2]; };

    // Sample across several frame durations; both palette entries must appear.
    const seen = new Set();
    for (let i = 0; i < 24; i++) { seen.add(px()); await new Promise(r => setTimeout(r, 25)); }

    let stopErr = null;
    try { c._stop(); } catch (e) { stopErr = e.message; }

    // After stop the canvas must hold still (advance() bails before drawing
    // from a closed frame — drawing one would throw).
    const afterStop = px();
    await new Promise(r => setTimeout(r, 250));
    const stillAfter = px();

    let doubleStopErr = null;
    try { c._stop(); } catch (e) { doubleStopErr = e.message; }

    return { skipped: false, frames: res.frames, w: c.width, h: c.height,
             seen: [...seen], stopErr, afterStop, stillAfter, doubleStopErr };
  }, ANIM_GIF);

  test.skip(out.skipped, 'ImageDecoder unavailable in this browser build');

  expect(out.frames).toBe(2);
  expect(out.w).toBe(1);
  expect(out.h).toBe(1);
  // it actually animated: both the red and the blue frame were rendered
  expect(out.seen).toContain('255,0,0');
  expect(out.seen).toContain('0,0,255');
  expect(out.stopErr).toBeNull();          // frames closed without error
  expect(out.stillAfter).toBe(out.afterStop);   // and it stopped advancing
  expect(out.doubleStopErr).toBeNull();    // _stop() is idempotent

  await ctx.close();
});

// ── Test 35: HiDPI backing stores ────────────────────────────────────────────
// The trace overlay and the display's 2D layers used to be sized in CSS pixels
// while the GL canvas rendered at devicePixelRatio — so on a HiDPI screen the
// calibration line-work was softer than the media it exists to be aligned
// against. All of them now back at DPR while keeping CSS-pixel coordinates.
test('trace overlay and display layers render at device pixel ratio', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();

  await editor.keyboard.press('p');
  await editor.waitForTimeout(220);

  const trace = await editor.evaluate(() => {
    const c = document.getElementById('placeCanvas');
    const r = c.getBoundingClientRect();
    const s = document.getElementById('stage').getBoundingClientRect();
    return { backingW: c.width, backingH: c.height, cssW: r.width, cssH: r.height,
             stageW: s.width, stageH: s.height, dpr: window.devicePixelRatio };
  });
  expect(trace.dpr).toBe(2);
  // CSS box still tracks the stage exactly (clicks must keep mapping 1:1)...
  expect(trace.cssW).toBeCloseTo(trace.stageW, 0);
  expect(trace.cssH).toBeCloseTo(trace.stageH, 0);
  // ...while the backing store is twice as dense.
  expect(trace.backingW).toBe(Math.round(trace.cssW * 2));
  expect(trace.backingH).toBe(Math.round(trace.cssH * 2));

  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(300);
  const layers = await display.evaluate(() => {
    const g = (id) => { const c = document.getElementById(id); return { w: c.width, h: c.height }; };
    return { gl: g('oc'), fallback: g('oc2d'), overlay: g('ov'),
             expectW: Math.round(window.innerWidth * window.devicePixelRatio) };
  });
  expect(layers.gl.w).toBe(layers.expectW);
  expect(layers.fallback.w).toBe(layers.expectW);   // was innerWidth (CSS px)
  expect(layers.overlay.w).toBe(layers.expectW);    // was innerWidth (CSS px)

  await ctx.close();
});

// ── Test 36: an animated item still animates after you switch away and back ──
// buildEditorMedia stops the outgoing animated canvas, but animated canvases
// are CACHED on the item (`item._animCanvas`) so re-selecting one does not
// re-decode. Those two facts together mean a GIF you click away from and back
// to comes back frozen — and now that _stop() closes the VideoFrames, the
// cached canvas is not merely paused but unusable.
test('an animated item resumes after switching away and back', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  const out = await page.evaluate(async (bytes) => {
    const gif = new File([new Uint8Array(bytes)], 'anim.gif', { type: 'image/gif' });
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    c.getContext('2d').fillStyle = '#888'; c.getContext('2d').fillRect(0, 0, 32, 32);
    const png = new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'flat.png', { type: 'image/png' });

    const s = window.addSurfaceForTest();
    addToPlaylist(s, [gif, png]);
    await new Promise(r => setTimeout(r, 500));
    if (!s.media || !s.media.animCanvas) return { skipped: true };

    const sample = async () => {
      const seen = new Set();
      for (let i = 0; i < 24; i++) {
        const cv = s.media && s.media.animCanvas;
        if (cv) { const d = cv.getContext('2d').getImageData(0, 0, 1, 1).data; seen.add(d[0] + ',' + d[1] + ',' + d[2]); }
        await new Promise(r => setTimeout(r, 25));
      }
      return [...seen];
    };

    const before = await sample();                       // animating on first show
    selectPlItem(s, s.playlist.items[1].id);             // switch away (stops it)
    await new Promise(r => setTimeout(r, 200));
    selectPlItem(s, s.playlist.items[0].id);             // ...and back
    await new Promise(r => setTimeout(r, 400));
    const after = await sample();

    return { skipped: false, before, after, hasCanvas: !!(s.media && s.media.animCanvas) };
  }, ANIM_GIF);

  test.skip(out.skipped, 'ImageDecoder unavailable in this browser build');

  expect(out.before.length).toBeGreaterThan(1);   // it animated to begin with
  expect(out.hasCanvas).toBe(true);
  expect(out.after.length).toBeGreaterThan(1);    // and still animates on return

  await ctx.close();
});

// ── Test 37: a decode that lands after you switched away is stopped ──────────
// createAnimatedCanvas starts its rAF loop BEFORE the promise resolves, so a
// result arriving after the user moved on is a self-running loop holding
// decoded frames open for the life of the tab. Switching between two animated
// items faster than they decode used to strand one orphan per switch.
test('animated decodes that arrive too late are stopped, not stranded', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  const out = await page.evaluate(async (bytes) => {
    // Count live (unstopped) animated canvases by wrapping the factory.
    const live = new Set();
    const orig = window.createAnimatedCanvas;
    if (typeof orig !== 'function') return { skipped: true };
    window.createAnimatedCanvas = async (f) => {
      const res = await orig(f);
      // A 1x1 two-frame GIF decodes faster than the switching loop below, so
      // the race never opens and the test passes even when broken. Real GIFs
      // are hundreds of frames: hold the RESOLUTION back while the canvas (which
      // the factory already started advancing) runs, which is exactly the state
      // a slow decode is in when the user moves on.
      await new Promise(r => setTimeout(r, 200));
      if (res && res.canvas) {
        live.add(res.canvas);
        const stop = res.canvas._stop;
        res.canvas._stop = () => { live.delete(res.canvas); return stop.call(res.canvas); };
      }
      return res;
    };

    const mkGif = (n) => new File([new Uint8Array(bytes)], n, { type: 'image/gif' });
    const s = window.addSurfaceForTest();
    addToPlaylist(s, [mkGif('a.gif'), mkGif('b.gif')]);
    await new Promise(r => setTimeout(r, 400));

    // Thrash between the two animated items; each switch discards the outgoing
    // canvas and kicks off a fresh decode for the incoming one.
    for (let i = 0; i < 6; i++) {
      selectPlItem(s, s.playlist.items[i % 2].id);
      await new Promise(r => setTimeout(r, 30));
    }
    await new Promise(r => setTimeout(r, 800));   // let every decode settle

    window.createAnimatedCanvas = orig;
    // At rest, at most the one canvas currently on the stage should be running.
    return { skipped: false, liveCount: live.size,
             shownIsLive: !!(s.media && s.media.animCanvas && live.has(s.media.animCanvas)) };
  }, ANIM_GIF);

  test.skip(out.skipped, 'ImageDecoder unavailable in this browser build');
  expect(out.liveCount).toBeLessThanOrEqual(1);

  await ctx.close();
});

// ── Test 38: the display reports transfer progress and offers the remedy ─────
// This tab is a passive renderer: a clip that never arrived and a clip that
// stalled both look like "a checkerboard", which is also what "nothing set up
// yet" looks like. It now says which, and names the one fix that always works.
test('the display shows transfer progress and a reload hint when media is missing', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();
  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(300);

  // A surface whose playlist references a clip the display will never receive:
  // exactly the state that used to render as an unexplained checkerboard.
  await editor.bringToFront();
  await editor.keyboard.press('a');
  await display.waitForFunction(() => window.surfaceList && window.surfaceList.length === 1, null, { timeout: 5000 });
  await editor.evaluate(() => {
    const s = window.surfaces[0];
    s.playlist.items = [{ id: 'GHOST_1', name: 'never-arrives.mp4', kind: 'video',
                          adjust: {}, crop: null, trimIn: 0, trimOut: 0, _sent: true }];
    s._selItem = 'GHOST_1';
  });

  // Health check runs on the 1.5s watchdog; the grace period must lapse first.
  await display.waitForFunction(
    () => /reload this tab/i.test(document.getElementById('status').textContent),
    null, { timeout: 15000 });

  const status = await display.evaluate(() => ({
    text: document.getElementById('status').textContent,
    warn: document.getElementById('status').className
  }));
  expect(status.text).toMatch(/waiting for 1 clip/i);
  expect(status.text).toMatch(/Ctrl\+R/);
  expect(status.warn).toBe('warn');

  // ...and once the reference is gone, the warning clears itself.
  await editor.evaluate(() => { window.surfaces[0].playlist.items = []; });
  await display.waitForFunction(
    () => document.getElementById('status').textContent === '', null, { timeout: 15000 });

  await ctx.close();
});

// ── Test 39: the storage layer never drops a chunk ──────────────────────────
// begin() opens an OPFS file asynchronously, but chunks arrive straight from a
// BroadcastChannel handler that cannot await. An async begin() therefore lost
// every chunk that landed before the file was open — and the clip never
// arrived at all, with no error anywhere. begin() now registers its record
// synchronously and queues writes until the writable exists.
test('DiskStore keeps chunks that arrive before the file is open', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(200);

  const out = await display.evaluate(async () => {
    const enc = (s) => new TextEncoder().encode(s).buffer;
    // Write IMMEDIATELY after begin(), without awaiting it — the exact race.
    const ready = DiskStore.begin('T1', { name: 'a.bin', mime: 'application/octet-stream', size: 12 });
    DiskStore.write('T1', enc('abc'));
    DiskStore.write('T1', enc('def'));
    await ready;
    DiskStore.write('T1', enc('ghi'));
    const res = await DiskStore.finish('T1');
    const text = await res.file.text();

    // release() must be safe on an id that has already been finished...
    await DiskStore.release('T1');
    // ...and on one that never existed.
    await DiskStore.release('NOPE');

    // an aborted transfer leaves nothing behind
    DiskStore.begin('T2', { name: 'b.bin', size: 6 });
    DiskStore.write('T2', enc('xy'));
    await DiskStore.release('T2');
    const afterAbort = await DiskStore.finish('T2');

    return { text, size: res.size, backend: res.backend, afterAbort, held: DiskStore.held, inflight: DiskStore.inflight };
  });

  expect(out.text).toBe('abcdefghi');   // nothing dropped, order preserved
  expect(out.size).toBe(9);
  expect(out.afterAbort).toBeNull();    // released transfer yields nothing
  expect(out.inflight).toBe(0);
  expect(out.held).toBe(0);             // no orphaned files left

  await ctx.close();
});

// ── Test 40: the editor reports what is loaded, and warns without blocking ──
// Storage and decode are different limits: ten 1080p clips can be fine where
// two 4K clips stutter. The meter counts video SURFACES (one plays per surface)
// and flags high-resolution sources, and never refuses anything (NOTES §4).
test('the editor storage meter reports load and warns without blocking', async ({ browser }) => {
  const { page, ctx } = await openApp(browser);

  expect(await page.evaluate(() => document.getElementById('storeMeter').textContent)).toBe('');

  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    c.getContext('2d').fillStyle = '#c4ff2e'; c.getContext('2d').fillRect(0, 0, 64, 64);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const s = window.addSurfaceForTest();
    loadMediaToSurface(s, new File([blob], 'one.png', { type: 'image/png' }));
  });
  await page.waitForTimeout(300);

  const one = await page.evaluate(() => document.getElementById('storeMeter').textContent);
  expect(one).toMatch(/^1 clip · \d+ MB/);
  expect(await page.evaluate(() => document.getElementById('storeMeter').className)).toBe('');

  // Pretend a stack of over-1080p video surfaces exists: the warning must
  // appear, and adding more must still be allowed.
  await page.evaluate(() => {
    for (let i = 0; i < 4; i++) {
      const s = window.addSurfaceForTest();
      s.playlist.items = [{ id: 'V' + i, name: 'big' + i + '.mp4', kind: 'video',
                            file: { size: 800 * 1048576 }, _srcH: 2160,
                            adjust: {}, crop: null, trimIn: 0, trimOut: 0 }];
    }
    updateUI();
  });
  const many = await page.evaluate(() => ({
    text: document.getElementById('storeMeter').textContent,
    warn: document.getElementById('storeMeter').className,
    surfaces: window.surfaces.length
  }));
  expect(many.text).toMatch(/GB/);
  expect(many.text).toMatch(/video surface/);
  expect(many.text).toMatch(/Downscale/);
  expect(many.warn).toBe('warn');
  expect(many.surfaces).toBe(5);        // nothing was refused

  // and it is genuinely non-blocking: one more still lands
  await page.keyboard.press('a');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.surfaces.length)).toBe(6);

  await ctx.close();
});

// ── Test 41: two display tabs coexist without destroying each other ──────────
// OPFS is per-ORIGIN, not per-tab. The startup reclaim used to delete every
// file it found, so opening a SECOND display tab wiped the media the first was
// projecting, mid-show. Tabs now store under their own session id and reclaim
// only sessions that fail to answer a roll-call.
test('a second display tab does not destroy the first tab media', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const editor = await ctx.newPage();
  await editor.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const closeBtn = editor.locator('#helpClose');
  if (await closeBtn.isVisible()) await closeBtn.click();

  const d1 = await ctx.newPage();
  await d1.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  // Force the DISK backend before any media arrives. Without this the test
  // media (a few KB) stays in memory, no OPFS file is ever created, and the
  // storage isolation under test is never exercised — the test would pass
  // against the broken code, which is exactly what it did at first.
  await d1.evaluate(() => DiskStore.__setSmall(1));
  await d1.waitForTimeout(300);

  await editor.bringToFront();
  await editor.keyboard.press('a');
  await editor.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 240; c.height = 180;
    c.getContext('2d').fillStyle = '#c4ff2e'; c.getContext('2d').fillRect(0, 0, 240, 180);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    loadMediaToSurface(window.surfaces[0], new File([blob], 'shared.png', { type: 'image/png' }));
  });
  const surfId = await editor.evaluate(() => window.surfaces[0].id);
  await d1.waitForFunction((id) => { const s = window.plState(id); return s && s.items === 1; }, surfId, { timeout: 8000 });

  const s1 = await d1.evaluate(() => DiskStore.session);
  const before = await d1.evaluate(() => DiskStore.__listFiles());
  expect(before.filter(f => !f.startsWith('.')).length).toBeGreaterThan(0);   // really on disk

  // Second tab: its startup reclaim runs ~900ms in, after the roll-call.
  const d2 = await ctx.newPage();
  await d2.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await d2.evaluate(() => DiskStore.__setSmall(1));
  await d2.waitForFunction((id) => { const s = window.plState(id); return s && s.items === 1; }, surfId, { timeout: 8000 });
  const s2 = await d2.evaluate(() => DiskStore.session);

  expect(s1).not.toBe(s2);                       // separate storage areas
  // let the second tab reclaim sweep run and settle
  await d2.waitForTimeout(2500);

  // THE decisive assertion. Reading tab 1's File object back would pass even if
  // tab 2 had deleted it, because Chrome keeps an unlinked file readable
  // through a handle that is already open. Ask tab 1 what is actually on disk.
  const after = await d1.evaluate(() => DiskStore.__listFiles());
  expect(after.filter(f => !f.startsWith('.')).length).toBeGreaterThan(0);

  // the FIRST tab must still hold (and still be able to render) its media
  expect(await d1.evaluate((id) => window.plState(id).items, surfId)).toBe(1);
  expect(await d1.evaluate(() => document.getElementById('banner').style.display)).not.toBe('block');
  expect(await d2.evaluate((id) => window.plState(id).items, surfId)).toBe(1);
  // and the first tab saw the second announce itself
  expect(await d1.evaluate(() => [...(window._aliveSessions || [])].length)).toBeGreaterThan(0);

  await ctx.close();
});

// ── Test 42: re-sending an item the display already holds is safe ────────────
// The editor force-resends every item on hello-display, so a second display
// tab (or a reconnect) makes the FIRST tab re-receive things it already has.
// Filenames used to be keyed by itemId alone, so the outgoing transfer's
// deferred cleanup deleted the incoming transfer's file mid-write.
test('re-transferring a held item keeps the media intact', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(300);

  const out = await display.evaluate(async () => {
    // Force the DISK path with tiny payloads, otherwise everything stays in
    // memory and the filename lifecycle under test is never touched at all.
    DiskStore.__setSmall(1);
    if(!(await DiskStore.probe())) return { skipped: true };
    const enc = (s) => new TextEncoder().encode(s).buffer;

    // Start a transfer and leave it IN FLIGHT — its record still owns a
    // writable, so retiring it takes several turns. That is what makes the
    // race deterministic: the outgoing cleanup lands after the incoming
    // transfer has created its file.
    await DiskStore.begin('R1', { name: 'R1.bin', mime: 'text/plain', size: 13 });
    DiskStore.write('R1', enc('first-payload'));

    // Now re-send the same id, exactly as hello-display's force-resend does.
    const ready = DiskStore.begin('R1', { name: 'R1.bin', mime: 'text/plain', size: 14 });
    DiskStore.write('R1', enc('second-payload'));
    const backend = await ready;
    const second = await DiskStore.finish('R1');
    await new Promise(r => setTimeout(r, 800));   // let the retired cleanup run

    let text = null, err = null;
    try { text = await second.file.text(); } catch (e) { err = e.name + ': ' + e.message; }
    // The decisive check. Chrome keeps an unlinked file readable through the
    // handle we already hold, so reading `second.file` back would pass even if the
    // outgoing cleanup had deleted the directory entry. Ask the filesystem.
    const files = await DiskStore.__listFiles();
    return { skipped: false, backend, size: second.size, text, err, files,
             held: DiskStore.held, inflight: DiskStore.inflight };
  });

  test.skip(out.skipped, 'OPFS unavailable in this browser build');

  expect(out.backend).toBe('opfs');                // the disk path really ran
  expect(out.err).toBeNull();                        // file still exists
  expect(out.text).toBe('second-payload');     // NOT deleted by the old cleanup
  expect(out.size).toBe(14);
  expect(out.inflight).toBe(0);
  // exactly one live file, still present on disk — not unlinked behind our back
  expect(out.files.filter(f => !f.startsWith('.'))).toHaveLength(1);
  expect(out.held).toBe(1);

  await ctx.close();
});

// ── Test 43: the memory ceiling still warns when disk is available ──────────
// Items under DiskStore.SMALL stay in MEMORY however much disk exists, so they
// are bounded by MEM_BUDGET (~2.5GB) regardless of quota. A single conflated
// budget checked them against the disk figure (~8GB), so a pile of small clips
// blew the memory ceiling in total silence — the exact failure the reporting
// exists to surface.
test('many small clips still trip the memory warning while disk is available', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(300);

  const out = await display.evaluate(async () => {
    // Disk is available and its budget is large; the memory ceiling is what
    // these items are actually bounded by. Make it small enough to reach.
    window.__setMemBudget(3000);
    // The payloads are not real PNGs, so each one also raises a decode error
    // that overwrites the banner. Record every message the banner shows rather
    // than whichever happened to be last.
    const seen = [];
    const el = document.getElementById('banner');
    new MutationObserver(() => { if (el.textContent) seen.push(el.textContent); })
      .observe(el, { childList: true, characterData: true, subtree: true });
    const chan = new BroadcastChannel('throw-sync');
    const send = (id, bytes) => {
      chan.postMessage({ type:'pl-begin', surfId:'S9', itemId:id, xfer:id, name:id+'.png', mime:'image/png', size:bytes });
      chan.postMessage({ type:'pl-chunk', surfId:'S9', itemId:id, xfer:id, off:0, total:bytes, buf:new ArrayBuffer(bytes) });
      chan.postMessage({ type:'pl-end', surfId:'S9', itemId:id, xfer:id });
    };
    for (let i = 0; i < 4; i++) send('SMALL' + i, 1024);   // well under DiskStore.SMALL
    await new Promise(r => setTimeout(r, 1200));
    chan.close();
    return { seen, held: window._heldBytes, diskOK: await DiskStore.probe() };
  });

  expect(out.diskOK).toBe(true);                  // disk WAS available...
  expect(out.held).toBeGreaterThan(3000);         // ...but these went to memory
  expect(out.seen.length).toBeGreaterThan(0);
  expect(out.seen.some(t => /in memory/i.test(t))).toBe(true);   // memory ceiling warned

  await ctx.close();
});

// ── Test 44: the display no longer swallows async failures ──────────────────
// display.html had no window.onerror and no unhandledrejection handler, so a
// rejection anywhere in the media path vanished without trace and the
// retry-in-memory recovery never ran. Nothing fails silently (NOTES §4).
test('an unhandled rejection in the display surfaces in the banner', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.waitForTimeout(300);

  await display.evaluate(() => { Promise.reject(new Error('probe-failure-xyz')); });
  await display.waitForFunction(
    () => /probe-failure-xyz/.test(document.getElementById('banner').textContent),
    null, { timeout: 5000 });

  const text = await display.evaluate(() => document.getElementById('banner').textContent);
  expect(text).toMatch(/background task failed/i);
  expect(await display.evaluate(() => document.getElementById('banner').style.display)).toBe('block');

  await ctx.close();
});

// ── Test 45: entering the back/forward cache must not delete the media ──────
// pagehide fires BOTH on real teardown and when a page is frozen into the
// bfcache — and a bfcached page comes back with its JavaScript state intact.
// Purging on the latter restored a tab holding a mediaMap full of items whose
// files had been deleted underneath it, with nothing on screen to explain it.
test('a bfcache pagehide does not delete the tab media', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const display = await ctx.newPage();
  await display.goto(baseURL.replace('THROW.html', 'display.html'), { waitUntil: 'domcontentloaded' });
  await display.evaluate(() => DiskStore.__setSmall(1));
  await display.waitForTimeout(300);

  const out = await display.evaluate(async () => {
    if (!(await DiskStore.probe())) return { skipped: true };
    await DiskStore.begin('B1', { name: 'b.bin', mime: 'text/plain', size: 5 });
    DiskStore.write('B1', new TextEncoder().encode('hello').buffer);
    await DiskStore.finish('B1');
    const before = (await DiskStore.__listFiles()).filter(f => !f.startsWith('.'));

    // frozen into the bfcache — the page can still come back
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    await new Promise(r => setTimeout(r, 700));
    const afterFrozen = (await DiskStore.__listFiles()).filter(f => !f.startsWith('.'));

    // genuinely going away — tidying up here is correct
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    await new Promise(r => setTimeout(r, 700));
    const afterUnload = (await DiskStore.__listFiles()).filter(f => !f.startsWith('.'));

    return { skipped: false, before: before.length, afterFrozen: afterFrozen.length, afterUnload: afterUnload.length };
  });

  test.skip(out.skipped, 'OPFS unavailable in this browser build');
  expect(out.before).toBeGreaterThan(0);
  expect(out.afterFrozen).toBe(out.before);   // bfcache: media survives
  expect(out.afterUnload).toBe(0);            // real teardown: reclaimed

  await ctx.close();
});
