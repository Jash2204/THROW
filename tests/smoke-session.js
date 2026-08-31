// Full-session smoke test: drives a realistic editing session end to end and
// fails on ANY uncaught error along the way. Complements the Playwright suite
// by exercising features in combination, in one long-lived page.
const { chromium } = require('@playwright/test');
const http = require('http'), fs = require('fs'), path = require('path');

const root = path.resolve('app');
const srv = http.createServer((req, res) => {
  const fp = path.resolve(root, '.' + (req.url === '/' ? '/THROW.html' : decodeURIComponent(req.url.split('?')[0])));
  if (fp !== root && !fp.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const d = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript' }[path.extname(fp)] || 'text/plain' });
    res.end(d);
  } catch { res.writeHead(404); res.end('nf'); }
});

const results = [], errs = [];
async function step(name, fn) {
  try { const v = await fn(); results.push([name, v === false ? 'FAIL' : 'ok']); }
  catch (e) { results.push([name, 'FAIL', e.message.slice(0, 70)]); }
}
// Keyboard shortcuts are deliberately swallowed while a form control has
// focus, so a script that just used a slider must release focus before
// pressing a shortcut — same as a user clicking back onto the stage.
const releaseFocus = (p) => p.evaluate(() => document.activeElement && document.activeElement.blur());

const mkPNG = (color, name) => `(async()=>{
  const c=document.createElement('canvas');c.width=800;c.height=600;
  const g=c.getContext('2d');g.fillStyle='${color}';g.fillRect(0,0,800,600);
  return new File([await new Promise(r=>c.toBlob(r,'image/png'))],'${name}',{type:'image/png'});
})()`;

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/THROW.html`;
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 130)); });

  await p.goto(base, { waitUntil: 'networkidle' });
  if (await p.locator('#helpClose').isVisible()) await p.locator('#helpClose').click();

  await step('add surface (A)', async () => {
    await p.keyboard.press('a'); await p.waitForTimeout(80);
    return await p.evaluate(() => window.surfaces.length) === 1;
  });
  await step('mesh 3x3', async () => {
    await p.locator('#meshSel .mgbtn[data-r="3"]').click(); await p.waitForTimeout(80);
    return await p.evaluate(() => window.surfaces[0].rows) === 3;
  });
  await step('stage preset 4K then FHD', async () => {
    await p.selectOption('#stagePreset', '3840x2160'); await p.waitForTimeout(100);
    const four = await p.evaluate(() => window.stageW) === 3840;
    await p.selectOption('#stagePreset', '1920x1080'); await p.waitForTimeout(100);
    return four && await p.evaluate(() => window.stageW) === 1920;
  });
  await step('drop image media', async () => {
    await p.evaluate(async (mk) => { loadMediaToSurface(window.surfaces[0], await eval(mk)); }, mkPNG('#c4ff2e', 'a.png'));
    await p.waitForTimeout(400);
    return await p.evaluate(() => window.surfaces[0].playlist.items.length) === 1;
  });
  await step('append 2nd playlist item', async () => {
    await p.evaluate(async (mk) => { addToPlaylist(window.surfaces[0], [await eval(mk)]); }, mkPNG('#ff466f', 'b.png'));
    await p.waitForTimeout(400);
    return await p.evaluate(() => window.surfaces[0].playlist.items.length) === 2;
  });
  await step('preview item 2 + per-item brightness', async () => {
    await p.locator('#plList .pl-row').nth(1).click(); await p.waitForTimeout(140);
    await p.locator('#adjBr').fill('40'); await p.waitForTimeout(140);
    return await p.evaluate(() => window.surfaces[0].playlist.items[1].adjust.br) === 0.4
        && await p.evaluate(() => window.surfaces[0].playlist.items[0].adjust.br) === 1;
  });
  await step('per-item crop', async () => {
    await p.locator('#cropW').fill('50');
    await p.locator('#cropW').dispatchEvent('change'); await p.waitForTimeout(140);
    return await p.evaluate(() => window.surfaces[0].playlist.items[1].crop.w) === 0.5;
  });
  await step('crossfade transition', async () => {
    await p.selectOption('#selTransition', 'crossfade'); await p.waitForTimeout(100);
    return await p.evaluate(() => window.surfaces[0].playlist.transition) === 'crossfade';
  });
  await step('copy surface', async () => {
    await p.click('#btnDup'); await p.waitForTimeout(250);
    return await p.evaluate(() => window.surfaces.length) === 2;
  });
  await step('send to back reorders', async () => {
    const before = await p.evaluate(() => window.surfaces.map(s => s.id).join());
    await p.click('#btnBack'); await p.waitForTimeout(120);
    return before !== await p.evaluate(() => window.surfaces.map(s => s.id).join());
  });
  await step('scale slider', async () => {
    await p.locator('#rngScale').fill('150'); await p.waitForTimeout(140);
    return true;
  });
  await step('undo x3 / redo x2', async () => {
    const d0 = await p.evaluate(() => window.undoDepth);
    await p.evaluate(() => { window.undo(); window.undo(); window.undo(); }); await p.waitForTimeout(250);
    await p.evaluate(() => { window.redo(); window.redo(); }); await p.waitForTimeout(250);
    return d0 > 0;
  });
  await step('trace mode builds a sticker', async () => {
    // Order matters: #tmMask lives INSIDE the place overlay, so trace mode has
    // to be entered first. Trace in the upper-left, clear of the centred
    // instruction box which would otherwise swallow the clicks.
    await releaseFocus(p);
    await p.keyboard.press('p'); await p.waitForTimeout(180);
    await p.click('#tmMask');
    const r = await p.evaluate(() => { const q = document.getElementById('placeCanvas').getBoundingClientRect();
                                       return { l: q.left, t: q.top, w: q.width, h: q.height }; });
    for (const [dx, dy] of [[0.08, 0.08], [0.28, 0.08], [0.28, 0.28], [0.08, 0.28]])
      await p.mouse.click(r.l + r.w * dx, r.t + r.h * dy);
    await p.keyboard.press('Enter'); await p.waitForTimeout(250);
    return await p.evaluate(() => window.surfaces.some(s => s.mask && s.mask.length >= 3));
  });
  await step('O / H toggles', async () => {
    await releaseFocus(p);
    const o0 = await p.evaluate(() => window.outputShowOutlines);
    await p.keyboard.press('o'); await p.waitForTimeout(80);
    const oOK = await p.evaluate(() => window.outputShowOutlines) !== o0;
    const h0 = await p.evaluate(() => window.handlesVisible);
    await p.keyboard.press('h'); await p.waitForTimeout(80);
    return oOK && await p.evaluate(() => window.handlesVisible) !== h0;
  });
  await step('save project JSON', async () => {
    const j = await p.evaluate(async () => {
      let cap = null;
      const oc = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (bl) => new Promise(res => {
        const r = new FileReader(); r.onload = e => { cap = e.target.result; res('blob:x'); }; r.readAsText(bl);
      });
      const ok = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      document.getElementById('btnSave').click();
      await new Promise(r => setTimeout(r, 600));
      URL.createObjectURL = oc; HTMLAnchorElement.prototype.click = ok;
      return cap;
    });
    await p.evaluate(t => { window.__saved = t; }, j);
    const d = JSON.parse(j);
    return d.surfaces.length > 0 && d.stageW === 1920;
  });
  await step('clear all', async () => {
    p.once('dialog', d => d.accept());
    await p.click('#btnClear'); await p.waitForTimeout(200);
    return await p.evaluate(() => window.surfaces.length) === 0;
  });
  await step('load project back (geometry + image)', async () => {
    await p.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([window.__saved], 'p.throw.json', { type: 'application/json' }));
      const i = document.getElementById('fileLoad'); i.files = dt.files;
      i.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await p.waitForTimeout(600);
    return await p.evaluate(() => window.surfaces.length) > 0
        && await p.evaluate(() => window.surfaces.some(s => s.playlist && s.playlist.items.length > 0));
  });
  await step('loaded ids are unique', async () => {
    await releaseFocus(p);
    await p.keyboard.press('a'); await p.waitForTimeout(100);
    return await p.evaluate(() => new Set(window.surfaces.map(s => s.id)).size === window.surfaces.length);
  });
  await step('delete selection', async () => {
    const n = await p.evaluate(() => window.surfaces.length);
    await p.locator('.layer-item').first().click(); await p.waitForTimeout(90);
    await p.click('#btnDel'); await p.waitForTimeout(150);
    return await p.evaluate(() => window.surfaces.length) === n - 1;
  });
  await step('error banner stayed silent', async () =>
    await p.evaluate(() => document.getElementById('errBanner').style.display) !== 'block');

  const w = Math.max(...results.map(r => r[0].length));
  console.log(results.map(([n, s, d]) => '  ' + (s === 'ok' ? 'ok  ' : 'FAIL') + '  ' + n.padEnd(w) + (d ? '  ' + d : '')).join('\n'));
  const failed = results.filter(r => r[1] === 'FAIL').length;
  console.log('\nSTEPS: ' + (results.length - failed) + '/' + results.length + ' passed');
  console.log('UNCAUGHT ERRORS: ' + (errs.length ? '\n  ' + errs.join('\n  ') : 'none'));
  await b.close(); srv.close();
  process.exit(failed || errs.length ? 1 : 0);
})();
