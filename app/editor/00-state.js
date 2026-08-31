// ══════════════════════════════════════════════════════════════════
//  THROW editor · 00 — canvas handles and the module-level state.
//  Loaded first: everything below reads `surfaces`, `selId` and the stage size.
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════
//  THROW v3 editor — mesh warp + ceiling place mode.
//  Rendering/geometry/media helpers live in shared.js (also used by
//  display.html). The Display tab is a separate renderer synced over
//  BroadcastChannel: it owns its own <video> elements, so playback
//  survives this window being occluded, minimized, or backgrounded.
// ══════════════════════════════════════════════

const SC = document.getElementById('surfaceCanvas');
const IC = document.getElementById('interactCanvas');
const ctx = SC.getContext('2d');
const ictx = IC.getContext('2d');
const stageEl = document.getElementById('stage');
const stageWrap = document.getElementById('stageWrap');

let stageW = 1920, stageH = 1080;
let surfaces = [];
let selId = null;
let dragHandle = null;  // {surfId, type:'ctrl'|'center', r, c}
let dragOffset = {x:0,y:0};
let outputShowOutlines = false;  // calibration guides on the PROJECTED output.
                                 // Off by default: the grid, corner dots and centre
                                 // crosshair are alignment aids, and projecting them
                                 // over finished media is clutter. Press O (or the
                                 // ⛶ Outlines button) when lining a surface up.
let handlesVisible = true;       // editor mesh handles (H) — hidden, drags move whole surfaces

const IS_FILE = location.protocol === 'file:';

