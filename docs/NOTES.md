# NOTES — Engineering decisions

The reasoning log for THROW's non-obvious decisions: what was changed, why the fix targeted the root cause rather than the symptom, and which alternatives were rejected. The README says *what* the tool does; this file says *why it's built the way it is*.

---

## Architecture: two tabs, one channel

THROW is two pages served from a tiny local server (`start.bat` → `python -m http.server`):

- **`THROW.html`** — the editor. All interaction, all state. Renders lightweight thumbnails only; **never plays a video**.
- **`display.html`** — the projector output. A pure renderer: receives geometry over `BroadcastChannel`, receives media as **bytes**, and creates/plays its own `<video>` elements locally. Fullscreen it on the projector; every edit in the editor appears live.
- **`shared.js`** — warp math, rendering, and media-format helpers used by both.

This replaced two earlier designs that failed in instructive ways (§2). The split follows one hard-won rule: **the window doing the projecting must own everything it needs to render** — its media elements, its decode pipeline, its render loop. Any resource owned by another window is hostage to that window's lifecycle (occlusion, backgrounding, throttling).

Why a server at all? Two browser tabs can only talk if they share an origin — `file://` pages are isolated opaque origins with no channel between them. `localhost` gives same-origin `BroadcastChannel` for free. The server is `python -m http.server`; there is still no build step, no bundler, no dependency beyond Python.

## 2 · The video-stall hunt (why the architecture looks like this)

The single hardest bug: **videos loaded, showed a first frame, then froze** — silently — in real Chrome, while passing automated tests. Root-causing it took four designs and five bisections. The chain of findings, each verified empirically on the failing machine with the failing file (an 82 MB 4K H.264 clip):

1. **Design 1 — editor plays videos, pushes canvas pixels to a child window.** Fails: Chrome suspends media in occluded windows. On a single screen, fullscreening the output covers the editor → its videos freeze and go black. (Automated tests passed because Playwright launches Chrome with occlusion-backgrounding disabled — a lesson in itself: *test browsers are not user browsers*.)
2. **Design 2 — child window owns `<video>` elements, parent still warps.** Fails the same way for a different reason: playback stalled at `readyState 2` even in the visible window.
3. **Bisection A:** a `Blob` handle sent through `BroadcastChannel`/`postMessage` is a *lazy cross-context reference*. Header reads work (first frame decodes, thumbnails appear — maximally misleading), but the demuxer's streaming reads through the cross-context blob registry starve. **Fix: ship an `ArrayBuffer` copy and rebuild the Blob locally.** Bytes on the receiving side are fully materialized; playback reads never leave the tab. (~100 ms one-time copy per load.)
4. **Bisection B:** still stuck. Play-only tests advanced; the real pipeline froze. Disabling the renderer un-froze it: **sampling a `<video>` with `drawImage` per warp-triangle (72×/frame on a 3×3 mesh) stalls Chrome's video decoder.** **Fix: blit the video into a staging canvas once per frame and warp from the canvas.** Also ~70× less video sampling per frame. This is the classic texture-upload pattern from GL warp engines, rediscovered the hard way.

Both fixes are invisible in a demo and fatal in production — the class of bug that only falls to *bisection against the real environment*, not to reading code. The repro scripts drove the user's actual installed Chrome over CDP (no automation flags) because Playwright-launched Chrome masked every one of these behaviours.

## 2b · Performance: WebGL display, cached editor, honest decode limits

Three simultaneous clips lagged. Profile said the renderer, not the videos: Canvas2D warping costs ~72 clipped `drawImage` calls per surface per frame — the one workload GPUs do natively for free. Fixes, in effect order:

- **The display renders with WebGL**: video frame → texture (one upload per frame), whole warped mesh in one draw call. Measured on the failing machine: 3 × 4K clips went from lagging to a flat 60 fps. Normal/Screen/Multiply/Add composite via `blendFunc` (+ a shader trick for multiply-with-opacity); Overlay/Hard-Light/Color-Dodge aren't expressible that way, so those drop the frame to the retained Canvas2D fallback with a visible note — honest degradation, not silent. Placeholders and outlines draw on a stacked 2D overlay canvas (mixing contexts on one canvas is impossible).
- **The editor caches warped buffers**: static media re-warps only when mesh/stage/media change (`warpKey`); blend and opacity apply at composite time so the sliders never trigger re-warps.
- **Decode is the real ceiling** and no renderer or native app moves it: GPUs decode a finite number of simultaneous streams. When a stream starves ("playing" but `currentTime` frozen — the same signature as the §2 stalls), the display's watchdog re-seek-nudges the pipeline, and if it keeps stalling, says plainly: *you're at the hardware decode limit; use 1080p sources* (the projector can't show more anyway).

## 3 · The fullscreen-shift problem, dissolved by workflow

Users calibrated in a floating window, then fullscreened the output — and everything moved. Of course it did: the output letterboxes the stage (`Math.min` fit), so scale and offsets change with window size. No rendering trick fixes this; recalibrating against a moving target is the actual bug.

The two-tab flow removes the problem instead of solving it: **fullscreen the display first, then calibrate — live — from the editor.** The mapping never changes after alignment because the window never changes. Set the stage preset to the projector's native resolution and fullscreen is exactly 1:1 pixels.

## 4 · Media formats: accept everything, report honestly

- Extension/MIME nets are deliberately wide (mkv/avi/wmv/flv/mpeg/ts/3gp/…): whether something plays is the browser's decision, not a THROW allowlist. No paternalistic pre-blocking.
- Failure messages come from the real `MediaError.code` (`mediaErrText`) with a container-specific hint (`playbackHint`): an `.mkv` gets "convert the container", an `.mp4` that won't decode gets "likely HEVC/AV1 live-wallpaper codec → H.264". Never a guessed blanket message.
- The codec sniffer is **advisory only** and scans only the pre-`mdat` region (FourCCs occur by chance in frame data; header-only scanning avoids false positives). Many machines decode HEVC in hardware — pre-blocking would be wrong there.
- A typeless blob gets its MIME forced from the extension (`typedBlobURL`) — a real-world cause of Chrome rejecting valid files.
- One silent clean-reload retry before any error is surfaced: transient decode hiccups resolve on reload, and blaming the file for them is wrong.
- Animated GIF/WebP/AVIF/APNG decode via WebCodecs `ImageDecoder` into a self-advancing canvas with per-frame durations; graceful `<img>` fallback where unavailable, with format-specific error text.
- Display-tab errors are **mirrored to the editor** over the channel — the user watching the wall and the user at the laptop both see them.

## 5 · Editor rendering: thumbnails only

The editor draws ≤512 px thumbnails; videos contribute a single captured frame (seeked ~0.1 s in, so black lead-ins don't thumbnail) grabbed by a throwaway element that is destroyed immediately. Consequences: the editor never competes with the display for decode resources, a wall of 4K clips costs nothing while calibrating, and the layer panel's ▶ badge is the honest signal that a video will move when displayed. The original `File` blob is retained for the display tab and for export.

## 6 · Canvas invariants (unchanged through every redesign)

- Every `save()`/`restore()` around state-mutating canvas ops is `try/finally`-guarded (`texTri`, surface compositing). A throwing `drawImage` must never leak clip/transform state into subsequent surfaces.
- Each surface renders to an offscreen buffer with normal compositing, then composites **once** with its blend mode + opacity — internal triangle seams never double-blend.
- The render loops always reschedule (`requestAnimationFrame` outside the `try`) — one bad frame can't kill the show; one broken surface is skipped with a banner while the rest keep rendering.

## 7 · Interaction decisions

- Hit priority: corners → center-grab → inner points. On odd meshes the geometric center coincides with an inner control point; center-first means grabbing the middle *translates* instead of deforming.
- Body-drag anywhere on a surface translates it rigidly; a drag is distinguished from a click so selection never warps anything.
- Handles render at constant on-screen size but are capped at a fraction of the smallest on-screen gap between mesh points — full grab size when there's room, shrinking exactly when they'd overlap (dense mesh or small window).
- `H` hides handles entirely, and hidden handles are **not grabbable** — an invisible corner-drag would warp the mesh with no visible cause, so with handles off every drag is a whole-surface move. Visibility and grabbability travel together.
- Surfaces may sit partly or fully off-stage (off-stage = not projected). No auto-clamping — parking media off-stage during calibration is legitimate. `C` re-centers a lost surface on demand.

## 7a · Playlists: content-addressed items, state-driven order

Playlist item blobs cross the channel ONCE, addressed by item id; order, transition type, and durations ride the (tiny, diffed) state broadcast. Consequence: reordering or removing items in an 80MB-per-clip playlist costs zero bytes of media transfer, and a display tab that reconnects gets everything replayed idempotently. The scheduler lives in the display (it owns playback): videos advance on their real `ended` event, images on a timer; crossfades render BOTH items as two GL passes on the same mesh with complementary opacity multipliers, so every blend mode and adjustment still applies during the fade. Inactive items sit paused at frame 0 — they consume no decode budget until their turn.

## 7a2 · The look lives on the playlist item, not the surface

A surface is a *place on the wall*; a playlist item is *the thing being shown there*. Brightness/contrast/colour/hue/flips describe the thing, so they live on the item — which means two clips on one surface can look completely different, and a crossfade renders each pass with its own look instead of a single surface-wide filter. The surface keeps one `adjust` as a **seed**: it's what the ADJUST panel edits while a surface has no media, and what new items inherit, so the "calibrate the surface once and every clip matches" workflow survives.

Two consequences worth noting. Flips moved from the mesh UVs into a shader uniform (`v_uv = abs(u_flip - a_uv)` — `abs(0-uv)=uv`, `abs(1-uv)=1-uv`), because per-item flips would otherwise need a mesh per item; this also dropped flips out of the mesh cache key, so one mesh now serves every item. And the previewed item is remembered **per surface** (`s._selItem`) rather than in one global, because a global lets you select surface B, click its item 3, switch back to A, and leave ADJUST editing a different item than the stage is previewing.

## 7b · Image adjustments: composite-time, both renderers

Per-surface brightness/contrast/saturation/hue apply at COMPOSITE time — canvas `filter` in the editor, the same math as shader uniforms in the display GL path — so dragging a slider never invalidates a warp cache or rebuilds a mesh. Flips are the exception: they mirror the media *within* the mesh, which is a UV change, so they participate in the warp/mesh cache keys. One validator gotcha worth remembering: `Number(x) || default` silently destroys legitimate zeros (brightness 0 = black, saturation 0 = grayscale); the sanitiser uses `Number.isFinite` instead.

## 7c · Stickers: one mask, two clip paths, deforms with the mesh

A sticker is a surface plus a polygon mask stored in **mesh-UV** (0..1 of its bounding box at trace time). Because the mask lives in UV, `maskStagePts` maps each vertex through the current mesh (`meshMapUV`) — so dragging a corner warps the outline exactly like the media. Two clip implementations, kept in lockstep: Canvas2D (editor + fallback) sets a `clip()` path in `compositeSurface`; WebGL stencils the shape. The stencil path ear-clips the polygon (concave-safe), stamps it into the stencil buffer with colour writes off, then draws the media with `stencilFunc(EQUAL,1)` — and critically resets `disable(STENCIL_TEST)` per unmasked surface so a mask never leaks onto its neighbours (verified with a masked-over-unmasked pixel readback; the first "leak" I saw was a bad sample point in the letterbox, not a real bug).

## 7d · Crop and trim: composite-time and frame-time, not warp-time

Crop is a source sub-rectangle threaded as a per-item vec4: `v_uv = crop.xy + abs(flip - uv) * crop.wh` in the shader, the same arithmetic in the Canvas2D UV functions. It rides in the warp cache key but is otherwise free. Trim (in/out seconds) is the one feature that had to touch the display's video core: the 1.5s stall-watchdog is too coarse, so `tickPlaylists` cues each active clip to its `trimIn` on activation and loops/advances at `trimOut` every frame; native `loop` is disabled whenever a trim window is set so it can't loop the whole file.

## 7e · Transcode on import: the honest 4K fix, zero dependencies

`MediaRecorder` + `canvas.captureStream` are native, so downscaling needs no library: play the source through once, `drawImage` each frame into a target-resolution canvas, record its stream to WebM. Measured on the 4K Mustang clip: **82.7 MB H.264 → 8.5 MB 1080p WebM**, and it plays through the unchanged pipeline. It's real-time (a 12s clip takes ~12s) with a live % on the button, and THROW suggests it automatically for >1080p sources. This is the in-app answer to §9b — the decode ceiling is hardware, but a 1080p projector throws away three-quarters of a 4K frame anyway, so re-encoding removes quality that can't reach the wall.

## 7f · Undo/redo without heavy snapshots

Snapshots are plain JSON — geometry, z-order (the `surfaces` array order), per-item look/crop/trim, mask (as UV). Media never enters a snapshot: items are registered by id in `itemRegistry` and re-linked on restore, so a snapshot is a few KB and undoing a *delete* brings the File/thumbnail/decoded-frame back. Continuous gestures (drags, sliders, number fields) snapshot once at gesture start via a `beginGesture`/`endGesture` armed flag, so a 100-step opacity drag is one undo step; arrow nudges coalesce on an 800ms timer.

## 8 · Security posture

Local-only tool; zero network calls beyond the local server serving its own files. Untrusted inputs are media files and imported project JSON:

- Imported JSON passes `validateProjectData()`: type/range checks, blend-mode allowlist, `mediaSrc` must be `data:image/` or is stripped, names truncated to plain text. `textContent` everywhere user-derived strings meet the DOM; no `eval`, no `new Function`.
- Blob URLs revoked on media replace/remove; animated decoders stopped on release.

## 9 · Testing strategy

Playwright covers what synthetic events can prove: drag semantics, hit priority, canvas state isolation, presets, thumbnails, off-stage freedom, JSON round-trip/rejection, and **cross-tab sync** (editor and display as two same-origin pages exchanging geometry and media over the channel). Hardware truths — fullscreen on a projector, decode stalls, occlusion behaviour — live in `TESTING.md` as a manual checklist, plus the lesson from §2: anything involving real video must additionally be verified in a *user-launched* browser, because automation flags change media behaviour.

## 9b · The decode ceiling is real, and it is not ours to fix

4K120 sources stutter, and no amount of renderer work changes that: a single hardware decode block (NVDEC/QuickSync/VCN) is typically specified around 4K60 per stream, so 4K120 either exceeds its throughput or isn't supported for that profile at all — at which point Chrome silently falls back to **software** decode and the CPU is the bottleneck. A native app would use the same decoder and hit the same wall; this is hardware, not browser sandboxing. It's also self-inflicted: a 1080p projector throws away three quarters of a 4K frame and half of a 120fps stream, so the "quality" being buffered is quality that physically cannot reach the wall. THROW's honest answer is the stall watchdog (§2b) — detect the frozen `currentTime`, say plainly that this is the decode limit, and point at 1080p sources. The only real in-app fix would be transcoding on import (WebCodecs decode → re-encode at stage resolution), which is a genuine feature, not a bug fix.

## 10 · Why not an app

Electron/Tauri would buy reliable multi-display placement and no server — at the cost of binaries, signing warnings, and an update pipeline. The current shape (three files + a .bat, one optional Python dependency) keeps the "download and run" story. If it ever graduates: a thin Tauri wrapper around these same files is packaging, not a rewrite.
