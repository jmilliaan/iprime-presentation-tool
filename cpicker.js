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

// ── State ───────────────────────────────────────────────────────────────────

const state = {
  path:     { nodes: {}, edges: [] },     // nodes: {id:{x,y}}  edges: [{id,from,to,type,radius,clockwise}]
  stations: {},                           // id -> {x,y,role:'action'|'home',link}
  agvs:     [{ id: 'AGV-01', color: AGV_COLORS[0] }],
  groups:   {},                           // id -> {name, stops:[{station,action,dwell?}]}
  activeGroup:  null,
  callStations: [],                       // [{station,group}]
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
  // STATION editing
  placeRole: 'action', stationN: 1, homeN: 1,
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

// transient pick context (which station the action/group picker is acting on)
let pickStation = null;

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
  state.stations = {}; state.callStations = []; state.groups = {}; state.activeGroup = null;
  state.agvs = [{ id: 'AGV-01', color: AGV_COLORS[0] }];
  state.sim = { agvSpeed: 120, serviceTime: 3, requests: [],
                autoGenerate: { enabled: false, meanInterval: 6, seed: 1234 } };
  state.bgImage = null; state.imgW = 0; state.imgH = 0;
  state.pathSel = null; state.pathPtN = 1; state.edgeN = 1; state.stationN = 1; state.homeN = 1; state.groupN = 0;
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
    state.stations[id] = { x: s.x, y: s.y, role: s.role === 'home' ? 'home' : 'action', link: s.link || null };
  state.agvs = (data.AGVS || []).map((a, i) => ({ id: a.id || `AGV-0${i + 1}`, color: a.color || AGV_COLORS[i % AGV_COLORS.length] }));
  if (state.agvs.length === 0) state.agvs = [{ id: 'AGV-01', color: AGV_COLORS[0] }];
  state.groups = {};
  for (const [id, g] of Object.entries(data.GROUPS || {}))
    state.groups[id] = { name: g.name || id, stops: (g.stops || []).map(st => {
      const o = { station: st.station, action: st.action || 'move' };
      if (st.dwell !== undefined) o.dwell = st.dwell;
      return o;
    }) };
  state.callStations = (data.CALL_STATIONS || []).map(c => ({ station: c.station, group: c.group }));
  const sim = data.SIM || {};
  const ag = sim.autoGenerate || {};
  state.sim = {
    agvSpeed: sim.agvSpeed || 120, serviceTime: sim.serviceTime ?? 3,
    requests: (sim.requests || []).map(r => ({ t: +r.t || 0, group: r.group, agv: r.agv || null })),
    autoGenerate: { enabled: !!ag.enabled, meanInterval: ag.meanInterval || 6, seed: ag.seed ?? 1234 },
  };
  state.activeGroup = Object.keys(state.groups)[0] || null;
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
function nearestId(dict, ix, iy) {
  let best = null, bd = Infinity;
  for (const [id, p] of Object.entries(dict)) {
    const d = Math.hypot(ix - p.x, iy - p.y);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}
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
    if (state.pathSel && state.pathSel !== hit) { connectCorners(state.pathSel, hit); state.pathSel = hit; }
    else state.pathSel = hit;
    return;
  }
  const { ix, iy } = toImg(sx, sy);
  const id = nextCornerId();
  state.path.nodes[id] = { x: Math.round(ix), y: Math.round(iy) };
  if (state.pathSel) connectCorners(state.pathSel, id);
  state.pathSel = id;
  updatePathBar();
}
function connectCorners(a, b) {
  if (a === b) return;
  if (state.path.edges.some(s => (s.from === a && s.to === b) || (s.from === b && s.to === a))) return;
  const edge = { id: nextEdgeId(), from: a, to: b, type: state.pathArc ? 'arc' : 'straight' };
  if (state.pathArc) { edge.radius = state.pathR; edge.clockwise = state.pathCW; }
  state.path.edges.push(edge);
  updatePathBar();
}
function undoPath() {
  if (state.pathSel) { state.pathSel = null; return; }
  if (state.path.edges.length) { state.path.edges.pop(); updatePathBar(); return; }
  const ids = Object.keys(state.path.nodes);
  if (ids.length) { delete state.path.nodes[ids[ids.length - 1]]; updatePathBar(); }
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
  const link = nearestId(state.path.nodes, ix, iy);   // nearest corner (may be null if no path yet)
  state.stations[id] = { x: Math.round(ix), y: Math.round(iy), role: state.placeRole, link };
  if (!link) console.warn(`Station ${id} has no path corner to link to — draw the path first.`);
  updateHud();
}
function undoStation() {
  const ids = Object.keys(state.stations);
  if (!ids.length) return;
  const last = ids[ids.length - 1];
  delete state.stations[last];
  // cascade: drop references
  state.callStations = state.callStations.filter(c => c.station !== last);
  for (const g of Object.values(state.groups)) g.stops = g.stops.filter(s => s.station !== last);
  updateHud(); updateGroupsPanel();
}

// ── GROUP mode ─────────────────────────────────────────────────────────────────

$('newGroupBtn').addEventListener('click', () => {
  const id = nextGroupId();
  state.groups[id] = { name: id, stops: [] };
  state.activeGroup = id;
  updateGroupsPanel(); updateGroupBar();
});
function onClickGroup(sx, sy) {
  const st = hitStation(sx, sy);
  if (!st) return;
  if (!state.activeGroup) {
    const id = nextGroupId(); state.groups[id] = { name: id, stops: [] }; state.activeGroup = id; updateGroupsPanel();
  }
  pickStation = st;
  showActionPicker(sx, sy);
}
function undoGroupStop() {
  const g = state.groups[state.activeGroup];
  if (g && g.stops.length) { g.stops.pop(); updateGroupsPanel(); }
}
function updateGroupBar() {
  $('groupBarLabel').textContent = state.activeGroup
    ? `Active group: ${state.activeGroup}  (${state.groups[state.activeGroup].stops.length} stops)`
    : 'No active group — click "+ New group"';
}
function updateGroupsPanel() {
  groupsBody.innerHTML = '';
  for (const [id, g] of Object.entries(state.groups)) {
    const row = document.createElement('div');
    row.className = 'agv-entry' + (id === state.activeGroup ? ' active' : '');
    row.innerHTML = `<span style="flex:1;">${id}</span><span style="color:#888;">${g.stops.length}</span>`;
    const del = document.createElement('span');
    del.textContent = ' ✕'; del.style.cssText = 'cursor:pointer;color:#c33;margin-left:6px;';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      delete state.groups[id];
      state.callStations = state.callStations.filter(c => c.group !== id);
      if (state.activeGroup === id) state.activeGroup = Object.keys(state.groups)[0] || null;
      updateGroupsPanel(); updateGroupBar();
    });
    row.appendChild(del);
    row.addEventListener('click', () => { state.activeGroup = id; updateGroupsPanel(); updateGroupBar(); });
    groupsBody.appendChild(row);

    if (id === state.activeGroup) {
      g.stops.forEach((s, i) => {
        const sr = document.createElement('div');
        sr.style.cssText = 'padding:2px 10px 2px 18px;font-size:11px;display:flex;gap:6px;';
        sr.innerHTML = `<span style="color:#888;">${i + 1}.</span><span style="flex:1;">${s.station}</span><span style="color:#1a6828;">${s.action}</span>`;
        groupsBody.appendChild(sr);
      });
    }
  }
  updateGroupBar(); updateHud();
}

// ── CALL mode ──────────────────────────────────────────────────────────────────

function onClickCall(sx, sy) {
  const st = hitStation(sx, sy);
  if (!st) return;
  if (Object.keys(state.groups).length === 0) { alert('Create a group first (Group mode).'); return; }
  pickStation = st;
  showGroupPicker(sx, sy);
}
function removeCallAt(sx, sy) {
  const st = hitStation(sx, sy);
  if (st) { state.callStations = state.callStations.filter(c => c.station !== st); updateHud(); }
}

// ── Pickers (action + group) ───────────────────────────────────────────────────

actionPicker.querySelectorAll('button[data-action]').forEach(btn => {
  btn.addEventListener('click', () => {
    const g = state.groups[state.activeGroup];
    if (g && pickStation) { g.stops.push({ station: pickStation, action: btn.dataset.action }); updateGroupsPanel(); }
    hideActionPicker();
  });
});
function showActionPicker(sx, sy) {
  actionPicker.style.left = `${Math.min(sx, window.innerWidth - 220)}px`;
  actionPicker.style.top  = `${Math.min(sy, window.innerHeight - 200)}px`;
  actionPicker.style.display = 'block';
}
function hideActionPicker() { actionPicker.style.display = 'none'; }

function showGroupPicker(sx, sy) {
  groupPickerBody.innerHTML = '';
  Object.keys(state.groups).forEach(id => {
    const b = document.createElement('button');
    b.textContent = id;
    b.addEventListener('click', () => {
      state.callStations = state.callStations.filter(c => c.station !== pickStation);
      state.callStations.push({ station: pickStation, group: id });
      hideGroupPicker(); updateHud();
    });
    groupPickerBody.appendChild(b);
  });
  groupPicker.style.left = `${Math.min(sx, window.innerWidth - 220)}px`;
  groupPicker.style.top  = `${Math.min(sy, window.innerHeight - 200)}px`;
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
  hudCounts.textContent = `path: ${Object.keys(state.path.nodes).length} · stations: ${Object.keys(state.stations).length} · groups: ${Object.keys(state.groups).length} · calls: ${state.callStations.length}`;
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
    CALL_STATIONS: state.callStations,
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

  // station→corner link hints
  for (const st of Object.values(state.stations)) {
    if (!st.link || !state.path.nodes[st.link]) continue;
    const a = imgToScreen(st.x, st.y, state.view);
    const b = imgToScreen(state.path.nodes[st.link].x, state.path.nodes[st.link].y, state.view);
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy);
    ctx.strokeStyle = 'rgba(120,120,140,0.5)'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }

  // active group path preview
  if (state.mode === 'GROUP' && state.activeGroup) {
    const stops = state.groups[state.activeGroup].stops.filter(s => state.stations[s.station]);
    for (let i = 0; i < stops.length - 1; i++) {
      const A = state.stations[stops[i].station], B = state.stations[stops[i + 1].station];
      const a = imgToScreen(A.x, A.y, state.view), b = imgToScreen(B.x, B.y, state.view);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy);
      ctx.strokeStyle = 'rgba(204,68,170,0.6)'; ctx.lineWidth = 2; ctx.stroke();
    }
    stops.forEach((s, i) => {
      const p = state.stations[s.station]; const { sx, sy } = imgToScreen(p.x, p.y, state.view);
      ctx.fillStyle = '#cc44aa'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(`${i + 1}:${s.action[0]}`, sx, sy - DOT_R - 2);
    });
  }

  // stations
  const callSet = new Set(state.callStations.map(c => c.station));
  for (const [id, st] of Object.entries(state.stations)) {
    const { sx, sy } = imgToScreen(st.x, st.y, state.view);
    if (st.role === 'home') {
      ctx.beginPath(); ctx.rect(sx - DOT_R, sy - DOT_R, DOT_R * 2, DOT_R * 2);
      ctx.fillStyle = '#cfe8ff'; ctx.fill(); ctx.strokeStyle = '#2c6fbf'; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(sx, sy, DOT_R, 0, Math.PI * 2);
      ctx.fillStyle = '#50DC78'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
    }
    if (callSet.has(id)) {
      const c = state.callStations.find(x => x.station === id);
      ctx.beginPath(); ctx.arc(sx, sy, DOT_R + 7, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(230,160,32,0.9)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#9a6800'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('▶' + c.group, sx, sy - DOT_R - 9);
    }
    ctx.fillStyle = '#1a1a2a'; ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(id, sx + DOT_R + 3, sy);
  }

  // hud coords
  const { ix, iy } = toImg(state.mouse.sx, state.mouse.sy);
  hudCoords.textContent = `(${Math.round(ix)}, ${Math.round(iy)})`;
  hudZoom.textContent = `zoom: ${state.view.zoom.toFixed(2)}×`;

  requestAnimationFrame(drawLoop);
}
