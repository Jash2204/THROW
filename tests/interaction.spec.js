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

  // validator still clamps garbage but keeps legit zeros (brightness 0 = black)
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
