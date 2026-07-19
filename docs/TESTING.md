# THROW — Test Checklist

Automated Playwright tests (12) cover interaction, presets, thumbnails, JSON round-trips, and editor↔display sync (`npm test`). The items below need a real browser session and real hardware.

**Important:** test video playback in a browser you launched yourself (via `start.bat`), NOT one launched by automation — Playwright's flags disable the exact media-suspension behaviours that broke earlier designs (NOTES.md §2).

---

## Setup

- [ ] Double-click `start.bat` — server starts minimized, editor opens at `http://localhost:8420/THROW.html`
- [ ] DevTools console (F12): **zero errors on load**
- [ ] Layout reads as: toolbar on top · SURFACES rail left · stage centre · INSPECTOR rail right · status bar bottom
- [ ] Stage stays centred in its column at any window size; the toast never collides with the corner/inner/move legend

## 1 · Two-tab flow (the core path)

- [ ] The ⧉ Display button goes solid acid with a pulsing dot and reads "LIVE" once the display connects; it reverts when that tab closes
- [ ] Click **⧉ Display** — display.html opens in a new tab ("waiting for the editor" disappears immediately)
- [ ] Add a surface in the editor — it appears in the display within a frame
- [ ] Drag corners/body in the editor — display updates live
- [ ] Click **⛶ FULLSCREEN** in the display — HUD and cursor hide; Esc restores them
- [ ] `O` toggles outlines in both tabs

## 2 · Video (the historically broken path — test thoroughly)

- [ ] Load **3 clips at once** — display holds ~60 fps (WebGL renderer); if a clip stalls, the watchdog recovers it or a banner names the decode limit

- [ ] Drop an **H.264 .mp4** on a surface: editor shows a captured frame + ▶ badge; display **plays it, moving**
- [ ] Let it play **at least 30 seconds and through a loop restart** — no placeholder/outline flash at the loop boundary (last frame holds through the seek) — earlier bugs froze at 0.4–4.4s with a convincing first frame
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

## 4a · Playlists

- [ ] ＋ Add two videos to one surface — they play in order on the display; the second starts when the first ends
- [ ] Mix an image between videos — the image holds for the configured Image time, then advances
- [ ] Crossfade: during the fade both items are briefly visible blending into each other; Fade to black dips through black; Cut is instant
- [ ] Reorder items (↑/↓) — the display follows immediately without re-transferring files
- [ ] Remove the currently-playing item — playback recovers onto a remaining item
- [ ] Single-video playlist still loops seamlessly (no flash at the loop point)

## 4a2 · Stacking, scale & per-item looks

- [ ] Overlap two surfaces — `⤒ Front` / `⤓ Back` (and `]` / `[`) change which one covers the other, in the editor AND the display
- [ ] Scale slider grows/shrinks the selected surface about its centre; a warped mesh keeps its shape; dragging back to 100% restores the original size
- [ ] With 2+ playlist items: clicking a row previews that item on the stage and ADJUST's header switches to that item's filename
- [ ] Give item 1 and item 2 different brightness/hue — each keeps its own look; a Crossfade between them blends the two looks rather than snapping
- [ ] Flip an item — only that item mirrors, the mesh geometry does not move
- [ ] Reset clears only the selected item

## 4b · Adjust panel

- [ ] Brightness/Contrast/Color/Hue sliders change the selected surface in BOTH tabs live (editor via canvas filter, display via shader)
- [ ] Flip H / Flip V mirror the media inside the mesh — the mesh geometry itself does not move
- [ ] Reset restores neutral values; adjustments survive Save → Load
- [ ] Adjustments render identically on the WebGL path and the Canvas2D fallback (set blend Overlay to force the fallback)

## 5 · Stage & calibration

- [ ] The toolbar STAGE control shows the current size; "Custom…" opens the W/H popover under it
- [ ] Preset change (e.g. 4K) — applies in both tabs instantly; surfaces keep absolute position/scale
- [ ] Custom size works; last size restored on reload
- [ ] Drag a surface fully off-stage — allowed; not projected; `C` rescues it
- [ ] Stage preset = projector native res + display fullscreen → mapping is pixel-exact and **does not shift** while editing

## 6 · Editor interaction regression

- [ ] 1×1 mesh: exactly 4 corner handles, drag warps that corner, body drag moves all four
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
