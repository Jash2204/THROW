# THROW

**Tiled Homographic Rendering Onto Walls** — a zero-install projection mapper that runs in your browser.

Warp images and looping videos onto walls, ceilings, boxes, or any awkward real-world surface. Edit on your laptop screen while the projector shows the result live — no accounts, no cloud, no install beyond Python.

---

## Quick start

1. Download the folder (or clone the repo).
2. Double-click **`start.bat`** — it starts a tiny local server and opens the editor.
3. Press **`A`** to add a surface, drag corners to warp it, drop media onto it.
4. Click **`⧉ Display`** (top of the left panel) — a second tab opens. Drag it onto the projector (display set to **Extend**), click **⛶ FULLSCREEN**.
5. Calibrate from the editor. Everything syncs live — the projected picture never shifts once you've aligned it.

Requires **Python** (for the 2-line local server) and a Chromium browser (Chrome/Edge). No other dependencies, no build step.

> Why a server? The editor and display are two tabs that talk over `BroadcastChannel`, which requires a shared origin — `localhost` provides it, `file://` cannot. You can still open `THROW.html` directly from disk to edit, but the Display tab needs `start.bat`.

---

## The two-tab workflow

```
┌────────────────┐   geometry (JSON) + media (bytes)   ┌────────────────┐
│  THROW.html    │ ──────── BroadcastChannel ────────► │  display.html  │
│  the EDITOR    │                                     │  the DISPLAY   │
│  laptop screen │ ◄─────── errors, status ─────────── │  projector,    │
│  thumbnails    │                                     │  fullscreen,   │
│  never plays   │                                     │  owns video    │
│  video         │                                     │  playback      │
└────────────────┘                                     └────────────────┘
```

- **The editor never plays video.** It shows a captured frame with a ▶ badge, so a wall of 4K clips costs nothing while you calibrate.
- **The display owns its media.** It receives the raw bytes, builds its own `<video>` elements, and renders the warp itself at full resolution via WebGL. Minimize the editor, cover it, switch away — the projection keeps playing.
- **Fullscreen first, then calibrate.** Edits sync live into the already-fullscreen display, so the mapping can never shift after you've aligned it (the classic "everything moved when I fullscreened" problem is gone by construction).

---

## Features

- **GPU-accelerated output.** The display renders with WebGL — one texture upload per video frame, one draw call per surface — delivering multiple simultaneous clips at 60 fps (measured: 3 × 4K on a laptop). Normal / Screen / Add / Multiply composite via `blendFunc`; Overlay / Hard Light / Color Dodge fall back to Canvas2D with a visible note. If playback stalls anyway, a watchdog detects the frozen `currentTime` and says plainly: *you're at the hardware decode limit; use 1080p sources* — your projector can't show more anyway.
- **Mesh warp, 2×2 → 8×8.** Corner-pin at 2×2; step up for curves. Drag yellow corner diamonds or cyan inner dots.
- **Whole-surface body drag** — click anywhere on a surface (not a handle) to move it rigidly. `H` hides handles entirely for a clean view (drags then always move whole surfaces).
- **Trace mode** — click around a ceiling panel or beam; THROW fits a warped surface to the outline automatically using a transfinite (Gordon–Coons) interior interpolation.
- **Broad format support.** Drop anything the browser might decode: mp4, webm, mov, m4v, ogg/ogv, and even mkv/avi/wmv/mpeg attempts; png, jpg, webp, gif, avif, bmp, svg and more. Animated GIF/WebP/AVIF/APNG play frame-accurately via WebCodecs.
- **Honest error messages.** Failures report the real `MediaError` with a fix tailored to the actual container — an `.mkv` says "convert the container", an HEVC "live wallpaper" `.mp4` says exactly that and points at HandBrake. Errors appear in **both** tabs, whichever one you're watching.
- **Layers** with per-surface blend modes (Screen/Add make black project as transparent) and opacity.
- **Per-surface image adjustments** — brightness, contrast, saturation, hue, and horizontal/vertical flip. The editor previews via CSS canvas filters; the display applies the same math in its WebGL shader. Adjustment sliders never re-warp — they're applied at composite time.
- **Outlines** (`O`) — project each surface's footprint to line up against real-world edges before the media is final.
- **Stage presets** — FHD/4K/QHD/HD/WXGA/XGA or custom, remembered across sessions. Match your projector's native resolution for 1:1 pixels in fullscreen.
- **Off-stage freedom** — surfaces can hang off or sit fully outside the stage (simply not projected). `C` rescues a lost surface.
- **Save / load** (Project panel) — projects export to `.throw.json` with embedded images (videos re-drop after loading). Imports are schema-validated; a malicious file can't inject anything.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `A` | Add a surface |
| `P` | Trace mode (click around a shape to fit) |
| `D` (or `L`) | Open the Display tab |
| `R` | Reset / flatten the selected mesh |
| `C` | Re-center the selected surface |
| `O` | Toggle outlines on the projected output |
| `H` | Toggle mesh handles in the editor |
| `Del` / `Backspace` | Delete selected surface |
| `Esc` | Deselect / cancel trace mode / close help |
| Drag a file onto the stage | Load media (auto-creates a surface on empty space) |
| Double-click a surface | Open the media picker |

**In the Display tab:** `F` or the button or double-click → fullscreen · `O` → outlines · `Esc` → exit fullscreen.

---

## Troubleshooting

**A video won't play.** THROW tells you why, precisely — read the banner (it appears in both tabs). Most "live wallpaper" clips are H.265/HEVC; re-encode to H.264 .mp4 with [HandBrake](https://handbrake.fr) (preset *Fast 1080p30*).

**The Display button says it needs the server.** You opened `THROW.html` straight from disk. That's fine for editing, but run `start.bat` for the two-tab projection flow.

**Videos look frozen in the editor.** By design — the editor shows a captured frame (note the ▶ badge). They play in the Display tab.

**A surface disappeared.** It's probably off-stage (allowed). Select it in Layers and press `C`.

**The picture moved when I fullscreened.** Fullscreen the display **before** calibrating, not after — that's the intended flow, and edits sync live either way.

**Playback stalls with a "hardware decode limit" warning.** The GPU can only decode a finite number of simultaneous streams. Switch to 1080p sources — the projector can't show more resolution anyway.

---

## Repo layout

```
start.bat         ← double-click me (serves app/ + opens the editor)
app/
├── THROW.html    ← editor tab
├── display.html  ← projector tab (opened by the ⧉ Display button)
└── shared.js     ← warp math + media helpers used by both
docs/
├── NOTES.md      ← engineering decisions log — why it is built this way
└── TESTING.md    ← manual test checklist
tests/            ← Playwright suite
```

The warp core: each surface is a grid of control points; media is texture-mapped across it with affine triangles (subdivided so bends stay smooth), rendered to an offscreen buffer and composited once per surface so blend modes never double-apply. The display warps on the GPU (WebGL, one texture upload per video per frame); sampling a `<video>` per-triangle stalls Chrome's decoder, and Blob handles stall it across tabs — both found the hard way; the full story is in [NOTES.md](docs/NOTES.md).

---

## Security

Local-only. The server serves this folder to your own machine; nothing phones home. Untrusted inputs (media files, imported `.throw.json`) are validated: JSON schema-checked with a blend-mode allowlist and `data:image/`-only media, names rendered as plain text, no `eval`/`new Function`/`innerHTML` with user data, blob URLs revoked on release.

---

## Running the tests

```bash
npm install
npx playwright install chromium
npm test
```

Automated tests cover interaction, state isolation, presets, thumbnails, JSON validation, and editor↔display sync. Hardware-dependent paths (projector fullscreen, real-codec playback) are in [TESTING.md](docs/TESTING.md) — test those in a normally-launched browser, not an automated one (automation flags change media behaviour; see NOTES §2).

---

## License

MIT — see [LICENSE](LICENSE). Use it, sell it, modify it, map it onto a ceiling.
