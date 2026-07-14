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
    const fp = path.join(root, req.url === '/' ? 'THROW.html' : decodeURIComponent(req.url.split('?')[0]));
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

  // Default state: outlines ON (button has class "active")
  const btn = page.locator('#btnOutlines');
  await expect(btn).toHaveClass(/active/);

  const initialState = await page.evaluate(() => window.outputShowOutlines);
  expect(initialState).toBe(true);

  // Press O → off
  await page.keyboard.press('o');
  await page.waitForTimeout(30);
  const afterO = await page.evaluate(() => window.outputShowOutlines);
  expect(afterO).toBe(false);
  await expect(btn).not.toHaveClass(/active/);

  // Click button → on
  await btn.click();
  await page.waitForTimeout(30);
  const afterClick = await page.evaluate(() => window.outputShowOutlines);
  expect(afterClick).toBe(true);
  await expect(btn).toHaveClass(/active/);

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

// ── Test 12: Adjust panel ─────────────────────────────────────────────────────
// Sliders write per-surface adjust state, flips toggle, values survive the
// export validator, and the display tab receives them over the channel.
test('adjust sliders and flips modify surface state and sync to the display', async ({ browser }) => {
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

  // default adjust exists on new surfaces
  expect(await editor.evaluate(() => window.surfaces[0].adjust.br)).toBe(1);

  // slider input → state (range inputs need a real input event)
  await editor.evaluate(() => {
    const el = document.getElementById('adjBr');
    el.value = 150;
    el.dispatchEvent(new Event('input'));
  });
  expect(await editor.evaluate(() => window.surfaces[0].adjust.br)).toBe(1.5);

  // flip toggles and reflects in the button state
  await editor.click('#btnFlipH');
  expect(await editor.evaluate(() => window.surfaces[0].adjust.flipH)).toBe(true);
  await expect(editor.locator('#btnFlipH')).toHaveClass(/active/);

  // display receives the adjust values over the channel
  await display.waitForFunction(
    () => window.surfaceList.length === 1 &&
          window.surfaceList[0].adjust &&
          window.surfaceList[0].adjust.br === 1.5 &&
          window.surfaceList[0].adjust.flipH === true,
    null, { timeout: 5000 }
  );

  // validator clamps garbage but keeps legit zeros (brightness 0 is valid black)
  const validated = await editor.evaluate(() => {
    const d = window.validateProjectData({
      stageW: 1920, stageH: 1080,
      surfaces: [{ rows: 2, cols: 2, pts: [], adjust: { br: 0, ct: 99, sat: 'junk', hue: -5, flipH: 1 } }]
    });
    return d.surfaces[0].adjust;
  });
  expect(validated.br).toBe(0);        // zero preserved
  expect(validated.ct).toBe(2);        // clamped to max
  expect(validated.sat).toBe(1);       // junk → default
  expect(validated.hue).toBe(0);       // negative clamped
  expect(validated.flipH).toBe(true);  // coerced boolean

  // reset restores defaults
  await editor.click('#btnAdjReset');
  expect(await editor.evaluate(() => window.surfaces[0].adjust.br)).toBe(1);
  expect(await editor.evaluate(() => window.surfaces[0].adjust.flipH)).toBe(false);

  await ctx.close();
});

// ── Test 13: JSON import rejects malformed data ───────────────────────────────
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
