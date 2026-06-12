// cpicker.js — Layout Picker for the Path / Stations / Groups / Call model.
//
//   PATH    — draw geometric corners + edges (straight/arc) the AGV travels.
//   STATION — drop action sites and home slots; each auto-links to a corner.
//   GROUP   — compose reusable multi-stop jobs (home → stops → home is implicit).
//   CALL    — mark a station as an on-canvas call button bound to a group.
//
// Saves the schema consumed by normaliseLayout() (shared.js) + the player.

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

const CORNER_HIT  = 14;
const STATION_HIT = 16;
const DOT_R       = 6;
const HOME_ACTION_LABELS = {
  none: 'nothing',
  'attach-empty': 'attach empty',
  'attach-full': 'attach full',
  'detach-empty': 'detach empty',
  'detach-full': 'detach full',
};

// ── State ───────────────────────────────────────────────────────────────────

const state = {
  path:     { nodes: {}, edges: [] },     // nodes: {id:{x,y}}  edges: [{id,from,to,type,radius,clockwise}]
  stations: {},                           // id -> {x,y,role:'action'|'home',link}
  agvs:     [{ id: 'AGV-01', color: AGV_COLORS[0] }],
  groups:   {},                           // id -> {name, stops:[{station,action,dwell?}], homeStart, homeEnd}
  activeGroup:  null,
  calls:    [],                           // [{x,y,group}] — free-floating call buttons
  sim: { agvSpeed: 120, serviceTime: 3, requests: [],
         autoGenerate: { enabled: false, meanInterval: 6, seed: 1234 } },

  mode: 'PATH',                           // PATH | STATION | GROUP | CALL
  view: { offsetX: 0, offsetY: 0, zoom: 1 },
  bgImage: null, imgW: 0, imgH: 0,
  outputFilename: 'coords.json',
  mouse: { sx: 0, sy: 0 },
  isPanning: false, panStart: { sx: 0, sy: 0 }, panViewStart: { offsetX: 0, offsetY: 0 },

  // PATH editing
  pathSel: null, pathArc: false, pathR: 120, pathCW: true, pathPtN: 1, edgeN: 1,
  pathHistory: [],   // LIFO of {node?,edge?,prevSel} so right-click undoes a whole placement
  // STATION editing
  placeRole: 'action', stationN: 1, homeN: 1,
  // GROUP editing
  groupEditMode: 'add',
  // counters
  groupN: 0,
};

// ── Element refs ─────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const modeBadge   = $('modeBadge');
const pathBar     = $('pathBar'),    stationBar = $('stationBar');
const groupBar    = $('groupBar'),   callBar    = $('callBar');
const groupsPanel = $('groupsPanel'), groupsBody = $('groupsBody');
const simBody     = $('simBody');
const actionPicker = $('actionPicker'), groupPicker = $('groupPicker'), groupPickerBody = $('groupPickerBody');
const hudCoords = $('hudCoords'), hudZoom = $('hudZoom'), hudCounts = $('hudCounts'), hudFile = $('hudFile');
const startupModal = $('startupModal'), confirmClearModal = $('confirmClearModal');
const filenameInput = $('filenameInput'), loadJsonInput = $('loadJsonInput'), loadImgInput = $('loadImgInput');

// transient pick context
let pickTarget = null;   // action picker: {kind:'stop',node}
let pendingCall = null;  // group picker (CALL mode): { x, y } of the new call marker

// ── Canvas sizing ─────────────────────────────────────────────────────────────

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(window.innerWidth  * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width  = window.innerWidth  + 'px';
  canvas.style.height = window.innerHeight + 'px';
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── Startup / load / clear ─────────────────────────────────────────────────────

startupModal.showModal();

$('startBtn').addEventListener('click', () => {
  const name = filenameInput.value.trim();
  if (name) { state.outputFilename = name; }
  startupModal.close();
  refreshAll();
  requestAnimationFrame(drawLoop);
});

loadJsonInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try { loadIntoState(JSON.parse(ev.target.result)); refreshAll(); }
    catch (err) { console.warn(err); alert('Invalid JSON.'); }
  };
  reader.readAsText(file);
});

loadImgInput.addEventListener('change', (e) => { if (e.target.files[0]) loadImage(e.target.files[0]); });

function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.bgImage = img; state.imgW = img.naturalWidth; state.imgH = img.naturalHeight;
    const z = Math.min(window.innerWidth / state.imgW, window.innerHeight / state.imgH) * 0.9;
    state.view.zoom = z;
    state.view.offsetX = window.innerWidth / 2 - state.imgW * z / 2;
    state.view.offsetY = window.innerHeight / 2 - state.imgH * z / 2;
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

$('clearBtn').addEventListener('click', () => confirmClearModal.showModal());
$('confirmClearCancel').addEventListener('click', () => confirmClearModal.close());
$('confirmClearOk').addEventListener('click', () => {
  confirmClearModal.close();
  state.path = { nodes: {}, edges: [] };
  state.stations = {}; state.calls = []; state.groups = {}; state.activeGroup = null;
  state.agvs = [{ id: 'AGV-01', color: AGV_COLORS[0] }];
  state.sim = { agvSpeed: 120, serviceTime: 3, requests: [],
                autoGenerate: { enabled: false, meanInterval: 6, seed: 1234 } };
  state.bgImage = null; state.imgW = 0; state.imgH = 0;
  state.pathSel = null; state.pathHistory = []; state.pathPtN = 1; state.edgeN = 1; state.stationN = 1; state.homeN = 1; state.groupN = 0;
  state.mode = 'PATH';
  loadJsonInput.value = ''; loadImgInput.value = '';
  filenameInput.value = 'coords.json'; state.outputFilename = 'coords.json';
  hudFile.textContent = '→ coords.json';
  refreshAll();
  startupModal.showModal();
});

function loadIntoState(data) {
  state.path = {
    nodes: (data.PATH && data.PATH.nodes) || {},
    edges: ((data.PATH && data.PATH.edges) || []).map(e => ({
      id: e.id || nextEdgeId(), from: e.from, to: e.to,
      type: e.type === 'arc' ? 'arc' : 'straight', radius: e.radius ?? 120, clockwise: e.clockwise !== false,
    })),
  };
  state.stations = {};
  for (const [id, s] of Object.entries(data.STATIONS || {}))
    state.stations[id] = { x: s.x, y: s.y, role: s.role === 'home' ? 'home' : 'action' };
  state.agvs = (data.AGVS || []).map((a, i) => ({ id: a.id || `AGV-0${i + 1}`, color: a.color || AGV_COLORS[i % AGV_COLORS.length] }));
  if (state.agvs.length === 0) state.agvs = [{ id: 'AGV-01', color: AGV_COLORS[0] }];
  const mapAct = a => (['move', 'none', 'empty', 'full'].includes(a) ? a : 'move');
  const mapHome = a => HOME_ACTIONS.includes(a) ? a : 'none';
  state.groups = {};
  for (const [id, g] of Object.entries(data.GROUPS || {}))
    state.groups[id] = { name: g.name || id, homeStart: mapHome(g.homeStart), homeEnd: mapHome(g.homeEnd),
      stops: (g.stops || []).map(st => {
        const o = { node: st.node, action: mapAct(st.action) };
        if (st.dwell !== undefined) o.dwell = st.dwell;
        return o;
      }) };
  state.calls = (data.CALLS || []).filter(c => c && typeof c.x === 'number').map(c => ({ x: c.x, y: c.y, group: c.group }));
  (data.CALL_STATIONS || []).forEach(c => {   // legacy: anchor to the station's position
    const s = (data.STATIONS || {})[c.station];
    if (s) state.calls.push({ x: s.x, y: s.y, group: c.group });
  });
  const sim = data.SIM || {};
  const ag = sim.autoGenerate || {};
  state.sim = {
    agvSpeed: sim.agvSpeed || 120, serviceTime: sim.serviceTime ?? 3,
    requests: (sim.requests || []).map(r => ({ t: +r.t || 0, group: r.group, agv: r.agv || null })),
    autoGenerate: { enabled: !!ag.enabled, meanInterval: ag.meanInterval || 6, seed: ag.seed ?? 1234 },
  };
  state.activeGroup = Object.keys(state.groups)[0] || null;
  state.pathSel = null; state.pathHistory = [];   // loaded geometry has no undo history
  syncCounters();
}

function syncCounters() {
  const num = (id, pre) => { const n = parseInt(String(id).replace(pre, ''), 10); return isNaN(n) ? 0 : n; };
  state.pathPtN = Math.max(0, ...Object.keys(state.path.nodes).map(id => num(id, 'P-'))) + 1;
  state.edgeN   = Math.max(0, ...state.path.edges.map(e => num(e.id, 'E-'))) + 1;
  const stIds = Object.keys(state.stations);
  state.stationN = Math.max(0, ...stIds.filter(i => i.startsWith('ST-')).map(i => num(i, 'ST-'))) + 1;
  state.homeN    = Math.max(0, ...stIds.filter(i => i.startsWith('HS-')).map(i => num(i, 'HS-'))) + 1;
  state.groupN   = Object.keys(state.groups).length;
}

// ── Coordinate transforms / hit tests ──────────────────────────────────────────

function toImg(sx, sy) { return screenToImg(sx, sy, state.view); }
// A group node may be a path corner or a station.
function nodePosC(id) { return state.path.nodes[id] || state.stations[id] || null; }
function hitCorner(sx, sy) {
  for (const [id, p] of Object.entries(state.path.nodes)) {
    const s = imgToScreen(p.x, p.y, state.view);
    if (Math.hypot(sx - s.sx, sy - s.sy) <= CORNER_HIT) return id;
  }
  return null;
}
function hitStation(sx, sy) {
  for (const [id, p] of Object.entries(state.stations)) {
    const s = imgToScreen(p.x, p.y, state.view);
    if (Math.hypot(sx - s.sx, sy - s.sy) <= STATION_HIT) return id;
  }
  return null;
}

// ── Naming ──────────────────────────────────────────────────────────────────

function nextCornerId() { let n = state.pathPtN; while (state.path.nodes[`P-${n}`]) n++; state.pathPtN = n + 1; return `P-${n}`; }
function nextEdgeId()   { let n = state.edgeN;   state.edgeN = n + 1; return `E-${n}`; }
function nextStationId(role) {
  if (role === 'home') { let n = state.homeN; while (state.stations[`HS-${n}`]) n++; state.homeN = n + 1; return `HS-${n}`; }
  let n = state.stationN; while (state.stations[`ST-${n}`]) n++; state.stationN = n + 1; return `ST-${n}`;
}
function nextGroupId() {
  let i = state.groupN;
  let id; do { id = 'G-' + String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ''); i++; } while (state.groups[id]);
  state.groupN = i;
  return id;
}

// ── Mode switching ────────────────────────────────────────────────────────────

function setMode(m) {
  state.mode = m;
  state.pathSel = null;
  hideActionPicker(); hideGroupPicker();
  modeBadge.textContent = m + ' MODE';
  modeBadge.className = { PATH: 'track-mode', STATION: 'node-mode', GROUP: 'seq-mode', CALL: 'node-mode' }[m] || 'node-mode';
  pathBar.style.display    = m === 'PATH'    ? 'flex'  : 'none';
  stationBar.style.display = m === 'STATION' ? 'flex'  : 'none';
  groupBar.style.display   = m === 'GROUP'   ? 'flex'  : 'none';
  callBar.style.display    = m === 'CALL'    ? 'flex'  : 'none';
  groupsPanel.style.display = m === 'GROUP'  ? 'block' : 'none';
  if (m !== 'GROUP') state.groupEditMode = 'add';
  updateGroupBar();
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === '1') setMode('PATH');
  else if (e.key === '2') setMode('STATION');
  else if (e.key === '3') setMode('GROUP');
  else if (e.key === '4') setMode('CALL');
  else if ((e.key === 'a' || e.key === 'A') && state.mode === 'PATH') { state.pathArc = !state.pathArc; updatePathBar(); }
  else if (e.key === 's' || e.key === 'S') saveJSON();
  else if (e.key === 'Escape') { state.pathSel = null; hideActionPicker(); hideGroupPicker(); }
});

// ── Mouse: pan / zoom / click ──────────────────────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    e.preventDefault();
    state.isPanning = true;
    state.panStart = { sx: e.clientX, sy: e.clientY };
    state.panViewStart = { offsetX: state.view.offsetX, offsetY: state.view.offsetY };
  }
});
canvas.addEventListener('mouseup', (e) => { if (e.button === 1) state.isPanning = false; });
canvas.addEventListener('mousemove', (e) => {
  state.mouse.sx = e.clientX; state.mouse.sy = e.clientY;
  if (state.isPanning) {
    state.view.offsetX = state.panViewStart.offsetX + (e.clientX - state.panStart.sx);
    state.view.offsetY = state.panViewStart.offsetY + (e.clientY - state.panStart.sy);
  }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP;
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.view.zoom * factor));
  const { ix, iy } = toImg(e.clientX, e.clientY);
  state.view.zoom = z;
  state.view.offsetX = e.clientX - ix * z;
  state.view.offsetY = e.clientY - iy * z;
}, { passive: false });

canvas.addEventListener('click', (e) => {
  if (e.target !== canvas) return;
  const sx = e.clientX, sy = e.clientY;
  if (state.mode === 'PATH')    onClickPath(sx, sy);
  else if (state.mode === 'STATION') onClickStation(sx, sy);
  else if (state.mode === 'GROUP')   onClickGroup(sx, sy);
  else if (state.mode === 'CALL')    onClickCall(sx, sy);
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (state.mode === 'PATH')    undoPath();
  else if (state.mode === 'STATION') undoStation();
  else if (state.mode === 'GROUP')   undoGroupStop();
  else if (state.mode === 'CALL')    removeCallAt(e.clientX, e.clientY);
});

// ── PATH mode ──────────────────────────────────────────────────────────────────

function onClickPath(sx, sy) {
  const hit = hitCorner(sx, sy);
  if (hit) {
    // Clicking an existing corner: connect from the selected one, else just select.
    if (state.pathSel && state.pathSel !== hit) {
      const e = connectCorners(state.pathSel, hit);
      if (e) state.pathHistory.push({ edge: e, prevSel: state.pathSel });
      state.pathSel = hit;
    } else {
      state.pathSel = hit;   // pure selection — not an undoable geometry change
    }
    return;
  }
  // Placing a new corner is ONE action: the node + (if chaining) its edge.
  const prevSel = state.pathSel;
  const { ix, iy } = toImg(sx, sy);
  const id = nextCornerId();
  state.path.nodes[id] = { x: Math.round(ix), y: Math.round(iy) };
  const e = prevSel ? connectCorners(prevSel, id) : null;
  state.pathHistory.push({ node: id, edge: e, prevSel });
  state.pathSel = id;
  updatePathBar();
}
function connectCorners(a, b) {
  if (a === b) return null;
  if (state.path.edges.some(s => (s.from === a && s.to === b) || (s.from === b && s.to === a))) return null;
  const edge = { id: nextEdgeId(), from: a, to: b, type: state.pathArc ? 'arc' : 'straight' };
  if (state.pathArc) { edge.radius = state.pathR; edge.clockwise = state.pathCW; }
  state.path.edges.push(edge);
  updatePathBar();
  return edge.id;
}
// One right-click reverses the last placement: removes the node AND its edge
// together (no orphan corners), and restores the previous selection so you can
// keep chaining. Use Esc to merely deselect.
function undoPath() {
  const h = state.pathHistory.pop();
  if (!h) { state.pathSel = null; return; }
  if (h.edge) { const i = state.path.edges.findIndex(e => e.id === h.edge); if (i >= 0) state.path.edges.splice(i, 1); }
  if (h.node) delete state.path.nodes[h.node];
  state.pathSel = (h.prevSel && state.path.nodes[h.prevSel]) ? h.prevSel : null;
  updatePathBar();
}
function updatePathBar() {
  $('pathStraightBtn').classList.toggle('active', !state.pathArc);
  $('pathArcBtn').classList.toggle('active', state.pathArc);
  $('pathArcControls').style.display = state.pathArc ? 'flex' : 'none';
  $('pathRadiusInput').value = state.pathR;
  $('pathCwBtn').classList.toggle('active', state.pathCW);
  $('pathCcwBtn').classList.toggle('active', !state.pathCW);
  $('pathInfo').textContent = `${Object.keys(state.path.nodes).length} corners · ${state.path.edges.length} edges`;
  updateHud();
}
$('pathStraightBtn').addEventListener('click', () => { state.pathArc = false; updatePathBar(); });
$('pathArcBtn').addEventListener('click', () => { state.pathArc = true; updatePathBar(); });
$('pathCwBtn').addEventListener('click', () => { state.pathCW = true; updateLastArc(); updatePathBar(); });
$('pathCcwBtn').addEventListener('click', () => { state.pathCW = false; updateLastArc(); updatePathBar(); });
$('pathRadiusInput').addEventListener('keydown', e => e.stopPropagation());
$('pathRadiusInput').addEventListener('change', () => {
  const v = parseFloat($('pathRadiusInput').value); if (!isFinite(v) || v < 10) return;
  state.pathR = v; updateLastArc();
});
function updateLastArc() {
  for (let i = state.path.edges.length - 1; i >= 0; i--) {
    if (state.path.edges[i].type === 'arc') { state.path.edges[i].radius = state.pathR; state.path.edges[i].clockwise = state.pathCW; return; }
  }
}

// ── STATION mode ───────────────────────────────────────────────────────────────

$('stActionBtn').addEventListener('click', () => { state.placeRole = 'action'; updateStationBar(); });
$('stHomeBtn').addEventListener('click', () => { state.placeRole = 'home'; updateStationBar(); });
function updateStationBar() {
  $('stActionBtn').classList.toggle('active', state.placeRole === 'action');
  $('stHomeBtn').classList.toggle('active', state.placeRole === 'home');
}
function onClickStation(sx, sy) {
  const { ix, iy } = toImg(sx, sy);
  const id = nextStationId(state.placeRole);
  state.stations[id] = { x: Math.round(ix), y: Math.round(iy), role: state.placeRole };
  updateHud();
}
function undoStation() {
  const ids = Object.keys(state.stations);
  if (!ids.length) return;
  const last = ids[ids.length - 1];
  delete state.stations[last];
  // cascade: drop references
  for (const g of Object.values(state.groups)) g.stops = g.stops.filter(s => s.node !== last);
  updateHud(); updateGroupsPanel();
}

// ── GROUP mode ─────────────────────────────────────────────────────────────────

function newGroup() { const id = nextGroupId(); state.groups[id] = { name: id, stops: [], homeStart: 'none', homeEnd: 'none' }; return id; }
$('newGroupBtn').addEventListener('click', () => {
  state.activeGroup = newGroup();
  updateGroupsPanel(); updateGroupBar();
});
function ensureActiveGroup() {
  if (!state.activeGroup) { state.activeGroup = newGroup(); updateGroupsPanel(); }
}
function onClickGroup(sx, sy) {
  ensureActiveGroup();
  const st = hitStation(sx, sy);
  if (st) {
    if (state.stations[st].role === 'home') return;
    if (state.groupEditMode === 'delete') {
      removeGroupStopByNode(st);
      return;
    }
    // Action station → ask the load. Home stations are excluded from groups.
    pickTarget = { kind: 'stop', node: st };
    showActionPicker(sx, sy);
    return;
  }
  if (state.groupEditMode === 'delete') return;
  // Path corner → append as a pass-through (move), no prompt.
  const c = hitCorner(sx, sy);
  if (c) {
    state.groups[state.activeGroup].stops.push({ node: c, action: 'move' });
    updateGroupsPanel();
  }
}
function removeGroupStopByNode(nodeId) {
  const g = state.groups[state.activeGroup];
  if (!g) return;
  for (let i = g.stops.length - 1; i >= 0; i--) {
    if (g.stops[i].node === nodeId && state.stations[nodeId]?.role === 'action') {
      g.stops.splice(i, 1);
      updateGroupsPanel();
      return;
    }
  }
}
function undoGroupStop() {
  const g = state.groups[state.activeGroup];
  if (g && g.stops.length) { g.stops.pop(); updateGroupsPanel(); }
}
function updateGroupBar() {
  $('groupAddBtn').classList.toggle('active', state.groupEditMode === 'add');
  $('groupDeleteBtn').classList.toggle('active', state.groupEditMode === 'delete');
  $('groupBarLabel').textContent = state.activeGroup
    ? `Active group: ${state.groups[state.activeGroup].name || state.activeGroup}  (${state.groups[state.activeGroup].stops.length} stops)`
    : 'No active group — click "+ New group"';
}
$('groupAddBtn').addEventListener('click', () => { state.groupEditMode = 'add'; updateGroupBar(); });
$('groupDeleteBtn').addEventListener('click', () => { state.groupEditMode = 'delete'; hideActionPicker(); updateGroupBar(); });
// Inline-rename a group: swap its name label for a text input. Renames the
// display name only — the group ID (G-A …) stays, so CALLS / requests are safe.
function startRenameGroup(id, g, nameEl) {
  let finished = false;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = g.name || id;
  input.placeholder = id;
  input.style.cssText = 'width:120px;font-family:monospace;font-size:12px;padding:1px 4px;border:1px solid #c0a000;border-radius:4px;background:#fff;color:#1a1a2a;';
  const commit = () => { if (finished) return; finished = true; const v = input.value.trim(); g.name = v || id; updateGroupsPanel(); };
  const cancel = () => { if (finished) return; finished = true; updateGroupsPanel(); };
  input.addEventListener('click', ev => ev.stopPropagation());
  input.addEventListener('dblclick', ev => ev.stopPropagation());
  input.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
    if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

function updateGroupsPanel() {
  groupsBody.innerHTML = '';
  for (const [id, g] of Object.entries(state.groups)) {
    const row = document.createElement('div');
    row.className = 'agv-entry' + (id === state.activeGroup ? ' active' : '');

    const info = document.createElement('span');
    info.style.cssText = 'flex:1;display:flex;flex-direction:column;';
    const nameEl = document.createElement('span');
    nameEl.textContent = g.name || id;
    nameEl.title = 'Double-click to rename';
    nameEl.style.cursor = 'text';
    // Stop 'click' from bubbling to the row — otherwise each click of a
    // double-click triggers updateGroupsPanel() (via the row's select
    // handler), rebuilding the DOM mid-gesture so the native 'dblclick'
    // never lands on a live element.
    nameEl.addEventListener('click', (ev) => ev.stopPropagation());
    nameEl.addEventListener('dblclick', (ev) => { ev.stopPropagation(); startRenameGroup(id, g, nameEl); });
    const idEl = document.createElement('span');
    idEl.style.cssText = 'color:#888;font-size:10px;';
    idEl.textContent = id;
    info.appendChild(nameEl); info.appendChild(idEl);
    row.appendChild(info);

    const count = document.createElement('span');
    count.style.color = '#888';
    count.textContent = g.stops.length;
    row.appendChild(count);

    const del = document.createElement('span');
    del.textContent = ' ✕'; del.style.cssText = 'cursor:pointer;color:#c33;margin-left:6px;';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      delete state.groups[id];
      state.calls = state.calls.filter(c => c.group !== id);
      if (state.activeGroup === id) state.activeGroup = Object.keys(state.groups)[0] || null;
      updateGroupsPanel(); updateGroupBar();
    });
    row.appendChild(del);
    row.addEventListener('click', () => { state.activeGroup = id; updateGroupsPanel(); updateGroupBar(); });
    groupsBody.appendChild(row);

    if (id === state.activeGroup) {
      const homeRow = (label, key) => {
        const hr = document.createElement('div');
        hr.style.cssText = 'padding:2px 10px 2px 18px;font-size:11px;display:flex;gap:6px;align-items:center;color:#2c6fbf;';
        const span = document.createElement('span');
        span.style.flex = '1';
        span.textContent = label;
        const select = document.createElement('select');
        select.style.cssText = 'font-family:monospace;font-size:11px;padding:2px 4px;border:1px solid #c0c0cc;border-radius:4px;background:#fff;color:#1a1a2a;';
        HOME_ACTIONS.forEach(action => {
          const opt = document.createElement('option');
          opt.value = action;
          opt.textContent = HOME_ACTION_LABELS[action];
          select.appendChild(opt);
        });
        select.value = g[key] || 'none';
        select.addEventListener('click', ev => ev.stopPropagation());
        select.addEventListener('change', ev => {
          g[key] = ev.target.value;
          updateGroupsPanel();
        });
        hr.appendChild(span);
        hr.appendChild(select);
        groupsBody.appendChild(hr);
      };
      homeRow('home-start', 'homeStart');
      g.stops.forEach((s, i) => {
        const sr = document.createElement('div');
        sr.style.cssText = 'padding:2px 10px 2px 18px;font-size:11px;display:flex;gap:6px;';
        const isStation = !!state.stations[s.node];
        sr.innerHTML = `<span style="color:#888;">${i + 1}.</span><span style="flex:1;">${s.node}</span><span style="color:${isStation ? '#1a6828' : '#888'};">${isStation ? s.action : '·'}</span>`;
        groupsBody.appendChild(sr);
      });
      homeRow('home-end', 'homeEnd');
    }
  }
  updateGroupBar(); updateHud();
}

// ── CALL mode ──────────────────────────────────────────────────────────────────

function onClickCall(sx, sy) {
  if (Object.keys(state.groups).length === 0) { alert('Create a group first (Group mode).'); return; }
  const { ix, iy } = toImg(sx, sy);
  pendingCall = { x: Math.round(ix), y: Math.round(iy) };   // place anywhere
  showGroupPicker(sx, sy);
}
function removeCallAt(sx, sy) {
  // remove the nearest call marker within hit radius
  let best = -1, bd = STATION_HIT;
  state.calls.forEach((c, i) => {
    const s = imgToScreen(c.x, c.y, state.view);
    const d = Math.hypot(sx - s.sx, sy - s.sy);
    if (d < bd) { bd = d; best = i; }
  });
  if (best >= 0) { state.calls.splice(best, 1); updateHud(); }
}

// ── Pickers (action + group) ───────────────────────────────────────────────────

actionPicker.querySelectorAll('button[data-action]').forEach(btn => {
  btn.addEventListener('click', () => {
    const g = state.groups[state.activeGroup];
    const act = btn.dataset.action;   // none | empty | full
    if (g && pickTarget) {
      if (pickTarget.kind === 'stop') g.stops.push({ node: pickTarget.node, action: act });
      updateGroupsPanel();
    }
    pickTarget = null;
    hideActionPicker();
  });
});
function showActionPicker(sx, sy) {
  actionPicker.style.left = `${Math.min(sx, window.innerWidth - 220)}px`;
  actionPicker.style.top  = `${Math.min(sy, window.innerHeight - 200)}px`;
  actionPicker.style.display = 'block';
}
function hideActionPicker() { actionPicker.style.display = 'none'; }

function groupActionSummary(group) {
  const items = group.stops
    .filter(s => state.stations[s.node]?.role === 'action')
    .map(s => `${s.node} (${s.action})`);
  return items.length ? items.join('  ·  ') : 'no action nodes';
}

function showGroupPicker(sx, sy) {
  groupPickerBody.innerHTML = '';
  Object.keys(state.groups).forEach(id => {
    const b = document.createElement('button');
    const group = state.groups[id];
    const count = group.stops.filter(s => state.stations[s.node]?.role === 'action').length;
    b.innerHTML = `
      <div class="group-pick-card">
        <div class="group-pick-head">
          <span class="group-pick-id">${group.name || id}</span>
          <span class="group-pick-count">${id}</span>
          <span class="group-pick-count">${count} action ${count === 1 ? 'node' : 'nodes'}</span>
        </div>
        <div class="group-pick-summary">${groupActionSummary(group)}</div>
      </div>
    `;
    b.addEventListener('click', () => {
      if (pendingCall) state.calls.push({ x: pendingCall.x, y: pendingCall.y, group: id });
      pendingCall = null;
      hideGroupPicker(); updateHud();
    });
    groupPickerBody.appendChild(b);
  });
  groupPicker.style.display = 'block';
}
function hideGroupPicker() { groupPicker.style.display = 'none'; }

// ── Fleet / Sim panel ──────────────────────────────────────────────────────────

function updateSimPanel() {
  simBody.innerHTML = '';
  const row = (label, el) => { const d = document.createElement('div'); d.className = 'dispatch-row';
    const l = document.createElement('span'); l.className = 'dispatch-name'; l.textContent = label; d.appendChild(l); d.appendChild(el); simBody.appendChild(d); return d; };
  const numInput = (val, on, w = 60) => { const i = document.createElement('input'); i.type = 'number'; i.value = val; i.style.width = w + 'px'; i.className = 'dispatch-st';
    i.addEventListener('keydown', e => e.stopPropagation()); i.addEventListener('change', () => on(i.value)); return i; };

  row('AGVs', numInput(state.agvs.length, v => {
    const n = Math.max(1, Math.min(8, parseInt(v, 10) || 1));
    const arr = []; for (let i = 0; i < n; i++) arr.push(state.agvs[i] || { id: `AGV-0${i + 1}`, color: AGV_COLORS[i % AGV_COLORS.length] });
    state.agvs = arr; updateHud();
  }));
  row('Service (s)', numInput(state.sim.serviceTime, v => { state.sim.serviceTime = Math.max(0, parseFloat(v) || 0); }));
  row('AGV px/s', numInput(state.sim.agvSpeed, v => { state.sim.agvSpeed = Math.max(1, parseFloat(v) || 120); }));

  const agRow = document.createElement('label'); agRow.className = 'dispatch-enable';
  const agc = document.createElement('input'); agc.type = 'checkbox'; agc.checked = state.sim.autoGenerate.enabled;
  agc.addEventListener('change', () => { state.sim.autoGenerate.enabled = agc.checked; });
  agRow.appendChild(agc); agRow.appendChild(document.createTextNode(' Auto-generate')); simBody.appendChild(agRow);
  row('interval/seed', (() => { const wrap = document.createElement('span'); wrap.style.display = 'flex'; wrap.style.gap = '4px';
    wrap.appendChild(numInput(state.sim.autoGenerate.meanInterval, v => state.sim.autoGenerate.meanInterval = parseFloat(v) || 6, 44));
    wrap.appendChild(numInput(state.sim.autoGenerate.seed, v => state.sim.autoGenerate.seed = parseInt(v, 10) || 0, 56)); return wrap; })());

  const lbl = document.createElement('div'); lbl.className = 'dispatch-sub'; lbl.textContent = 'Requests (t  GROUP  [AGV])'; simBody.appendChild(lbl);
  const ta = document.createElement('textarea'); ta.className = 'dispatch-ta'; ta.rows = 3;
  ta.value = state.sim.requests.map(r => `${r.t} ${r.group}${r.agv ? ' ' + r.agv : ''}`).join('\n');
  ta.placeholder = '1 G-A\n2 G-B AGV-01';
  ta.addEventListener('keydown', e => e.stopPropagation());
  ta.addEventListener('change', () => {
    state.sim.requests = ta.value.split('\n').map(s => s.trim()).filter(Boolean).map(s => {
      const p = s.split(/[\s,]+/); return { t: parseFloat(p[0]) || 0, group: p[1], agv: p[2] || null };
    }).filter(r => r.group);
  });
  simBody.appendChild(ta);
}

// ── HUD ────────────────────────────────────────────────────────────────────────

function updateHud() {
  hudCounts.textContent = `path: ${Object.keys(state.path.nodes).length} · stations: ${Object.keys(state.stations).length} · groups: ${Object.keys(state.groups).length} · calls: ${state.calls.length}`;
}
function refreshAll() {
  setMode(state.mode);
  updatePathBar(); updateStationBar(); updateGroupsPanel(); updateSimPanel();
  hudFile.textContent = `→ ${state.outputFilename}`;
  updateHud();
}

// ── Save ──────────────────────────────────────────────────────────────────────

function buildSaveData() {
  const homeSlots = Object.keys(state.stations).filter(id => state.stations[id].role === 'home');
  return {
    PATH: { nodes: state.path.nodes, edges: state.path.edges },
    STATIONS: state.stations,
    AGVS: state.agvs,
    GROUPS: state.groups,
    CALLS: state.calls,
    HOME: { slots: homeSlots },
    SIM: state.sim,
  };
}
window.buildSaveData = buildSaveData;
window.loadIntoState = loadIntoState;

function saveJSON() {
  const data = buildSaveData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.outputFilename;
  a.click();
  URL.revokeObjectURL(a.href);
}
window.saveJSON = saveJSON;
$('saveBtn').addEventListener('click', saveJSON);

// ── Draw loop ──────────────────────────────────────────────────────────────────

function drawLoop() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#f4f4f6';
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  if (state.bgImage) {
    const { sx, sy } = imgToScreen(0, 0, state.view);
    ctx.drawImage(state.bgImage, sx, sy, state.imgW * state.view.zoom, state.imgH * state.view.zoom);
  }

  // edges
  for (const e of state.path.edges) {
    const A = state.path.nodes[e.from], B = state.path.nodes[e.to];
    if (!A || !B) continue;
    strokeTrackSegment(ctx, A, B, e, state.view);
    ctx.strokeStyle = 'rgba(48,80,200,0.55)'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.stroke();
  }
  // preview edge while chaining in PATH mode
  if (state.mode === 'PATH' && state.pathSel) {
    const A = state.path.nodes[state.pathSel];
    const a = imgToScreen(A.x, A.y, state.view);
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(state.mouse.sx, state.mouse.sy);
    ctx.strokeStyle = 'rgba(48,80,200,0.35)'; ctx.setLineDash([5, 5]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
  }
  // corners
  for (const [id, p] of Object.entries(state.path.nodes)) {
    const { sx, sy } = imgToScreen(p.x, p.y, state.view);
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(Math.PI / 4);
    ctx.beginPath(); ctx.rect(-4, -4, 8, 8);
    ctx.fillStyle = id === state.pathSel ? '#e8a020' : 'rgba(48,80,200,0.75)'; ctx.fill();
    ctx.restore();
  }

  // active group path preview — straight legs through the explicit nodes
  if (state.mode === 'GROUP' && state.activeGroup) {
    const stops = state.groups[state.activeGroup].stops.filter(s => nodePosC(s.node));
    for (let i = 0; i < stops.length - 1; i++) {
      const A = nodePosC(stops[i].node), B = nodePosC(stops[i + 1].node);
      const a = imgToScreen(A.x, A.y, state.view), b = imgToScreen(B.x, B.y, state.view);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy);
      ctx.strokeStyle = 'rgba(204,68,170,0.6)'; ctx.lineWidth = 2; ctx.stroke();
    }
    stops.forEach((s, i) => {
      const p = nodePosC(s.node); const { sx, sy } = imgToScreen(p.x, p.y, state.view);
      ctx.fillStyle = '#cc44aa'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      const lbl = state.stations[s.node] ? `${i + 1}:${s.action[0]}` : `${i + 1}`;
      ctx.fillText(lbl, sx, sy - DOT_R - 2);
    });
  }

  // stations
  for (const [id, st] of Object.entries(state.stations)) {
    const { sx, sy } = imgToScreen(st.x, st.y, state.view);
    if (st.role === 'home') {
      ctx.beginPath(); ctx.rect(sx - DOT_R, sy - DOT_R, DOT_R * 2, DOT_R * 2);
      ctx.fillStyle = '#cfe8ff'; ctx.fill(); ctx.strokeStyle = '#2c6fbf'; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(sx, sy, DOT_R, 0, Math.PI * 2);
      ctx.fillStyle = '#50DC78'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.fillStyle = '#1a1a2a'; ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(id, sx + DOT_R + 3, sy);
  }

  // free-floating call markers
  for (const c of state.calls) {
    const { sx, sy } = imgToScreen(c.x, c.y, state.view);
    ctx.beginPath(); ctx.arc(sx, sy, DOT_R + 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,248,232,0.9)'; ctx.fill();
    ctx.strokeStyle = 'rgba(230,160,32,0.95)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#9a6800'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('▶' + c.group, sx, sy);
  }

  // hud coords
  const { ix, iy } = toImg(state.mouse.sx, state.mouse.sy);
  hudCoords.textContent = `(${Math.round(ix)}, ${Math.round(iy)})`;
  hudZoom.textContent = `zoom: ${state.view.zoom.toFixed(2)}×`;

  requestAnimationFrame(drawLoop);
}
