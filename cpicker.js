// cpicker.js — Coordinate picker with radial menu

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

// ── Application state ─────────────────────────────────────────────────────

const TRACK_COLOR = '#3060d0';

const state = {
  nodes:         {},
  agvs:          [{ id: 'AGV-01', color: AGV_COLORS[0], sequence: [] }],
  activeAgvIdx:  0,
  track:         { points: {}, segments: [] },
  trackSel:      null,   // selected track-point ID (start of next segment)
  trackArc:      false,  // next segment is arc
  trackR:        100,    // arc radius for new segments
  trackCW:       true,   // arc clockwise direction
  trackPtN:      1,      // auto-name counter for TPs
  trackSegN:     1,      // auto-name counter for segments
  trackLastSeg:  null,   // ID of last created segment (for radius editing)
  view:          { offsetX: 0, offsetY: 0, zoom: 1 },
  mode:          'NODE',
  bgImage:       null,
  imgW: 0, imgH: 0,
  outputFilename: 'coords.json',
  dispatch: {
    enabled:      false,
    homeSlots:    [],      // ordered seq_point node ids — one parking spot per AGV
    lines:        [],      // { id, node, serviceAction, serviceTime }
    requests:     [],      // { t, line, agv }
    autoGenerate: { enabled: false, meanInterval: 6, seed: 1234 },
  },
  mouseScreen: { sx: 0, sy: 0 },
  mouseImg:    { ix: 0, iy: 0 },
  isPanning:        false,
  panStart:         { sx: 0, sy: 0 },
  panViewStart:     { offsetX: 0, offsetY: 0 },
  hoveredNode:      null,
  actionPickerNode: null,
};

// Convenience accessor for the currently-edited AGV's sequence
function activeSeq() { return state.agvs[state.activeAgvIdx].sequence; }
function activeAgv()  { return state.agvs[state.activeAgvIdx]; }

// ── Radial menu state ─────────────────────────────────────────────────────
// Used in NODE mode (type_select | naming) and SEQUENCE mode (angle_select)

const RADIAL_R  = 90;
const RADIAL_RI = 26;
const ANGLES    = [0, 45, 90, 135, 180, 225, 270, 315];

const radial = {
  active: false,
  phase:  null,   // 'type_select' | 'naming' | 'angle_select'
  cx: 0, cy: 0,
  ix: 0, iy: 0,   // image coords (NODE mode placement)
  nodeType: null, // for color
  nodeName: '',   // shown in angle radial center
};

// Pending sequence entry — filled during SEQUENCE mode angle selection
const seqEntry = {
  pending: false,
  nodeId:  null,
  action:  null,
  heading: 0,
};

// ── DOM references ────────────────────────────────────────────────────────

const agvPanel          = document.getElementById('agvPanel');
const startupModal      = document.getElementById('startupModal');
const confirmClearModal = document.getElementById('confirmClearModal');
const actionPicker      = document.getElementById('actionPicker');
const seqPanel          = document.getElementById('seqPanel');
const seqPanelTitle     = document.getElementById('seqPanelTitle');
const seqList           = document.getElementById('seqList');
const nodeListPanel     = document.getElementById('nodeListPanel');
const nodeListTitle     = document.getElementById('nodeListTitle');
const nodeListBody      = document.getElementById('nodeListBody');
const modeBadge         = document.getElementById('modeBadge');
const hudCoords         = document.getElementById('hudCoords');
const hudZoom           = document.getElementById('hudZoom');
const hudCounts         = document.getElementById('hudCounts');
const hudFile           = document.getElementById('hudFile');
const filenameInput     = document.getElementById('filenameInput');
const loadJsonInput     = document.getElementById('loadJsonInput');
const loadImgInput      = document.getElementById('loadImgInput');
const nameInputBar      = document.getElementById('nameInputBar');
const nameInput         = document.getElementById('nameInput');
const detailsBar        = document.getElementById('detailsBar');
const dwellInput        = document.getElementById('dwellInput');
const labelInput        = document.getElementById('labelInput');
const modeManual        = document.getElementById('modeManual');
const detailsModeLabel  = document.getElementById('detailsModeLabel');
const trackBar          = document.getElementById('trackBar');
const trackStraightBtn  = document.getElementById('trackStraightBtn');
const trackArcBtn       = document.getElementById('trackArcBtn');
const trackArcControls  = document.getElementById('trackArcControls');
const trackRadiusInput  = document.getElementById('trackRadiusInput');
const trackCwBtn        = document.getElementById('trackCwBtn');
const trackCcwBtn       = document.getElementById('trackCcwBtn');
const trackInfoEl       = document.getElementById('trackInfo');

// ── Canvas resize (DPR-aware) ─────────────────────────────────────────────

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(window.innerWidth  * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width  = window.innerWidth  + 'px';
  canvas.style.height = window.innerHeight + 'px';
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── Image loading ─────────────────────────────────────────────────────────

function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.bgImage = img;
    state.imgW    = img.naturalWidth;
    state.imgH    = img.naturalHeight;
    const z = Math.min(window.innerWidth / state.imgW, (window.innerHeight - 26) / state.imgH) * 0.95;
    state.view.zoom    = z;
    state.view.offsetX = window.innerWidth  / 2 - state.imgW * z / 2;
    state.view.offsetY = (window.innerHeight - 26) / 2 - state.imgH * z / 2;
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

// ── Startup modal ─────────────────────────────────────────────────────────

startupModal.showModal();

loadJsonInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (data.NODES) state.nodes = data.NODES;
      if (data.TRACK) state.track = normaliseTrack(data.TRACK);
      const loaded = normaliseAGVS(data);
      if (loaded.length > 0) {
        state.agvs = loaded.slice(0, 4);
      } else {
        state.agvs = [{ id: 'AGV-01', color: AGV_COLORS[0], sequence: [] }];
      }
      state.activeAgvIdx = 0;
      // Sync TP counter past any loaded IDs
      for (const id of Object.keys(state.track.points)) {
        const n = parseInt(id.replace('TP-', ''), 10);
        if (!isNaN(n) && n >= state.trackPtN) state.trackPtN = n + 1;
      }
      const nd = normaliseDispatch(data);
      state.dispatch = nd
        ? { enabled: true, homeSlots: nd.homeSlots, lines: nd.lines,
            requests: nd.requests, autoGenerate: nd.autoGenerate }
        : { enabled: false, homeSlots: [], lines: [], requests: [],
            autoGenerate: { enabled: false, meanInterval: 6, seed: 1234 } };
      updateAgvPanel();
      updateSeqPanel();
      updateNodeList();
      updateTrackBar();
      updateDispatchPanel();
    } catch { alert('Invalid JSON.'); }
  };
  reader.readAsText(file);
});

loadImgInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadImage(e.target.files[0]);
});

document.getElementById('startBtn').addEventListener('click', () => {
  const name = filenameInput.value.trim();
  if (name) { state.outputFilename = name; hudFile.textContent = `→ ${name}`; }
  startupModal.close();
  updateAgvPanel();
  updateSeqPanel();
  updateNodeList();
  updateTrackBar();
  updateDispatchPanel();
  requestAnimationFrame(drawLoop);
});

// ── Clear ─────────────────────────────────────────────────────────────────

document.getElementById('clearBtn').addEventListener('click', () => confirmClearModal.showModal());

document.getElementById('confirmClearCancel').addEventListener('click', () => confirmClearModal.close());

document.getElementById('confirmClearOk').addEventListener('click', () => {
  confirmClearModal.close();
  state.nodes        = {};
  state.agvs         = [{ id: 'AGV-01', color: AGV_COLORS[0], sequence: [] }];
  state.activeAgvIdx = 0;
  state.track        = { points: {}, segments: [] };
  state.trackSel     = null;
  state.trackPtN     = 1;
  state.trackSegN    = 1;
  state.trackLastSeg = null;
  state.bgImage = null; state.imgW = 0; state.imgH = 0;
  state.mode = 'NODE'; state.hoveredNode = null; state.actionPickerNode = null;
  state.dispatch = { enabled: false, homeSlots: [], lines: [], requests: [],
    autoGenerate: { enabled: false, meanInterval: 6, seed: 1234 } };
  loadJsonInput.value = ''; loadImgInput.value = '';
  filenameInput.value = 'coords.json'; state.outputFilename = 'coords.json';
  closeRadial(); hideActionPicker(); hideDetailsBar();
  updateAgvPanel(); updateSeqPanel(); updateNodeList(); updateModeBadge();
  updateTrackBar(); updateDispatchPanel();
  hudFile.textContent = '→ coords.json';
  startupModal.showModal();
});

// ── WP auto-name ──────────────────────────────────────────────────────────

function nextWpName() {
  let n = 1;
  while (state.nodes[`WP-${String(n).padStart(2, '0')}`]) n++;
  return `WP-${String(n).padStart(2, '0')}`;
}

// ── Radial: node placement (NODE mode) ───────────────────────────────────

function openRadial(sx, sy, ix, iy) {
  radial.active = true;
  radial.phase  = 'type_select';
  radial.cx = sx; radial.cy = sy;
  radial.ix = ix; radial.iy = iy;
  radial.nodeType = null;
  radial.nodeName = '';
}

function closeRadial() {
  radial.active    = false;
  radial.phase     = null;
  seqEntry.pending = false;
  seqEntry.nodeId  = null;
  seqEntry.action  = null;
  hideNameInput();
}

// Closes only the visual radial — keeps seqEntry intact so submitDetailsBar can still read it
function closeRadialVisual() {
  radial.active = false;
  radial.phase  = null;
  hideNameInput();
}

// ── Details bar (dwell / label / mode — shown after angle selection) ──────

function showDetailsBar() {
  dwellInput.value   = '';
  labelInput.value   = '';
  modeManual.checked = false;
  // manual toggle only makes sense for trolley actions
  detailsModeLabel.style.display =
    ['pickup', 'release', 'exchange'].includes(seqEntry.action) ? 'flex' : 'none';
  detailsBar.style.display = 'flex';
  requestAnimationFrame(() => dwellInput.focus());
}

function hideDetailsBar() {
  detailsBar.style.display = 'none';
  seqEntry.pending = false;
  seqEntry.nodeId  = null;
  seqEntry.action  = null;
  seqEntry.heading = 0;
}

function submitDetailsBar() {
  const dwell = parseFloat(dwellInput.value);
  const label = labelInput.value.trim();
  const entry = {
    node:    seqEntry.nodeId,
    action:  seqEntry.action,
    heading: seqEntry.heading,
  };
  if (isFinite(dwell) && dwell >= 0) entry.dwell = dwell;
  if (label) entry.label = label;
  if (modeManual.checked) entry.mode = 'manual';
  activeSeq().push(entry);
  hideDetailsBar();
  updateAgvPanel();
  updateSeqPanel();
}

[dwellInput, labelInput].forEach(input => {
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') submitDetailsBar();
    if (e.key === 'Escape') hideDetailsBar();
  });
});

function snapNodeToTrack(ix, iy) {
  let bestId = null, bestDist = 20;
  for (const [id, pt] of Object.entries(state.track.points)) {
    const d = Math.hypot(ix - pt.x, iy - pt.y);
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  return bestId;
}

function selectType(type) {
  if (type === 'waypoint') {
    const id   = nextWpName();
    const ix   = Math.round(radial.ix), iy = Math.round(radial.iy);
    const snap = snapNodeToTrack(ix, iy);
    state.nodes[id] = snap
      ? { x: state.track.points[snap].x, y: state.track.points[snap].y, type: 'waypoint', trackPoint: snap }
      : { x: ix, y: iy, type: 'waypoint' };
    closeRadial();
    updateNodeList();
    updateSeqPanel();
  } else {
    radial.nodeType = 'seq_point';
    radial.phase    = 'naming';
    showNameInput();
  }
}

// ── Radial: sequence angle selection (SEQUENCE mode) ─────────────────────

function openSeqAngleRadial(nodeId, action, cx, cy) {
  seqEntry.pending = true;
  seqEntry.nodeId  = nodeId;
  seqEntry.action  = action;
  radial.active    = true;
  radial.phase     = 'angle_select';
  radial.cx = cx; radial.cy = cy;
  radial.nodeType  = state.nodes[nodeId]?.type || 'waypoint';
  radial.nodeName  = nodeId;
}

function selectSeqAngle(sectorIdx) {
  seqEntry.heading = sectorIdx * 45;
  closeRadialVisual();   // keep seqEntry.nodeId/action intact for submitDetailsBar
  showDetailsBar();
}

// ── Sector detection ──────────────────────────────────────────────────────

function getTypeSector(mx, my) {
  return (mx - radial.cx) < 0 ? 'seq_point' : 'waypoint';
}

function getAngleSector(mx, my) {
  const dx = mx - radial.cx, dy = my - radial.cy;
  if (Math.hypot(dx, dy) < RADIAL_RI) return null;
  const deg = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
  return Math.round(deg / 45) % 8;
}

// ── Name input bar ────────────────────────────────────────────────────────

function showNameInput() {
  nameInput.value = '';
  nameInputBar.style.display = 'flex';
  nameInputBar.style.left = `${radial.cx - 120}px`;
  nameInputBar.style.top  = `${radial.cy - RADIAL_R - 72}px`;
  requestAnimationFrame(() => nameInput.focus());
}

function hideNameInput() {
  nameInputBar.style.display = 'none';
  nameInputBar.classList.remove('error');
  nameInput.value = '';
}

nameInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const val = nameInput.value.trim();
    if (!val) {
      nameInputBar.classList.add('error');
      setTimeout(() => nameInputBar.classList.remove('error'), 400);
      return;
    }
    const ix   = Math.round(radial.ix), iy = Math.round(radial.iy);
    const snap = snapNodeToTrack(ix, iy);
    state.nodes[val] = snap
      ? { x: state.track.points[snap].x, y: state.track.points[snap].y, type: 'seq_point', trackPoint: snap }
      : { x: ix, y: iy, type: 'seq_point' };
    hideNameInput();
    closeRadial();
    updateNodeList();
    updateSeqPanel();
  }
  if (e.key === 'Escape') closeRadial();
});

// ── Action picker (SEQUENCE mode) ─────────────────────────────────────────

actionPicker.querySelectorAll('button[data-action]').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    const nodeId = state.actionPickerNode;
    const cx     = seqEntry._pickerCx ?? state.mouseScreen.sx;
    const cy     = seqEntry._pickerCy ?? state.mouseScreen.sy;
    hideActionPicker();
    if (nodeId) openSeqAngleRadial(nodeId, action, cx, cy);
  });
});

function showActionPicker(nodeId, clientX, clientY) {
  state.actionPickerNode = nodeId;
  // Store position for the angle radial that follows
  seqEntry._pickerCx = clientX;
  seqEntry._pickerCy = clientY;
  const w = 200, h = 160;
  actionPicker.style.left    = `${Math.min(clientX + 10, window.innerWidth  - w - 10)}px`;
  actionPicker.style.top     = `${Math.min(clientY,       window.innerHeight - h - 10)}px`;
  actionPicker.style.display = 'flex';
}

function hideActionPicker() {
  state.actionPickerNode = null;
  actionPicker.style.display = 'none';
}

document.addEventListener('mousedown', (e) => {
  if (detailsBar.style.display === 'flex' && !detailsBar.contains(e.target)) {
    hideDetailsBar();
  }
  if (actionPicker.style.display === 'flex' && !actionPicker.contains(e.target)) {
    hideActionPicker();
    seqEntry.pending = false;
  }
});

// ── Keyboard ──────────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (startupModal.open || confirmClearModal.open) return;

  if (e.key === 'Escape') {
    if (state.mode === 'TRACK') { state.trackSel = null; return; }
    if (radial.active) { closeRadial(); return; }
  }

  if (e.key === 't' || e.key === 'T') {
    if (radial.active) closeRadial();
    hideActionPicker(); hideDetailsBar();
    state.mode = state.mode === 'TRACK' ? 'NODE' : 'TRACK';
    state.trackSel = null;
    updateModeBadge();
    updateTrackBar();
    return;
  }

  if (state.mode === 'TRACK') {
    // A = toggle arc/straight
    if (e.key === 'a' || e.key === 'A') {
      state.trackArc = !state.trackArc;
      updateTrackBar();
    }
    return; // absorb all other keys in track mode
  }

  if (e.key === 'e' || e.key === 'E') {
    if (radial.active) closeRadial();
    hideActionPicker();
    state.mode = state.mode === 'NODE' ? 'SEQUENCE' : 'NODE';
    updateModeBadge();
  }

  if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) saveJSON();
});

// ── Mouse ─────────────────────────────────────────────────────────────────

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (radial.active) { closeRadial(); return; }
  if (actionPicker.style.display === 'flex') { hideActionPicker(); return; }

  if (state.mode === 'TRACK') {
    if (state.trackSel) {
      state.trackSel = null;
    } else {
      // Undo last track point and any segments connected to it
      const ptIds = Object.keys(state.track.points);
      if (!ptIds.length) return;
      const lastId = ptIds[ptIds.length - 1];
      delete state.track.points[lastId];
      state.track.segments = state.track.segments.filter(s => s.from !== lastId && s.to !== lastId);
      if (state.trackLastSeg && !state.track.segments.find(s => s.id === state.trackLastSeg))
        state.trackLastSeg = null;
      state.trackPtN = Math.max(1, state.trackPtN - 1);
      updateTrackBar();
    }
    return;
  }

  if (state.mode === 'NODE') {
    const keys = Object.keys(state.nodes);
    if (keys.length) { delete state.nodes[keys[keys.length - 1]]; updateSeqPanel(); updateNodeList(); }
  } else {
    if (activeSeq().length) { activeSeq().pop(); updateAgvPanel(); updateSeqPanel(); }
  }
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    e.preventDefault();
    state.isPanning    = true;
    state.panStart     = { sx: e.clientX, sy: e.clientY };
    state.panViewStart = { offsetX: state.view.offsetX, offsetY: state.view.offsetY };
    return;
  }
  if (e.button !== 0) return;
  if (startupModal.open || confirmClearModal.open) return;
  if (actionPicker.style.display === 'flex') { hideActionPicker(); return; }

  const mx = e.clientX, my = e.clientY;

  if (state.mode === 'TRACK') {
    const hitTP = findTrackPtAt(mx, my);
    if (hitTP) {
      if (!state.trackSel) {
        state.trackSel = hitTP;
      } else if (state.trackSel === hitTP) {
        state.trackSel = null;
      } else {
        connectTrackPoints(state.trackSel, hitTP);
        state.trackSel = hitTP; // chain: new start
      }
    } else {
      // Place new track point
      const img  = screenToImg(mx, my, state.view);
      const newId = `TP-${String(state.trackPtN).padStart(2, '0')}`;
      state.trackPtN++;
      state.track.points[newId] = { x: Math.round(img.ix), y: Math.round(img.iy) };
      if (state.trackSel) connectTrackPoints(state.trackSel, newId);
      state.trackSel = newId;
      updateTrackBar();
    }
    return;
  }

  if (state.mode === 'NODE') {
    if (radial.active) {
      if (radial.phase === 'type_select') {
        const dist = Math.hypot(mx - radial.cx, my - radial.cy);
        if (dist < RADIAL_RI) { closeRadial(); return; }
        if (dist > RADIAL_R) {
          const img = screenToImg(mx, my, state.view);
          openRadial(mx, my, img.ix, img.iy);
          return;
        }
        selectType(getTypeSector(mx, my));
      }
      // 'naming' phase is handled by nameInput keydown
    } else {
      const img = screenToImg(mx, my, state.view);
      openRadial(mx, my, img.ix, img.iy);
    }

  } else {
    // SEQUENCE mode
    if (radial.active && radial.phase === 'angle_select') {
      const dist = Math.hypot(mx - radial.cx, my - radial.cy);
      if (dist > RADIAL_R + 20) { closeRadial(); return; }
      const sector = getAngleSector(mx, my);
      if (sector === null) { closeRadial(); return; }
      selectSeqAngle(sector);
      return;
    }

    if (!radial.active) {
      const hit = findNodeAt(state.mouseScreen.sx, state.mouseScreen.sy, state.nodes, state.view);
      if (hit) {
        if (state.nodes[hit].type === 'waypoint') {
          openSeqAngleRadial(hit, 'move', mx, my);
        } else {
          showActionPicker(hit, mx, my);
          e.stopPropagation();
        }
      }
    }
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button === 1) state.isPanning = false;
});

canvas.addEventListener('mousemove', (e) => {
  state.mouseScreen.sx = e.clientX;
  state.mouseScreen.sy = e.clientY;
  const img = screenToImg(e.clientX, e.clientY, state.view);
  state.mouseImg.ix = Math.max(0, Math.min(state.imgW || 9999, img.ix));
  state.mouseImg.iy = Math.max(0, Math.min(state.imgH || 9999, img.iy));

  if (state.isPanning) {
    state.view.offsetX = state.panViewStart.offsetX + (e.clientX - state.panStart.sx);
    state.view.offsetY = state.panViewStart.offsetY + (e.clientY - state.panStart.sy);
  }

  if (state.mode === 'TRACK') {
    const hitTP = findTrackPtAt(e.clientX, e.clientY);
    canvas.style.cursor = hitTP ? 'pointer' : 'crosshair';
  } else if (state.mode === 'SEQUENCE' && !radial.active) {
    state.hoveredNode = findNodeAt(e.clientX, e.clientY, state.nodes, state.view);
    canvas.style.cursor = state.hoveredNode ? 'pointer' : 'default';
  } else {
    canvas.style.cursor = (state.mode === 'NODE' && !radial.active) ? 'crosshair' : 'default';
  }

  hudCoords.textContent = `(${Math.round(state.mouseImg.ix)}, ${Math.round(state.mouseImg.iy)})`;
  hudZoom.textContent   = `zoom: ${state.view.zoom.toFixed(2)}×`;
  hudCounts.textContent = `agvs: ${state.agvs.length} | nodes: ${Object.keys(state.nodes).length} | seq: ${activeSeq().length}`;
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor  = e.deltaY < 0 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP;
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.view.zoom * factor));
  const { ix, iy } = screenToImg(state.mouseScreen.sx, state.mouseScreen.sy, state.view);
  state.view.zoom    = newZoom;
  state.view.offsetX = state.mouseScreen.sx - ix * newZoom;
  state.view.offsetY = state.mouseScreen.sy - iy * newZoom;
}, { passive: false });

// ── Radial draw: type select ──────────────────────────────────────────────

function drawTypeSelectRadial() {
  const { cx, cy } = radial;
  const R = RADIAL_R, Ri = RADIAL_RI;
  const hoverLeft = (state.mouseScreen.sx - cx) < 0;

  ctx.save();

  // Left — seq_point
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, Math.PI / 2, -Math.PI / 2, false);
  ctx.closePath();
  ctx.fillStyle   = hoverLeft ? 'rgba(80,220,120,0.82)' : 'rgba(80,220,120,0.28)';
  ctx.fill();
  ctx.strokeStyle = hoverLeft ? '#1a8030' : 'rgba(80,200,100,0.4)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Right — waypoint
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, -Math.PI / 2, Math.PI / 2, false);
  ctx.closePath();
  ctx.fillStyle   = !hoverLeft ? 'rgba(255,200,50,0.82)' : 'rgba(255,200,50,0.28)';
  ctx.fill();
  ctx.strokeStyle = !hoverLeft ? '#b07800' : 'rgba(220,170,40,0.4)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Divider
  ctx.beginPath();
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.strokeStyle = 'rgba(100,100,120,0.3)'; ctx.lineWidth = 1; ctx.stroke();

  // Inner donut
  ctx.beginPath();
  ctx.arc(cx, cy, Ri, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(248,248,252,0.96)'; ctx.fill();
  ctx.strokeStyle = '#c0c0cc'; ctx.lineWidth = 1; ctx.stroke();

  // Labels
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = hoverLeft ? '#1a5028' : '#1a8030';
  ctx.font = 'bold 12px monospace'; ctx.fillText('seq',   cx - R * 0.6, cy - 7);
  ctx.font = '10px monospace';      ctx.fillText('point', cx - R * 0.6, cy + 7);
  ctx.fillStyle = !hoverLeft ? '#805000' : '#b07800';
  ctx.font = 'bold 12px monospace'; ctx.fillText('way',   cx + R * 0.6, cy - 7);
  ctx.font = '10px monospace';      ctx.fillText('point', cx + R * 0.6, cy + 7);

  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#606070'; ctx.fill();
  ctx.restore();
}

// ── Radial draw: angle select ─────────────────────────────────────────────

function drawAngleSelectRadial() {
  const { cx, cy } = radial;
  const R = RADIAL_R, Ri = RADIAL_RI;
  const hoverSector = getAngleSector(state.mouseScreen.sx, state.mouseScreen.sy);
  const isSeq  = radial.nodeType === 'seq_point';
  const baseC  = isSeq ? 'rgba(80,220,120,0.22)'  : 'rgba(255,200,50,0.22)';
  const hovC   = isSeq ? 'rgba(80,220,120,0.82)'  : 'rgba(255,200,50,0.82)';
  const hovStr = isSeq ? '#1a8030'                 : '#b07800';

  ctx.save();
  for (let i = 0; i < 8; i++) {
    const startAngle = (i * 45 - 22.5) * Math.PI / 180;
    const endAngle   = (i * 45 + 22.5) * Math.PI / 180;
    const isHover    = hoverSector === i;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle   = isHover ? hovC  : baseC;
    ctx.fill();
    ctx.strokeStyle = isHover ? hovStr : 'rgba(150,150,160,0.25)';
    ctx.lineWidth   = 1.5; ctx.stroke();

    const midRad = i * 45 * Math.PI / 180;
    const lx = cx + R * 0.65 * Math.cos(midRad);
    const ly = cy + R * 0.65 * Math.sin(midRad);
    ctx.fillStyle    = isHover ? '#1a1a2a' : '#505060';
    ctx.font         = `${isHover ? 'bold ' : ''}11px monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${ANGLES[i]}°`, lx, ly);
  }

  // Inner donut
  ctx.beginPath();
  ctx.arc(cx, cy, Ri, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(248,248,252,0.96)'; ctx.fill();
  ctx.strokeStyle = '#c0c0cc'; ctx.lineWidth = 1; ctx.stroke();

  // Node name in center
  const label = radial.nodeName.length > 7
    ? radial.nodeName.slice(0, 6) + '…' : radial.nodeName;
  ctx.fillStyle = '#1a1a2a'; ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy);
  ctx.restore();
}

// ── Panel updates ─────────────────────────────────────────────────────────

function updateSeqPanel() {
  const agv = activeAgv();
  const seq = activeSeq();
  seqPanel.style.display    = seq.length > 0 ? 'block' : 'none';
  seqPanel.style.borderColor = agv.color;
  seqPanelTitle.style.color  = agv.color;
  seqPanelTitle.textContent  = `${agv.id} (${seq.length})`;
  seqList.innerHTML = '';
  seq.forEach(({ node, action, heading, dwell, label, mode }, i) => {
    const row = document.createElement('div');
    row.className = 'seq-entry';
    let extras = '';
    if (dwell !== undefined || label || mode === 'manual') {
      extras = '<div class="seq-extras">';
      if (dwell !== undefined) extras += `<span class="seq-dwell">${dwell}s</span>`;
      if (label) extras += `<span class="seq-lbl" title="${label}">${label}</span>`;
      if (mode === 'manual') extras += `<span class="seq-manual">MAN</span>`;
      extras += '</div>';
    }
    row.innerHTML =
      `<div class="seq-entry-row">` +
      `<span class="seq-idx">${i}</span>` +
      `<span class="seq-node">${node}</span>` +
      `<span class="action-badge badge-${action}">${action}</span>` +
      `<span class="seq-heading">${heading ?? 0}°</span>` +
      `</div>` +
      extras;
    seqList.appendChild(row);
  });
}

function updateAgvPanel() {
  agvPanel.innerHTML = '';
  const title = document.createElement('div');
  title.className   = 'panel-title';
  title.textContent = `AGVs (${state.agvs.length})`;
  agvPanel.appendChild(title);

  state.agvs.forEach((agv, i) => {
    const row = document.createElement('div');
    row.className = 'agv-entry';
    row.style.borderLeftColor = i === state.activeAgvIdx ? agv.color : 'transparent';
    row.innerHTML =
      `<span class="agv-swatch" style="background:${agv.color}"></span>` +
      `<span class="agv-id">${agv.id}</span>` +
      `<span class="agv-seq-count">${agv.sequence.length}</span>`;

    if (state.agvs.length > 1) {
      const removeBtn = document.createElement('button');
      removeBtn.className   = 'agv-remove-btn';
      removeBtn.textContent = '×';
      removeBtn.title       = 'Remove AGV';
      removeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.agvs.splice(i, 1);
        if (state.activeAgvIdx >= state.agvs.length) state.activeAgvIdx = state.agvs.length - 1;
        closeRadial(); hideActionPicker(); hideDetailsBar();
        updateAgvPanel(); updateSeqPanel();
      });
      row.appendChild(removeBtn);
    }

    row.addEventListener('click', () => {
      state.activeAgvIdx = i;
      closeRadial();
      hideActionPicker();
      hideDetailsBar();
      updateAgvPanel();
      updateSeqPanel();
    });
    agvPanel.appendChild(row);
  });

  if (state.agvs.length < 4) {
    const addBtn = document.createElement('button');
    addBtn.className   = 'agv-add-btn';
    addBtn.textContent = '+ New AGV';
    addBtn.addEventListener('click', () => {
      const idx   = state.agvs.length;
      const color = AGV_COLORS[idx % AGV_COLORS.length];
      state.agvs.push({ id: `AGV-0${idx + 1}`, color, sequence: [] });
      state.activeAgvIdx = idx;
      updateAgvPanel();
      updateSeqPanel();
    });
    agvPanel.appendChild(addBtn);
  }

  agvPanel.style.display = 'block';
}

function updateNodeList() {
  const keys = Object.keys(state.nodes);
  nodeListPanel.style.display = keys.length > 0 ? 'block' : 'none';
  nodeListTitle.textContent   = `NODES (${keys.length})`;
  nodeListBody.innerHTML      = '';
  keys.forEach(id => {
    const isSeq = state.nodes[id].type === 'seq_point';
    const row   = document.createElement('div');
    row.className = 'node-entry';
    row.innerHTML =
      `<span class="node-entry-name">${id}</span>` +
      `<span class="${isSeq ? 'node-type-seq' : 'node-type-wp'}">${isSeq ? 'seq' : 'wp'}</span>`;
    nodeListBody.appendChild(row);
  });
}

function updateModeBadge() {
  const labels  = { NODE: 'NODE MODE', SEQUENCE: 'SEQUENCE MODE', TRACK: 'TRACK MODE' };
  const classes = { NODE: 'node-mode', SEQUENCE: 'seq-mode',      TRACK: 'track-mode' };
  modeBadge.textContent = labels[state.mode]  || 'NODE MODE';
  modeBadge.className   = classes[state.mode] || 'node-mode';
}

// ── Dispatch authoring ─────────────────────────────────────────────────────

function nodeDispatchRole(id) {
  if (state.dispatch.homeSlots.includes(id))           return 'home';
  if (state.dispatch.lines.some(l => l.node === id))   return 'line';
  return 'none';
}

function nextLineId() {
  const used = new Set(state.dispatch.lines.map(l => l.id));
  for (let i = 0; i < 26; i++) {
    const id = 'LINE-' + String.fromCharCode(65 + i);
    if (!used.has(id)) return id;
  }
  return 'LINE-' + (state.dispatch.lines.length + 1);
}

function setNodeDispatchRole(id, role) {
  state.dispatch.homeSlots = state.dispatch.homeSlots.filter(x => x !== id);
  state.dispatch.lines     = state.dispatch.lines.filter(l => l.node !== id);
  if (role === 'home') {
    state.dispatch.homeSlots.push(id);
  } else if (role === 'line') {
    state.dispatch.lines.push({ id: nextLineId(), node: id, serviceAction: 'exchange', serviceTime: 3 });
  }
  updateDispatchPanel();
}

function parseRequestsText(txt) {
  return txt.split('\n').map(s => s.trim()).filter(Boolean).map(s => {
    const p = s.split(/[\s,]+/);
    return { t: parseFloat(p[0]) || 0, line: p[1], agv: p[2] || null };
  }).filter(r => r.line);
}

function updateDispatchPanel() {
  const panel = document.getElementById('dispatchPanel');
  const body  = document.getElementById('dispatchBody');
  if (!panel || !body) return;
  panel.style.display = 'block';
  body.innerHTML = '';

  // Enable toggle
  const head = document.createElement('label');
  head.className = 'dispatch-enable';
  const en = document.createElement('input');
  en.type = 'checkbox';
  en.checked = state.dispatch.enabled;
  en.addEventListener('change', () => { state.dispatch.enabled = en.checked; updateDispatchPanel(); });
  head.appendChild(en);
  head.appendChild(document.createTextNode(' Enable dispatch mode'));
  body.appendChild(head);
  if (!state.dispatch.enabled) return;

  // Per seq_point role assignment
  const seqIds = Object.keys(state.nodes).filter(id => state.nodes[id].type === 'seq_point');
  seqIds.forEach(id => {
    const row = document.createElement('div');
    row.className = 'dispatch-row';
    const role = nodeDispatchRole(id);
    const slotIdx = state.dispatch.homeSlots.indexOf(id);
    const tag = role === 'home' ? ` [slot ${slotIdx + 1}]`
              : role === 'line' ? ` [${state.dispatch.lines.find(l => l.node === id).id}]` : '';

    const name = document.createElement('span');
    name.className = 'dispatch-name';
    name.textContent = id + tag;
    row.appendChild(name);

    const sel = document.createElement('select');
    ['none', 'home', 'line'].forEach(r => {
      const o = document.createElement('option');
      o.value = r; o.textContent = r; if (r === role) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => setNodeDispatchRole(id, sel.value));
    row.appendChild(sel);

    if (role === 'line') {
      const line = state.dispatch.lines.find(l => l.node === id);
      const st = document.createElement('input');
      st.type = 'number'; st.min = '0'; st.step = '0.5'; st.value = line.serviceTime;
      st.title = 'service time (s)'; st.className = 'dispatch-st';
      st.addEventListener('change', () => { line.serviceTime = parseFloat(st.value) || 0; });
      st.addEventListener('keydown', e => e.stopPropagation());
      row.appendChild(st);
    }
    body.appendChild(row);
  });

  // Requests timeline
  const reqLbl = document.createElement('div');
  reqLbl.className = 'dispatch-sub';
  reqLbl.textContent = 'Requests  (t  LINE-X  [AGV-0N])';
  body.appendChild(reqLbl);
  const ta = document.createElement('textarea');
  ta.className = 'dispatch-ta';
  ta.rows = 4;
  ta.value = state.dispatch.requests.map(r => `${r.t} ${r.line}${r.agv ? ' ' + r.agv : ''}`).join('\n');
  ta.placeholder = '1 LINE-A\n2 LINE-B AGV-01';
  ta.addEventListener('change', () => { state.dispatch.requests = parseRequestsText(ta.value); });
  ta.addEventListener('keydown', e => e.stopPropagation());
  body.appendChild(ta);

  // Auto-generate
  const ag = state.dispatch.autoGenerate;
  const agRow = document.createElement('label');
  agRow.className = 'dispatch-enable';
  const agc = document.createElement('input');
  agc.type = 'checkbox'; agc.checked = ag.enabled;
  agc.addEventListener('change', () => { ag.enabled = agc.checked; });
  agRow.appendChild(agc);
  agRow.appendChild(document.createTextNode(' Auto-generate (seed/interval)'));
  body.appendChild(agRow);

  const agParams = document.createElement('div');
  agParams.className = 'dispatch-row';
  const iv = document.createElement('input');
  iv.type = 'number'; iv.min = '1'; iv.step = '1'; iv.value = ag.meanInterval; iv.title = 'mean interval (s)'; iv.className = 'dispatch-st';
  iv.addEventListener('change', () => { ag.meanInterval = parseFloat(iv.value) || 6; });
  iv.addEventListener('keydown', e => e.stopPropagation());
  const sd = document.createElement('input');
  sd.type = 'number'; sd.step = '1'; sd.value = ag.seed; sd.title = 'seed'; sd.className = 'dispatch-st';
  sd.addEventListener('change', () => { ag.seed = parseInt(sd.value, 10) || 0; });
  sd.addEventListener('keydown', e => e.stopPropagation());
  agParams.appendChild(iv);
  agParams.appendChild(sd);
  body.appendChild(agParams);
}

// ── Track helpers ─────────────────────────────────────────────────────────

function findTrackPtAt(sx, sy) {
  let bestId = null, bestDist = 14;
  for (const [id, pt] of Object.entries(state.track.points)) {
    const { sx: tx, sy: ty } = imgToScreen(pt.x, pt.y, state.view);
    const d = Math.hypot(sx - tx, sy - ty);
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  return bestId;
}

function connectTrackPoints(fromId, toId) {
  const dup = state.track.segments.some(
    s => (s.from === fromId && s.to === toId) || (s.from === toId && s.to === fromId)
  );
  if (dup) return;
  const segId = `S-${String(state.trackSegN).padStart(2, '0')}`;
  state.trackSegN++;
  const seg = { id: segId, from: fromId, to: toId, type: state.trackArc ? 'arc' : 'straight' };
  if (state.trackArc) { seg.radius = state.trackR; seg.clockwise = state.trackCW; }
  state.track.segments.push(seg);
  state.trackLastSeg = segId;
  updateTrackBar();
}

function updateTrackBar() {
  trackBar.style.display = state.mode === 'TRACK' ? 'flex' : 'none';
  trackStraightBtn.classList.toggle('active', !state.trackArc);
  trackArcBtn.classList.toggle('active',  state.trackArc);
  trackArcControls.style.display = state.trackArc ? 'flex' : 'none';
  if (state.trackArc) {
    trackRadiusInput.value = state.trackR;
    trackCwBtn.classList.toggle('active',  state.trackCW);
    trackCcwBtn.classList.toggle('active', !state.trackCW);
  }
  const nPts  = Object.keys(state.track.points).length;
  const nSegs = state.track.segments.length;
  trackInfoEl.textContent = `${nPts} pts · ${nSegs} segs`;
}

// Wire up trackBar buttons
trackStraightBtn.addEventListener('click', () => { state.trackArc = false; updateTrackBar(); });
trackArcBtn.addEventListener('click',      () => { state.trackArc = true;  updateTrackBar(); });
trackCwBtn.addEventListener('click',  () => { state.trackCW = true;  updateLastArcSeg(); updateTrackBar(); });
trackCcwBtn.addEventListener('click', () => { state.trackCW = false; updateLastArcSeg(); updateTrackBar(); });

trackRadiusInput.addEventListener('change', () => {
  const v = parseFloat(trackRadiusInput.value);
  if (!isFinite(v) || v < 10) return;
  state.trackR = v;
  updateLastArcSeg();
});
trackRadiusInput.addEventListener('keydown', (e) => e.stopPropagation());

function updateLastArcSeg() {
  if (!state.trackLastSeg) return;
  const seg = state.track.segments.find(s => s.id === state.trackLastSeg);
  if (seg && seg.type === 'arc') {
    seg.radius    = state.trackR;
    seg.clockwise = state.trackCW;
  }
}

// ── Save JSON ─────────────────────────────────────────────────────────────

function saveJSON() {
  const agvsData = state.agvs.map(a => ({ id: a.id, color: a.color, sequence: a.sequence }));
  const data = { NODES: state.nodes, AGVS: agvsData };
  if (state.agvs.length === 1) data.SEQUENCE = state.agvs[0].sequence;
  if (state.track.segments.length > 0 || Object.keys(state.track.points).length > 0)
    data.TRACK = state.track;
  if (state.dispatch.enabled) {
    const d = state.dispatch;
    data.DISPATCH = {
      home:         d.homeSlots[0] || null,
      homeSlots:    d.homeSlots.slice(),
      lines:        d.lines.map(l => ({ id: l.id, node: l.node,
                      serviceAction: l.serviceAction, serviceTime: l.serviceTime })),
      requests:     d.requests.slice(),
      autoGenerate: { ...d.autoGenerate },
    };
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = state.outputFilename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Draw loop ─────────────────────────────────────────────────────────────

function drawLoop() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = window.innerWidth, ch = window.innerHeight;

  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, cw, ch);

  // Background image
  if (state.bgImage) {
    const { sx, sy } = imgToScreen(0, 0, state.view);
    ctx.drawImage(state.bgImage, sx, sy, state.imgW * state.view.zoom, state.imgH * state.view.zoom);
    drawGrid(ctx, state.imgW, state.imgH, state.view);
  }

  // ── Magnetic track ──────────────────────────────────────────────────────
  // Segments
  for (const seg of state.track.segments) {
    const ptA = state.track.points[seg.from];
    const ptB = state.track.points[seg.to];
    if (!ptA || !ptB) continue;
    const isLastSeg = seg.id === state.trackLastSeg;
    strokeTrackSegment(ctx, ptA, ptB, seg, state.view);
    ctx.strokeStyle = isLastSeg ? '#1a40e0' : TRACK_COLOR;
    ctx.lineWidth   = 4;
    ctx.lineCap     = 'round';
    ctx.stroke();
  }
  // Track points
  for (const [id, pt] of Object.entries(state.track.points)) {
    const { sx, sy } = imgToScreen(pt.x, pt.y, state.view);
    const isSel = id === state.trackSel;
    if (isSel) {
      ctx.beginPath();
      ctx.arc(sx, sy, 11, 0, Math.PI * 2);
      ctx.strokeStyle = TRACK_COLOR; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.save();
    ctx.translate(sx, sy); ctx.rotate(Math.PI / 4);
    ctx.beginPath(); ctx.rect(-5, -5, 10, 10);
    ctx.fillStyle   = isSel ? '#1a40e0' : TRACK_COLOR;
    ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
    if (state.mode === 'TRACK') {
      ctx.fillStyle = '#1a40a0'; ctx.font = '10px monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(id, sx + 9, sy);
    }
  }
  // Preview line from selected TP to cursor
  if (state.mode === 'TRACK' && state.trackSel) {
    const sp = state.track.points[state.trackSel];
    if (sp) {
      const { sx, sy } = imgToScreen(sp.x, sp.y, state.view);
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(sx, sy);
      ctx.lineTo(state.mouseScreen.sx, state.mouseScreen.sy);
      ctx.strokeStyle = 'rgba(48,96,208,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Path lines for all AGVs — load-state colors + per-AGV color (Features 1 & 2)
  state.agvs.forEach((agv, agvIdx) => {
    const isActive = agvIdx === state.activeAgvIdx;
    const seq = agv.sequence.filter(e => state.nodes[e.node]);
    if (seq.length < 2) return;
    let carrying = false;
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i].action;
      if (a === 'pickup')   carrying = true;
      if (a === 'release')  carrying = false;
      if (a === 'exchange') carrying = true;
      const ptA = state.nodes[seq[i].node];
      const ptB = state.nodes[seq[i + 1].node];
      const { sx: ax, sy: ay } = imgToScreen(ptA.x, ptA.y, state.view);
      const { sx: bx, sy: by } = imgToScreen(ptB.x, ptB.y, state.view);
      const alpha = isActive ? 1.0 : 0.4;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.strokeStyle = carrying
        ? hexToRgba(agv.color, 0.85 * alpha)
        : hexToRgba(agv.color, 0.5  * alpha);
      ctx.lineWidth   = carrying ? 3 : 2;
      ctx.setLineDash(carrying ? [] : [6, 4]);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Step labels + heading arrows for this AGV
    seq.forEach(({ node, heading }, i) => {
      const pt = state.nodes[node];
      const { sx, sy } = imgToScreen(pt.x, pt.y, state.view);
      const alpha = isActive ? 1.0 : 0.4;
      ctx.fillStyle    = hexToRgba(agv.color, alpha);
      ctx.font         = '11px monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(i), sx + DOT_RADIUS + 1, sy - 2);
      if (heading !== undefined) {
        drawHeadingArrow(ctx, sx, sy, heading, 18, hexToRgba(agv.color, alpha), 1.5);
      }
    });
  });

  // Nodes
  for (const [id, pt] of Object.entries(state.nodes)) {
    const { sx, sy } = imgToScreen(pt.x, pt.y, state.view);
    const col = dotColorForType(pt.type);

    if (state.mode === 'SEQUENCE') {
      if (activeSeq().some(e => e.node === id)) {
        ctx.beginPath();
        ctx.arc(sx, sy, DOT_RADIUS + 5, 0, Math.PI * 2);
        ctx.strokeStyle = activeAgv().color; ctx.lineWidth = 1.5; ctx.stroke();
      }
      if (id === state.hoveredNode) {
        ctx.beginPath();
        ctx.arc(sx, sy, DOT_RADIUS + 9, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }

    ctx.beginPath();
    ctx.arc(sx, sy, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();

    ctx.fillStyle    = '#1a1a2a';
    ctx.font         = 'bold 11px monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${id} (${pt.x},${pt.y})`, sx + DOT_RADIUS + 3, sy);
  }

  // Radial menu
  if (radial.active) {
    if (radial.phase === 'type_select')  drawTypeSelectRadial();
    if (radial.phase === 'angle_select') drawAngleSelectRadial();
  }

  // Crosshair (NODE/TRACK mode, no radial)
  if ((state.mode === 'NODE' || state.mode === 'TRACK') && !radial.active && !startupModal.open) {
    ctx.strokeStyle = 'rgba(200,40,40,0.5)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(state.mouseScreen.sx, 0); ctx.lineTo(state.mouseScreen.sx, ch); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, state.mouseScreen.sy); ctx.lineTo(cw, state.mouseScreen.sy); ctx.stroke();
  }

  drawHeadingLegend(ctx, cw);
  requestAnimationFrame(drawLoop);
}
