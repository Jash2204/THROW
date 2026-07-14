# THROW — Test Checklist

Automated Playwright tests (12) cover interaction, presets, thumbnails, JSON round-trips, and editor↔display sync (`npm test`). The items below need a real browser session and real hardware.

**Important:** test video playback in a browser you launched yourself (via `start.bat`), NOT one launched by automation — Playwright's flags disable the exact media-suspension behaviours that broke earlier designs (NOTES.md §2).

---

## Setup

- [ ] Double-click `start.bat` — server starts minimized, editor opens at `http://localhost:8420/THROW.html`
- [ ] DevTools console (F12): **zero errors on load**

## 1 · Two-tab flow (the core path)

- [ ] Click **⧉ Display** — display.html opens in a new tab ("waiting for the editor" disappears immediately)
- [ ] Add a surface in the editor — it appears in the display within a frame
- [ ] Drag corners/body in the editor — display updates live
- [ ] Click **⛶ FULLSCREEN** in the display — HUD and cursor hide; Esc restores them
- [ ] `O` toggles outlines in both tabs

## 2 · Video (the historically broken path — test thoroughly)

- [ ] Load **3 clips at once** — display holds ~60 fps (WebGL renderer); if a clip stalls, the watchdog recovers it or a banner names the decode limit

- [ ] Drop an **H.264 .mp4** on a surface: editor shows a captured frame + ▶ badge; display **plays it, moving**
- [ ] Let it play **at least 30 seconds and through a loop restart** — earlier bugs froze at 0.4–4.4s with a convincing first frame
- [ ] Fullscreen the display so it covers the editor (single screen) — video keeps playing
- [ ] Minimize the editor window entirely — video keeps playing in the display
- [ ] Drop a **4K clip** — still plays (staging-canvas path); editor stays responsive
- [ ] Drop an **HEVC/H.265 "live wallpaper"** — advisory toast, then either plays (hardware decode) or a precise banner **in both tabs** naming the codec problem + HandBrake hint
- [ ] Drop an **.mkv / .avi** — error names the container specifically
- [ ] Drop a corrupt/zero-byte file — banner, no crash, other surfaces unaffected

## 3 · Images & animated formats

- [ ] png/jpg/webp — render warped in both tabs
- [ ] Animated **.gif** — editor toast reports frame count; **animates in the display**
- [ ] Animated **.webp**, **.avif** — same (Chrome 113+; graceful fallback otherwise)

## 4 · Multi-surface & isolation

- [ ] 4 surfaces, different blends (Normal/Screen/Add/Multiply) + opacities — composite independently in both tabs (WebGL path)
- [ ] Set one surface to **Overlay** — display shows the compatibility-renderer note and still composites correctly (Canvas2D fallback)
- [ ] Break one surface's media (corrupt file) — the others keep rendering; broken one shows placeholder + banner
- [ ] Delete a surface — it disappears from the display (geometry AND its media)
- [ ] Dup a surface with media — the copy shows media in the display too

## 4b · Adjust panel

- [ ] Brightness/Contrast/Color/Hue sliders change the selected surface in BOTH tabs live (editor via canvas filter, display via shader)
- [ ] Flip H / Flip V mirror the media inside the mesh — the mesh geometry itself does not move
- [ ] Reset restores neutral values; adjustments survive Save → Load
- [ ] Adjustments render identically on the WebGL path and the Canvas2D fallback (set blend Overlay to force the fallback)

## 5 · Stage & calibration

- [ ] Preset change (e.g. 4K) — applies in both tabs instantly; surfaces keep absolute position/scale
- [ ] Custom size works; last size restored on reload
- [ ] Drag a surface fully off-stage — allowed; not projected; `C` rescues it
- [ ] Stage preset = projector native res + display fullscreen → mapping is pixel-exact and **does not shift** while editing

## 6 · Editor interaction regression

- [ ] Hit priority on 3×3+: corners → center-grab (translates) → inner points (deform)
- [ ] Body-drag moves whole surface rigidly; dense-mesh handles shrink instead of overlapping in a small window
- [ ] `H` hides handles; dragging anywhere then moves whole surfaces (no invisible corner-warps)
- [ ] Trace mode: 5 points → Enter/right-click fits the surface; Esc cancels; Backspace undoes a point

## 7 · Save / load

- [ ] Save → Clear → Load: geometry, blends, names, images restore (images reappear in the display too)
- [ ] Hand-edit JSON: `<script>` in a name renders as text; `"mediaSrc":"javascript:…"` is stripped; `"stageW":-1` errors cleanly

## 8 · Lifecycle & errors

- [ ] Close the display tab — editor's Display button deactivates; reopening reconnects and repopulates (geometry + media) automatically
- [ ] Reload the display tab alone — same: full state restored without touching the editor
- [ ] Force an error while projecting — the banner shows **in the display**, not just the editor

## 9 · Security

- [ ] DevTools Network tab: only `localhost:8420` requests for the app's own files — nothing external
- [ ] Sources search: no `eval(`, no `new Function(`
