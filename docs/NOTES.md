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

## 11 · Three fixes found by reading the code back

- **`start.bat` never detected anything.** The guard was `where python >/dev/null 2>nul` — POSIX redirection in a batch file. `/dev/null` isn't a valid Windows path, so the redirect failed *before* `where` ran and errorlevel stayed 0: `if not errorlevel 1 goto run` always branched to `run`, and the `:nopython` help text was unreachable dead code. Worse, `where python` is the wrong test even when spelled right — Windows 10/11 ship a Microsoft Store alias stub at `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`, so the name resolves on machines with no Python and `python -m http.server` opens the Store instead of serving. Detection now *executes* each candidate (`python -c "import sys"`; the stub exits 9009 quietly) and falls back to Node via `serve.js` before giving up. The zero-install story survives: one of Python or Node is on virtually every dev machine.

- **The editor's warp cache could show the previous image.** `warpKey` identified media by `el.width`, but `makeThumb` scales every source into a ≤512px box — so *every* 16:9 clip becomes 512×288 and any two of them shared a key. Replacing a surface's image re-composited the stale `_warpBuf`. Dimensions can't identify media here; object identity can, so elements now carry a lazily-stamped `_throwElId` (§7b's "flips participate in the cache key" reasoning was right, it just wasn't enough to identify the *media*). Dimensions stay in the key too — an `<img>`'s `naturalWidth` goes 0 → real on load without the element changing.

- **Loaded projects collided with newly-added surfaces.** Import kept the file's ids while `uid()`'s counter restarts at 0 each page load, so a saved `S1` and the next hand-added surface shared an id — and every `surfaces.find(s => s.id === selId)` resolved to whichever came first, so you'd select one surface and watch the other move. Import now mints fresh ids; nothing cross-references surface ids in the save format, so renaming on import is free, and it also absorbs duplicate ids in a hand-edited file.

All three have regression tests (suite is now 22). The first two were verified *failing* against the unfixed code before the fix landed — a test that has never failed hasn't proved anything.

## 12 · Second pass: the fixes that needed fixing

The §11 round was followed by a full re-read. Three of the new findings were bugs introduced *by* that round — worth recording, because each is a different way a correct-looking optimisation goes wrong.

- **The pull protocol double-sent every clip.** To stop undo re-shipping media (§11), the display began asking for items its playlist order referenced but its store lacked. That looked right and was wrong on the normal path: `bcSendPlaylist` starts an async `arrayBuffer()` read, while the state broadcast goes out on the very next frame — so the display sees the order *before* the blob and asks for a file already in flight. Every dropped clip crossed the channel twice. The request now waits out a grace period longer than a large read. The trap in *testing* it is the same shape: a small blob's `arrayBuffer()` resolves before the next frame, so the race never opens and the test passes — the test has to model a slow read to be worth anything.

- **Gaps were cleaned up on the wrong clock.** The first version of that fix cleared the missing-item bookkeeping inside `syncPl` — which only runs when the state snapshot *changes*. Once the scene settles no more state arrives, the bookkeeping never cleared, and the sweep fired anyway. Cleanup now happens when an item actually lands, and is re-validated by the sweep, which runs on its own timer.

- **The dirty flag swallowed the display handshake.** `broadcastState` is now gated on a dirty flag (with a 500ms safety rebuild, because a pure flag that misses one mutation site freezes the projector forever). `hello-display` clears `_lastSnap` to force a resend — but a channel message is not a click or an input event, so nothing marked the state dirty and the resend waited for the safety net. The gate has to be opened explicitly there.

Two older bugs surfaced in the same pass:

- **Copy shared the original's media.** `Copy` spread the source surface's `s.media`, so the clone's `media.item` still pointed at the *original's* playlist item — `editorAdjust()` previewed the original's look, and editing the copy moved the projector but not the editor stage. It also inherited the original's blob URL, which `freeMedia()` on the original revokes, blanking the copy. Building the clone's preview from its own item fixes both.

- **The display re-serialised all geometry every frame.** `drawGL` recomputed `JSON.stringify(s.pts)` per surface per frame purely to decide whether to rebuild the VBO — in the tab whose entire job is holding 60fps against several 4K streams. Geometry only ever changes via a state message, so the key is stamped there instead. Same class of bug as the editor's per-frame snapshot, hiding in the more performance-critical tab.

Also: decoded `VideoFrame`s from the animated-image path were never `close()`d (they hold GPU memory and are not ordinary GC'd objects — a long GIF is hundreds of them); `pts` is now shape-checked, not just type-checked, since it is the one field the renderer indexes blindly every frame; and the styled `div`/`span` controls got button semantics, which were the last part of THROW with no keyboard path.

Suite is 31. The rule from §11 held throughout: every regression test here was watched failing against the unfixed code first.

## 13 · Splitting the editor, without changing it

`THROW.html` was 2,564 lines: markup, styles, and a 2,098-line inline script. It is now markup plus twelve ordered scripts in `app/editor/`, cut at the file's own `// ── Section ──` comments.

**Classic scripts, deliberately — not ES modules.** Classic scripts share one global lexical scope, so the ~148 top-level bindings still see each other with no import graph, and the mutual recursion between state ↔ panels ↔ media ↔ sync ↔ undo (`updateUI` → `selItem`; `buildEditorMedia` → `updateUI`; `restore` → `bcSendPlaylist` + `updateUI` + `buildEditorMedia`; `loadMediaToSurface` → `pushUndo`) keeps working untouched. Modules would have made every one of those a cycle to resolve. They also execute in document order, so load-time ordering is identical to the single-script version.

**The method was mechanical, and verified as such.** The files are byte-for-byte slices of the old script: concatenating them in tag order reproduced the original exactly (`md5` match) before anything else was touched. The full diff of the split, after everything, is a single hunk — `safeGet`/`safeSet` moved earlier — which is the one real bug the split exposed.

**The bug the split exposed.** `60-ui.js` restores the saved stage size at LOAD time and calls `safeGet`, which was declared in the last file. In one script that was invisible: function declarations hoist to the top of *their own script*. Across separate scripts they do not, so this became `ReferenceError: safeGet is not defined` — which killed the rest of that file and left the error banner covering the toolbar. The fix is the mitigation named in advance: declarations used at load time move ahead of their callers. A static scan now confirms no top-level reference in any file resolves to a later one, and a boot test (32) asserts the page loads with zero page errors, zero console errors, and every script served 200.

**And a bug the split found by accident.** Exercising trace mode in a full-session smoke run showed `#placeCanvas` sitting 238px right and 54px below the stage. `sizePlaceCanvas` assigned *viewport* coordinates from `getBoundingClientRect` to a canvas positioned absolutely inside `#placeOverlay` — which is itself absolutely positioned — so the trace surface was displaced by the overlay's own offset. Clicks near an edge fell off it entirely, and any shape that did get traced was built at the wrong stage coordinates. This was **pre-existing**, confirmed by running the same diagnostic against the pre-split file. The sticker test passed throughout because it only asserted a mask *existed*, which stayed true while the geometry was wrong; test 33 now checks the traced shape lands where it was clicked.

Two smaller lessons worth keeping. The old sticker test traced at 62%/48% of the place canvas and only missed the centred instruction box *because* the canvas was displaced — fixing the alignment moved that click onto the box, so the test had to move with it: a test tuned against broken geometry encodes the breakage. And `npm run smoke` exists because the per-feature tests each start from a clean page; bugs like the focus-swallowed shortcut only appear when features are used in sequence, in one long-lived session.

## 14 · Clearing the small stuff

Five loose ends from the audit, none urgent, all real.

- **`ImageDecoder` was never closed.** §12 closed the decoded `VideoFrame`s; the decoder holding the demuxer and its buffers stayed open for the life of every animated image. The reason it was left was honest uncertainty — does closing the decoder invalidate frames you already pulled out? That was settled with evidence rather than a spec reading: a hand-built 2-frame GIF (1×1, red then blue) decoded, both frames pixel-checked before `close()`, both re-checked after. Identical, no error. So the decoder closes right after the decode loop, and is nulled so the error path cannot double-close it.

- **`makeVideoThumb` could wait forever.** It resolved on `loadeddata`/`seeked` or `error` — a source that fires *neither* left the element and its blob URL alive for the whole session, and the item silently never got a preview frame. Now bounded at 20s. Deliberately a toast, not the error banner: the display owns real playback and may well handle the file fine, so this is a degraded preview, not a failure.

- **The trace overlay ignored `devicePixelRatio`.** Thin dashed line-work at CSS resolution, visibly soft on a HiDPI laptop. It now backs at DPR while keeping its CSS box (and therefore `placePts`, and the click→stage mapping) in CSS pixels. `drawPlaceCanvas` resets the transform before clearing, or the DPR scale would apply twice to the clear rect. It also survives a window resize mid-trace now: points are rescaled by the size change, which preserves what they point at because the canvas maps linearly onto the stage.

- **The display's 2D layers rendered at CSS pixels while GL rendered at DPR.** So on a HiDPI screen the outlines and calibration placeholders — the things whose entire job is to be aligned against something — were softer than the media beside them. All three canvases now size at DPR; `draw2D` and `drawOverlay` derive their scale from the canvas dimensions, so nothing else changed. On a 1:1 projector `dpr` is 1 and this is a no-op.

- **Transcoding in a background tab produced a frozen clip.** Frames reach the recorder via `requestAnimationFrame`, which a hidden tab stops — while `MediaRecorder` keeps recording. The result is a plausible-looking file frozen on one frame. rAF throttling is the browser's call and not ours to fix, but handing back a silently broken clip is: `transcodeVideo` now reports whether the tab was ever hidden, and the button refuses the result and says why, leaving the original untouched.

The GIF built for the decoder question stayed: `createAnimatedCanvas` had **no** automated coverage before — WebCodecs was manual-checklist only — and test 34 now drives decode, frame advance, and release, including that `_stop()` is idempotent.

## 15 · Third audit: when a fix makes an old bug worse

Re-reading after §14 turned up three bugs in the animated-image path, all in the same family, and the first was **caused** by the §14 fix.

- **Stopped animated canvases were reused from cache.** `buildEditorMedia` stops the outgoing animated canvas, and animated canvases are cached on the item (`item._animCanvas`) so re-selecting one does not re-decode. Those two facts already meant a GIF you clicked away from and back to came back frozen. §14 made it worse: now that `_stop()` closes the VideoFrames, the cached canvas is not merely paused but spent. `_stop()` therefore marks the canvas `_dead`, and the cache check skips dead ones and decodes again. Stopping is a *release*, so re-decoding on return is the coherent trade.

- **Late decodes were stranded.** `createAnimatedCanvas` starts its `requestAnimationFrame` loop *before* the promise resolves, so a result arriving after the user moved on was not merely unwanted — it was a self-running loop holding decoded frames for the life of the tab. It is now stopped instead of dropped. This existed before, but re-decoding on every switch-back made it reachable constantly instead of once per item.

- **And the fix for that was itself incomplete.** With it in place the orphan count fell from 5 to 3, not to 1: switching away and back faster than a decode completes starts a *second* decode for the same item, and both pass the staleness check on return, so the first canvas is overwritten while still advancing. One decode per item is now in flight at a time (`item._animPending`), plus a guard that never overwrites a live canvas without stopping it.

The display had the same shape in `addItemBlob`: `M` is captured before `await createAnimatedCanvas(...)`, so deleting the surface mid-decode stored the canvas into a map entry `clearMedia` had already dropped — stranding it. It now checks that `mediaMap.get(surfId)` is still the same object before storing.

Two testing lessons, both the same lesson:

- The first orphan test **passed against the unfixed code**. A 1×1 two-frame GIF decodes faster than the switching loop, so the race never opened. Holding the resolution back — modelling a real GIF's hundreds of frames — made it fail 5, then 3, then 1. This is the third time in this codebase that a concurrency test was meaningless until the slow side was actually made slow (see §12 on the double-send).
- The count going 5 → 3 rather than 5 → 1 is what exposed the second decode. A boolean assertion ("no orphans") would have been satisfied by neither number; asserting the *quantity* is what showed the fix was partial.

## 17 · Big captures: what actually went wrong

Reported symptom: an error reading *"Couldn't send media to the Display tab (The requested file could not be read, typically due to permission problems…)"* that was often untrue — reload the display and the clip played — and other times the clip really did stay a checkerboard. Reproduced and root-caused against the reporter's own 92MB–2.8GB game captures (`npm run test:media`, which drives the real two-tab flow with real files).

Three separate faults, each masquerading as the next.

**1 · The whole file was read into one ArrayBuffer.** `bcSendItem` called `file.arrayBuffer()` and handed the result to `postMessage`, which structured-clones it — two full in-memory copies per clip. A 2.8GB capture exceeds what a single ArrayBuffer can hold and the read simply fails; several clips at once put GBs of pressure on the heap so even smaller ones fail intermittently. Chrome's wording for a read it cannot satisfy is that "permission problems" string, which sent the diagnosis in entirely the wrong direction. Media now ships in 8MB chunks via `file.slice(a,b).arrayBuffer()`, which reads only that range, one clip at a time, with per-chunk retries. Peak memory is one chunk instead of the whole file.

**2 · The fix for that corrupted files on its own.** A 2.8GB clip takes ~7s to ship; the display's missing-item grace period was 2.5s. So the sweep declared the item missing *mid-transfer* and asked for it again, and the second transfer's chunks were appended to the first's buffer — a Blob 310MB LARGER than the file, which `<video>` rejects as `MEDIA_ERR_SRC_NOT_SUPPORTED`, i.e. a "codec" error for a codec that was never the problem. Every transfer now carries an id that chunks are matched against, the editor refuses to start a second transfer of an item already in flight, and an item mid-transfer no longer counts as missing. Verified byte-exact: 347 chunks, 2,904,396,676 bytes in, same out.

**3 · And underneath both, a hard browser ceiling.** Chrome keeps blob: bodies in a memory-backed store. Measured on this machine: 1GB reads back fine, 2GB fails with `net::ERR_BLOB_OUT_OF_MEMORY`. The ceiling is on the TOTAL the tab holds, not per clip — which is exactly why some surfaces play while others sit on a checkerboard, and why the same clip that fails in a set of six plays perfectly on its own. OPFS was evaluated as a way out (disk-backed, no blob ceiling) and rejected for now: `createWritable` stages through a swap copy, so a 2.8GB file needs 5.6GB against a 6GB quota and fails with `QuotaExceededError`. A sync access handle in a worker would avoid the doubling; that is a real option if this ever needs solving properly.

So the display now tracks the bytes it is holding and, when a clip fails past ~70% of budget, says *that* instead of guessing at codecs — because "re-encode it, it is probably HEVC" is a wasted hour when the actual answer is "you are asking one tab to hold 2.7GB". The editor warns at import for any single clip over 1.5GB, where ⤓ Downscale is one click away. Measured outcome on the reporter's files: five clips totalling 2.2GB all transfer and play; the sixth is honestly diagnosed rather than blamed on its codec.

**And the display stopped being silent.** It is a passive renderer, so every upstream problem looks identical from the wall: a checkerboard, or a frozen frame — which is also what "not set up yet" looks like. It now shows live transfer progress, and when a clip is missing or has stopped advancing it names the remedy (reload the tab; the editor repopulates automatically via the hello handshake). The HUD hides in fullscreen, so a problem that persists escalates to the banner, which does not.

One testing note worth keeping. The bundled Chromium has no HEVC; game captures frequently do. Testing there reports codec failures the user's real browser would never hit, so `real-media.js` launches the *installed* Chrome by default. This is NOTES §2's lesson — test browsers are not user browsers — arriving from a new direction.

## 18 · OPFS, revisited — and §17 was wrong to reject it

§17 rejected OPFS on the grounds that `createWritable` stages through a swap copy, so a 2.8GB file would need 5.6GB against a 6GB quota. **That was a hypothesis presented as a finding, and measuring it showed it was wrong.** Three numbers, all from `npm run test:storage`:

- **Write amplification is 1.0×, not 2×.** `createWritable` (default), `createWritable({mode:'exclusive'})` and a worker `createSyncAccessHandle` all cost exactly the bytes written. So there is no swap-copy problem, and **no worker is needed** — the simplest API is also the correct one. The `QuotaExceededError` that produced the doubling theory came from something else entirely (see below).
- **The 6GB quota was a test-harness artifact.** That figure came from a Playwright throwaway profile. A persistent Chrome profile on the same machine reports **10GB**.
- **The in-memory blob ceiling is ~4GB synthetically**, not the 1.5GB `BLOB_BUDGET` guessed in §17 — though real playback fails lower (~2.5GB observed), because decode buffers and GL textures compete for the same headroom. Synthetic ceilings overstate what a working renderer can use.

And the decisive one: a 2.77GB capture streamed into OPFS is **byte-exact and plays** — `loadeddata`, `currentTime` advancing.

So the display now streams anything above 64MB to an OPFS file and hands `<video>` a **disk-backed** `File`, which is not subject to the in-memory ceiling. Small items stay in memory, where a disk round-trip would only add latency. This is the same property the editor has always relied on without anyone noticing: a `File` straight from the picker is disk-backed, which is why the editor could thumbnail a 2.7GB clip it could never have held in RAM.

**Measured outcome, on the reporter's own captures: all nine clips — 7.0GB, nine concurrent video surfaces — transfer and play.** Previously the ceiling was around 2.5GB total, with the sixth clip of six failing.

Three things this cost, worth writing down because each was self-inflicted:

- **An async `begin()` silently ate the first chunks.** Chunks arrive from a `BroadcastChannel` handler that cannot await, so while the OPFS file was being opened every arriving chunk found no record and was dropped — and the clip simply never arrived, with no error anywhere. The record is now created **synchronously** and writes queue until the writable exists. A comment in the first draft asserted this was already handled; it was not. Asserting an invariant in a comment does not establish it.
- **Testing in incognito condemned a feature that works.** Playwright's `browser.newContext()` is incognito-style, and incognito gets a drastically smaller OPFS allowance than `navigator.storage.estimate()` advertises — the 2.7GB write died with `QuotaExceededError` there while succeeding in a normal window. This is almost certainly what produced §17's original rejection. `real-media.js` now uses `launchPersistentContext`. NOTES §2's rule keeps being right in new ways: **test browsers are not user browsers** — and neither are test *profiles*.
- **A quota failure used to lose the clip outright.** Now the item is marked disk-ineligible, the partial file released, and the existing missing-item sweep re-requests it; the retry goes to memory and either works or fails with an honest size message.

**On limits.** The original request was a fixed 5GB cap with 1GB held back, reasoned from the 6GB artifact. Since the real quota is machine-dependent, the budget is read from `navigator.storage.estimate()` at runtime with a 20% reserve — generous on a big disk, honest on a full one, and no magic constant to go stale. The clip limit is advisory only, per NOTES §4: the editor's meter counts **video surfaces** (one item plays per surface) and flags sources above 1080p, because *storage* is rarely the binding constraint now — **simultaneous decode is** (§9b), and ten 1080p streams can be fine where two 4K streams are not. Nothing is ever refused.

## 19 · Auditing §18 — four of the five bugs were §18's own

The OPFS change in §18 shipped with 40 green tests and five bugs. Four were introduced by that change. None were caught, because **no test opened a second display tab, and no test drove the disk path at all** — every test payload was a few KB, comfortably under the 64MB threshold that decides memory vs disk. The disk code had 100% of the risk and 0% of the coverage.

- **A second display tab wiped the first tab's media, mid-projection.** OPFS is per-ORIGIN, not per-tab, and the startup reclaim deleted every file it found. Two tabs also shared filenames, so they overwrote each other regardless. Each tab now stores under its own session id and reclaims only sessions that fail to answer a roll-call broadcast over the channel that already exists — a crashed session cannot answer, a live one always does, so crash-reclaim still works without a live tab ever deleting another's files.

- **Replacing an item deleted its own new backing file.** This one was subtle and only appeared once the multi-tab test drove real disk storage. On a re-transfer, `begin()` creates the new file and repoints the item's name to it; `addItemBlob` then disposes the *old* store entry, and disposal released **by itemId** — which by then pointed at the INCOMING file. The item destroyed its own backing store at the instant it was stored. Fixed by making the ownership explicit: a stored item carries its filename and disposal releases *that file*, never an id.

- **The memory ceiling stopped being able to warn.** One `_budget` was doing two incompatible jobs. Items under the threshold stay in memory whatever the disk situation, bounded by ~2.5GB, but were being checked against the disk budget (~8GB) — so a pile of small clips could blow the memory ceiling in total silence, which is precisely the failure this reporting exists to surface. Now `MEM_BUDGET` governs memory-backed items and `DISK_BUDGET` governs disk, at every site.

- **The display swallowed async failures.** `addItemBlob` was called without being returned, so the `.catch` beside it never saw its rejections — and unlike the editor, this page had no `unhandledrejection` or `window.onerror` handler at all. A failure there vanished completely, taking the retry-in-memory recovery with it. Both handlers added; the promise is returned.

- **The meter mixed units**, adding in-memory bytes to whole-origin disk usage. Both meters now report the two ceilings separately.

### Two lessons, both about tests rather than code

**A test that cannot reach the code proves nothing.** The first versions of the multi-tab and re-transfer tests *passed against the broken code*, because a few-KB payload never touches OPFS. They only became meaningful after a `__setSmall()` seam let them drive the disk path with byte-sized payloads. The alternative — writing 64MB per assertion — is why that code went untested in the first place, so the seam is the fix, not a smell.

**Reading a File back is not evidence the file exists.** Chrome keeps an unlinked OPFS file readable through a handle that is already open, so every "is the media still there?" assertion passed even while the entry was being deleted underneath. The tests had to ask the *filesystem* (`__listFiles()`), not the handle. Without that, the multi-tab bug would still be sitting there behind a green suite.

### One claim withdrawn

The audit rated the filename-reuse race HIGH, reasoning that a deferred cleanup keyed to a reused name would delete a live file. **I could not produce an observable failure from it** — between Chrome's unlink semantics and the ordering, every attempt came out benign. Per-transfer filenames were kept because they remove the ambiguity for free and made the *real* ownership bug above visible, but the severity was overstated and is recorded here as such rather than quietly left standing.

## 20 · Pre-release audit

One code bug, and a set of things that were fine locally but wrong to publish.

**`pagehide` deleted the media when the page was only being frozen.** The best-effort cleanup on tab close ran on every `pagehide` — but that event fires *both* on real teardown and when a page enters the back/forward cache, and a bfcached page comes **back** with all of its JavaScript state intact. Navigating away and back therefore restored a tab holding a `mediaMap` full of items whose files had been deleted underneath it, with nothing on screen to explain it. Guarded on `event.persisted`; test 45 covers both directions, because "does not delete on freeze" and "does delete on teardown" are separate claims and only one of them is about the bug.

**Personal paths were baked into two test scripts.** `real-media.js` and `storage-probe.js` defaulted to a specific user's `Videos/Captures` folder and, in one case, a named clip. That publishes a username, makes the scripts useless on any other machine, and quietly implies the suite needs files nobody else has. Both now take a directory explicitly (`MEDIA_DIR=…`) and explain themselves when it is missing; the storage probe's multi-GB step became optional, so steps 1–4 still report real numbers with no media at all.

**The lockfile was gitignored.** For a project whose only dependency is its test toolchain, that is backwards: `npm ci` needs it, and without it CI silently drifts to whatever Playwright published today. Now committed.

**`.gitattributes` exists for one reason.** `start.bat` must keep CRLF — cmd.exe is unreliable with LF-only batch files, particularly around `goto` labels, which is exactly the class of failure §11 was about. Worth noting the rule that nearly broke it here too: in `.gitattributes` the LAST matching line wins, so `* text=auto` after `*.bat eol=crlf` would have silently undone the exception.

CI runs `npm test` and `npm run smoke` only. Everything hardware-dependent — projector fullscreen, real codec playback, multi-GB storage, two display tabs — stays in `TESTING.md`, because a green CI run is not evidence about any of it (§2: automation flags change media behaviour).
