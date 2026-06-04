// animplayer.js — AGV animation player (multi-AGV, Feature 2)

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

const BAR_TOP    = 44;
const BAR_BOTTOM = 48;

const AGV_SIZE   = 30;
const TROLLEY_W  = 28;
const TROLLEY_H  = 18;

const ACTION_COLORS = {
  pickup:   '#50DC78',
  release:  '#F4A261',
  exchange: '#50C8FF',
};

// ── Application state ─────────────────────────────────────────────────────

const state = {
  nodes:   {},
  agvs:    [],
  track:   { points: {}, segments: [] },
  view:    { offsetX: 0, offsetY: 0, zoom: 1 },
  bgImage: null,
  imgW:    0,
  imgH:    0,

  playing:        false,
  timeScale:      1,
  agvSpeed:       120,
  actionDuration: 1.5,
  showGrid:       true,
  showLabels:     true,

  isPanning:    false,
  panStart:     { sx: 0, sy: 0 },
  panViewStart: { offsetX: 0, offsetY: 0 },
  mouse:        { sx: 0, sy: 0 },

  lastTimestamp: null,
  elapsed:       0,
};

// ── Walker architecture ───────────────────────────────────────────────────

function makeWalker(agvDef) {
  return {
    id:             agvDef.id    || 'AGV-01',
    color:          agvDef.color || AGV_COLORS[0],
    sequence:       agvDef.sequence || [],
    currentStep:    0,
    agvPos:         { x: 0, y: 0 },
    agvHeading:     0,
    trolleyState:   'empty',
    trolleyPos:     null,
    phase:          'idle',   // 'idle' | 'action_pause' | 'moving' | 'done' | 'parked'
    actionTimer:    0,
    trackPath:      [],   // track point IDs to follow to next sequence node
    trackPathIdx:   0,
    currentTrackPt: null,
    job:            null, // dispatch mode: current line id being served, or null
    homeSlot:       null, // dispatch mode: node id of this AGV's parking spot
    waiting:        false,// dispatch mode: held by a track reservation ahead
  };
}

// Set up track routing for a walker to move from its current track point toward
// w.sequence[w.currentStep], then switch it into the 'moving' phase. Shared by
// the action_pause→moving transition and by the dispatch engine when it hands a
// walker a fresh job.
function routeWalkerToStep(w) {
  const nextNode = state.nodes[w.sequence[w.currentStep]?.node];
  const fromTP   = w.currentTrackPt;
  const toTP     = nextNode?.trackPoint || null;
  if (fromTP && toTP && state.track.segments.length > 0) {
    const route = routeOnTrack(fromTP, toTP);
    w.trackPath = route ? route.slice(1) : [];
  } else {
    w.trackPath = [];
  }
  w.trackPathIdx = 0;
  w.phase        = 'moving';
  w.actionTimer  = 0;
}

function actionDurationFor(seqE) {
  if (seqE.dwell !== undefined) return seqE.dwell;
  const action = seqE.action;
  if (action === 'move')     return 0;
  if (action === 'exchange') return state.actionDuration * 2;
  return state.actionDuration;
}

function applyActionEffect(action, nodePos, w) {
  switch (action) {
    case 'pickup':
      w.trolleyState = 'carrying';
      w.trolleyPos   = null;
      break;
    case 'release':
      w.trolleyState = 'empty';
      w.trolleyPos   = { x: nodePos.x, y: nodePos.y, heading: w.agvHeading };
      break;
    case 'exchange':
      w.trolleyPos   = { x: nodePos.x, y: nodePos.y, heading: w.agvHeading };
      w.trolleyState = 'carrying';
      break;
    default:
      break;
  }
}

function resetWalker(w) {
  if (w.sequence.length === 0) { w.phase = 'idle'; return; }
  const startNodeId = w.sequence[0].node;
  const startPt     = state.nodes[startNodeId];
  if (!startPt) { w.phase = 'idle'; return; }

  w.currentStep    = 0;
  w.agvPos         = { x: startPt.x, y: startPt.y };
  w.agvHeading     = w.sequence[0]?.heading ?? 0;
  w.trolleyState   = 'empty';
  w.trolleyPos     = null;
  w.phase          = 'action_pause';
  w.actionTimer    = 0;
  w.trackPath      = [];
  w.trackPathIdx   = 0;
  w.currentTrackPt = startPt.trackPoint || null;
  w.job            = null;
  w.waiting        = false;
}

function resetAllWalkers() {
  if (Dispatch.isActive()) { Dispatch.reset(); state.elapsed = 0; return; }
  state.agvs.forEach(w => resetWalker(w));
  state.elapsed = 0;
}

function updateWalker(w, dt) {
  if (w.phase === 'idle' || w.phase === 'done' || w.phase === 'parked') return;

  if (w.phase === 'action_pause') {
    const seqE     = w.sequence[w.currentStep];
    const action   = seqE.action;
    const duration = actionDurationFor(seqE);
    w.actionTimer += dt;

    if (w.actionTimer >= duration) {
      const nodePt = state.nodes[seqE.node];
      if (nodePt) applyActionEffect(action, nodePt, w);

      w.currentStep++;
      if (w.currentStep >= w.sequence.length) { w.phase = 'done'; return; }

      // Initialise track routing for this move segment
      const prevNode = state.nodes[w.sequence[w.currentStep - 1].node];
      w.currentTrackPt = prevNode?.trackPoint || w.currentTrackPt;
      routeWalkerToStep(w);
    }
    return;
  }

  if (w.phase === 'moving') {
    const targetNode = state.nodes[w.sequence[w.currentStep].node];
    if (!targetNode) { w.phase = 'done'; return; }

    // Determine immediate sub-target: next track point or final node
    const hasTrackWaypoint = w.trackPath.length > 0 && w.trackPathIdx < w.trackPath.length;
    const nextTpId    = hasTrackWaypoint ? w.trackPath[w.trackPathIdx] : null;

    // Real queueing: in dispatch mode an AGV must reserve the next track point
    // before entering it. If another AGV holds it, hold position and wait.
    if (Dispatch.isActive() && nextTpId) {
      if (!Dispatch.tryReserve(nextTpId, w.id)) { w.waiting = true; return; }
    }
    w.waiting = false;

    const movingToPos = hasTrackWaypoint
      ? state.track.points[nextTpId]
      : targetNode;
    if (!movingToPos) { w.phase = 'done'; return; }

    const path   = [{ x: w.agvPos.x, y: w.agvPos.y }, movingToPos];
    const result = advanceAlongPath(w.agvPos, path, 1, state.agvSpeed, dt);

    const dx = movingToPos.x - w.agvPos.x;
    const dy = movingToPos.y - w.agvPos.y;
    if (Math.hypot(dx, dy) > 0.5) {
      const targetHeading = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
      let diff = targetHeading - w.agvHeading;
      if (diff >  180) diff -= 360;
      if (diff < -180) diff += 360;
      const maxTurn = 300 * dt;
      w.agvHeading += Math.max(-maxTurn, Math.min(maxTurn, diff));
      w.agvHeading  = ((w.agvHeading % 360) + 360) % 360;
    }

    w.agvPos = result.pos;

    if (result.targetIdx >= path.length) {
      w.agvPos = { x: movingToPos.x, y: movingToPos.y };
      if (hasTrackWaypoint) {
        // Reached the next track point: release the one behind, keep this one.
        if (Dispatch.isActive()) Dispatch.release(w.currentTrackPt, w.id);
        w.currentTrackPt = nextTpId;
        w.trackPathIdx++;
      } else {
        // Arrived at destination node
        const entryHeading = w.sequence[w.currentStep]?.heading;
        if (entryHeading !== undefined) w.agvHeading = entryHeading;
        if (targetNode.trackPoint) w.currentTrackPt = targetNode.trackPoint;
        w.phase       = 'action_pause';
        w.actionTimer = 0;
      }
    }
  }
}

function updateAllWalkers(dt) {
  state.agvs.forEach(w => {
    if (w.phase !== 'idle' && w.phase !== 'done' && w.phase !== 'parked') updateWalker(w, dt);
  });
}

function allDone() {
  return state.agvs.length > 0
    && state.agvs.every(w => w.phase === 'done' || w.phase === 'idle');
}

// ── Conflict detection ────────────────────────────────────────────────────

function detectConflicts() {
  const conflicting = new Set();
  for (let i = 0; i < state.agvs.length; i++) {
    const wi = state.agvs[i];
    if (wi.phase === 'idle' || wi.phase === 'done' || wi.phase === 'parked') continue;
    for (let j = i + 1; j < state.agvs.length; j++) {
      const wj = state.agvs[j];
      if (wj.phase === 'idle' || wj.phase === 'done' || wj.phase === 'parked') continue;

      const niId = wi.sequence[wi.currentStep]?.node;
      const njId = wj.sequence[wj.currentStep]?.node;
      const sameNode = niId && njId && niId === njId
        && wi.phase === 'action_pause' && wj.phase === 'action_pause';

      const dist = Math.hypot(wi.agvPos.x - wj.agvPos.x, wi.agvPos.y - wj.agvPos.y)
        * state.view.zoom;

      if (sameNode || dist < AGV_SIZE * 2) {
        conflicting.add(i);
        conflicting.add(j);
      }
    }
  }
  return conflicting;
}

// ── Track routing ─────────────────────────────────────────────────────────

function buildTrackAdjacency() {
  const adj = new Map();
  for (const seg of state.track.segments) {
    if (!adj.has(seg.from)) adj.set(seg.from, []);
    if (!adj.has(seg.to))   adj.set(seg.to,   []);
    adj.get(seg.from).push(seg.to);
    adj.get(seg.to).push(seg.from);
  }
  return adj;
}

function routeOnTrack(fromId, toId) {
  if (fromId === toId) return [fromId];
  const adj     = buildTrackAdjacency();
  const visited = new Set([fromId]);
  const queue   = [[fromId]];
  while (queue.length > 0) {
    const path = queue.shift();
    const cur  = path[path.length - 1];
    for (const nb of (adj.get(cur) || [])) {
      if (nb === toId) return [...path, toId];
      if (!visited.has(nb)) { visited.add(nb); queue.push([...path, nb]); }
    }
  }
  return null;
}

// ── Canvas resize ─────────────────────────────────────────────────────────

function resizeCanvas() {
  const dpr  = window.devicePixelRatio || 1;
  const cssW = window.innerWidth;
  const cssH = window.innerHeight - BAR_TOP - BAR_BOTTOM;
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width     = cssW + 'px';
  canvas.style.height    = cssH + 'px';
  canvas.style.marginTop = `${BAR_TOP}px`;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── File loading ──────────────────────────────────────────────────────────

function fitImageToCanvas() {
  const cssW = window.innerWidth;
  const cssH = window.innerHeight - BAR_TOP - BAR_BOTTOM;
  const z = Math.min(cssW / state.imgW, cssH / state.imgH) * 0.9;
  state.view.zoom    = z;
  state.view.offsetX = cssW / 2 - state.imgW * z / 2;
  state.view.offsetY = cssH / 2 - state.imgH * z / 2;
}

document.getElementById('loadJson').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data  = JSON.parse(ev.target.result);
      state.nodes = data.NODES || {};
      state.track = normaliseTrack(data.TRACK);
      state.agvs  = normaliseAGVS(data).map(agvDef => makeWalker(agvDef));
      if (state.agvs.length === 0)
        state.agvs = [makeWalker({ id: 'AGV-01', color: AGV_COLORS[0], sequence: [] })];
      const isDispatch = Dispatch.init(data);
      const totalSteps = state.agvs.reduce((s, w) => s + w.sequence.length, 0);
      document.getElementById('loadStatus').textContent = isDispatch
        ? `${file.name} — ${Object.keys(state.nodes).length} nodes · ${state.agvs.length} AGV(s) · ${Dispatch.lineIds().length} lines · DISPATCH`
        : `${file.name} — ${Object.keys(state.nodes).length} nodes · ${state.agvs.length} AGV(s) · ${totalSteps} steps`;
      state.playing = false;
      updatePlayButton();
      buildDispatchControls();
      resetAllWalkers();
      updateStatusBadge();
      updateStepCounter();
    } catch { alert('Invalid JSON file.'); }
  };
  reader.readAsText(file);
});

document.getElementById('loadImg').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.bgImage = img;
    state.imgW    = img.naturalWidth;
    state.imgH    = img.naturalHeight;
    fitImageToCanvas();
    URL.revokeObjectURL(url);
  };
  img.src = url;
});

// ── Player controls ───────────────────────────────────────────────────────

const btnPlayPause = document.getElementById('btnPlayPause');
const btnRestart   = document.getElementById('btnRestart');
const statusBadge  = document.getElementById('statusBadge');
const stepCounter  = document.getElementById('stepCounter');

function updatePlayButton() {
  btnPlayPause.textContent = state.playing ? '⏸ Pause' : '▶ Play';
  btnPlayPause.className   = state.playing ? 'active' : '';
}

function updateStatusBadge() {
  if (state.agvs.length === 0 || state.agvs.every(w => w.phase === 'idle')) {
    statusBadge.textContent = 'IDLE';
    statusBadge.className   = 'status-idle';
    return;
  }
  if (allDone()) {
    statusBadge.textContent = 'DONE';
    statusBadge.className   = 'status-done';
    return;
  }
  const anyMoving = state.agvs.some(w => w.phase === 'moving');
  statusBadge.textContent = anyMoving ? 'MOVING' : 'ACTIVE';
  statusBadge.className   = anyMoving ? 'status-moving' : 'status-pickup';
}

function updateStepCounter() {
  if (Dispatch.isActive()) {
    const home = state.agvs.filter(w => w.phase === 'parked').length;
    stepCounter.textContent = `queue ${Dispatch.queueLength()} · ${home}/${state.agvs.length} home`;
    return;
  }
  if (state.agvs.length === 1) {
    const w = state.agvs[0];
    stepCounter.textContent = `step ${w.currentStep} / ${w.sequence.length}`;
  } else {
    const done = state.agvs.filter(w => w.phase === 'done').length;
    stepCounter.textContent = `${done} / ${state.agvs.length} AGVs done`;
  }
}

// Build the per-line "Call" buttons + auto-generate toggle from the loaded
// dispatch layout. Hidden entirely in scripted mode.
function buildDispatchControls() {
  const wrap = document.getElementById('dispatchControls');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!Dispatch.isActive()) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';

  const label = document.createElement('label');
  label.textContent = 'Call';
  wrap.appendChild(label);

  Dispatch.lineIds().forEach(id => {
    const btn = document.createElement('button');
    btn.textContent = id;
    btn.className   = 'call-btn';
    btn.addEventListener('click', () => {
      Dispatch.enqueue({ line: id });
      if (!state.playing) { state.playing = true; updatePlayButton(); }
    });
    wrap.appendChild(btn);
  });

  const autoWrap = document.createElement('label');
  autoWrap.style.marginLeft = '6px';
  const auto = document.createElement('input');
  auto.type    = 'checkbox';
  auto.checked = dispatch.autoGenerate.enabled;
  auto.addEventListener('change', (e) => {
    dispatch.autoGenerate.enabled = e.target.checked;
    if (e.target.checked) dispatch.nextGenTime = Dispatch._nextInterval();
  });
  autoWrap.appendChild(auto);
  autoWrap.appendChild(document.createTextNode(' Auto'));
  wrap.appendChild(autoWrap);
}

btnPlayPause.addEventListener('click', () => {
  if (!Dispatch.isActive() && state.agvs.every(w => w.sequence.length === 0)) return;
  if (!Dispatch.isActive() && allDone()) resetAllWalkers();
  state.playing = !state.playing;
  updatePlayButton();
});

btnRestart.addEventListener('click', () => {
  resetAllWalkers();
  state.playing = false;
  updatePlayButton();
  updateStatusBadge();
  updateStepCounter();
});

document.getElementById('speedSelect').addEventListener('change', (e) => {
  state.timeScale = parseFloat(e.target.value);
});

document.getElementById('agvSpeedInput').addEventListener('change', (e) => {
  state.agvSpeed = Math.max(1, parseFloat(e.target.value) || 120);
});

document.getElementById('actionDurInput').addEventListener('change', (e) => {
  state.actionDuration = Math.max(0, parseFloat(e.target.value) || 1.5);
});

document.getElementById('showGrid').addEventListener('change', (e) => {
  state.showGrid = e.target.checked;
});

document.getElementById('showLabels').addEventListener('change', (e) => {
  state.showLabels = e.target.checked;
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    btnPlayPause.click();
  }
});

// ── Video recording (MediaRecorder) ───────────────────────────────────────

const rec = {
  active:   false,
  recorder: null,
  chunks:   [],
};

const btnRecord = document.getElementById('btnRecord');

function updateRecordButton() {
  btnRecord.textContent = rec.active ? '⏹ Stop' : '⏺ Record';
  btnRecord.className   = rec.active ? 'recording' : '';
}

btnRecord.addEventListener('click', () => {
  if (rec.active) stopRecording(); else startRecording();
});

function startRecording() {
  if (!canvas.captureStream) {
    alert('Video recording is not supported in this browser.\nPlease use Chrome or Edge.');
    return;
  }
  if (!Dispatch.isActive() && state.agvs.every(w => w.sequence.length === 0)) {
    alert('Load a layout JSON file first.');
    return;
  }

  resetAllWalkers();
  state.playing = true;
  updatePlayButton();
  updateStatusBadge();
  updateStepCounter();

  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

  const stream = canvas.captureStream(30);
  rec.recorder = new MediaRecorder(stream, { mimeType });
  rec.chunks   = [];

  rec.recorder.ondataavailable = (e) => {
    if (e.data.size > 0) rec.chunks.push(e.data);
  };

  rec.recorder.onstop = () => {
    const blob = new Blob(rec.chunks, { type: 'video/webm' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'agv_simulation.webm';
    a.click();
    URL.revokeObjectURL(url);
    rec.active = false;
    updateRecordButton();
  };

  rec.recorder.start(100);
  rec.active = true;
  updateRecordButton();
}

function stopRecording() {
  if (!rec.active || !rec.recorder) return;
  rec.recorder.stop();
}

// ── Pan + zoom ────────────────────────────────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    e.preventDefault();
    state.isPanning    = true;
    state.panStart     = { sx: e.clientX, sy: e.clientY };
    state.panViewStart = { offsetX: state.view.offsetX, offsetY: state.view.offsetY };
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button === 1) state.isPanning = false;
});

canvas.addEventListener('mousemove', (e) => {
  state.mouse.sx = e.clientX;
  state.mouse.sy = e.clientY - BAR_TOP;
  if (state.isPanning) {
    state.view.offsetX = state.panViewStart.offsetX + (e.clientX - state.panStart.sx);
    state.view.offsetY = state.panViewStart.offsetY + (e.clientY - state.panStart.sy);
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor  = e.deltaY < 0 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP;
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.view.zoom * factor));
  const { ix, iy } = screenToImg(state.mouse.sx, state.mouse.sy, state.view);
  state.view.zoom    = newZoom;
  state.view.offsetX = state.mouse.sx - ix * newZoom;
  state.view.offsetY = state.mouse.sy - iy * newZoom;
}, { passive: false });

// ── Drawing ───────────────────────────────────────────────────────────────

function drawRoundRect(x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill)   { ctx.fillStyle = fill;   ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
}

function drawActionIndicator(sx, sy, action, progress, label) {
  const col = ACTION_COLORS[action];
  if (!col) return;

  const startAngle = -Math.PI / 2;
  const endAngle   = startAngle + 2 * Math.PI * Math.min(progress, 1);
  ctx.beginPath();
  ctx.arc(sx, sy, AGV_SIZE / 2 + 10, startAngle, endAngle);
  ctx.strokeStyle = col;
  ctx.lineWidth   = 3;
  ctx.lineCap     = 'round';
  ctx.stroke();

  ctx.fillStyle    = col;
  ctx.font         = 'bold 11px monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(action.toUpperCase(), sx, sy - AGV_SIZE / 2 - 14);

  if (label) {
    ctx.font      = '10px monospace';
    ctx.fillStyle = col;
    ctx.fillText(label.toUpperCase(), sx, sy - AGV_SIZE / 2 - 3);
  }
}

function drawDwellAnnotation(sx, sy, label, progress) {
  const col = '#4080e0';
  const startAngle = -Math.PI / 2;
  const endAngle   = startAngle + 2 * Math.PI * Math.min(progress, 1);
  ctx.beginPath();
  ctx.arc(sx, sy, AGV_SIZE / 2 + 10, startAngle, endAngle);
  ctx.strokeStyle = col;
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'round';
  ctx.stroke();

  ctx.fillStyle    = col;
  ctx.font         = '10px monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label.toUpperCase(), sx, sy - AGV_SIZE / 2 - 14);
}

function drawPerson(sx, sy, heading) {
  const perpAngle = ((heading + 90) * Math.PI) / 180;
  const offset    = AGV_SIZE + 18;
  const px = sx + offset * Math.cos(perpAngle);
  const py = sy + offset * Math.sin(perpAngle);

  ctx.save();
  ctx.strokeStyle = '#2060c0';
  ctx.fillStyle   = '#2060c0';
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  ctx.beginPath();
  ctx.arc(px, py - 12, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(px, py - 7); ctx.lineTo(px, py + 3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px - 7, py - 3); ctx.lineTo(px + 7, py - 3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px, py + 3); ctx.lineTo(px - 5, py + 13);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px, py + 3); ctx.lineTo(px + 5, py + 13);
  ctx.stroke();

  ctx.restore();
}

function drawTrolley(sx, sy, heading, attached) {
  const w = attached ? 22 : TROLLEY_W;
  const h = attached ? 14 : TROLLEY_H;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(heading * Math.PI / 180);
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, 3);
  ctx.fillStyle   = '#F4A261';
  ctx.fill();
  ctx.strokeStyle = '#c07830';
  ctx.lineWidth   = 2;
  ctx.stroke();
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(s * (w / 2 - 4), h / 2 - 2, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#804820';
    ctx.fill();
  }
  ctx.restore();
}

function drawAGV(sx, sy, heading, color = '#E63946') {
  const half = AGV_SIZE / 2;
  drawRoundRect(sx - half, sy - half, AGV_SIZE, AGV_SIZE, 4, color, '#ffffff');
  drawHeadingArrow(ctx, sx, sy, heading, 16, '#ffffff', 2);
}

function drawActivePulse(sx, sy, t) {
  const r = DOT_RADIUS + 6 + 3 * Math.sin(t * 5);
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
}

function drawScene(timestamp) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = window.innerWidth;
  const ch = window.innerHeight - BAR_TOP - BAR_BOTTOM;

  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, cw, ch);

  if (state.bgImage) {
    const { sx, sy } = imgToScreen(0, 0, state.view);
    ctx.drawImage(state.bgImage, sx, sy, state.imgW * state.view.zoom, state.imgH * state.view.zoom);
  }

  if (state.showGrid && state.imgW) {
    drawGrid(ctx, state.imgW, state.imgH, state.view);
  }

  // ── Magnetic track ──────────────────────────────────────────────────────
  if (state.track.segments.length > 0) {
    // Track segments
    for (const seg of state.track.segments) {
      const ptA = state.track.points[seg.from];
      const ptB = state.track.points[seg.to];
      if (!ptA || !ptB) continue;
      strokeTrackSegment(ctx, ptA, ptB, seg, state.view);
      ctx.strokeStyle = 'rgba(48,80,200,0.55)';
      ctx.lineWidth   = 6;
      ctx.lineCap     = 'round';
      ctx.stroke();
    }
    // Track junction diamonds
    for (const pt of Object.values(state.track.points)) {
      const { sx, sy } = imgToScreen(pt.x, pt.y, state.view);
      ctx.save();
      ctx.translate(sx, sy); ctx.rotate(Math.PI / 4);
      ctx.beginPath(); ctx.rect(-4, -4, 8, 8);
      ctx.fillStyle = 'rgba(48,80,200,0.65)'; ctx.fill();
      ctx.restore();
    }
  }

  // Path lines per AGV — load-state color + AGV color (Features 1 & 2)
  state.agvs.forEach(agv => {
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
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.strokeStyle = carrying ? hexToRgba(agv.color, 0.75) : hexToRgba(agv.color, 0.35);
      ctx.lineWidth   = carrying ? 3 : 2;
      ctx.setLineDash(carrying ? [] : [6, 4]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  });

  // Collect active target nodes from all walkers for pulse
  const activeTargetIds = new Set(
    state.agvs
      .filter(w => w.phase === 'moving' && w.sequence[w.currentStep])
      .map(w => w.sequence[w.currentStep].node)
  );

  // Node dots
  for (const [id, pt] of Object.entries(state.nodes)) {
    const { sx, sy } = imgToScreen(pt.x, pt.y, state.view);
    const col = dotColorForType(pt.type);

    if (activeTargetIds.has(id)) drawActivePulse(sx, sy, state.elapsed);

    ctx.beginPath();
    ctx.arc(sx, sy, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle   = col;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 1;
    ctx.stroke();

    drawHeadingArrow(ctx, sx, sy, pt.heading, 18, col, 1.5);

    if (state.showLabels) {
      ctx.fillStyle    = '#1a1a2a';
      ctx.font         = '10px monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(id, sx + DOT_RADIUS + 3, sy);
    }
  }

  // Sequence step labels per AGV
  if (state.showLabels) {
    state.agvs.forEach(agv => {
      agv.sequence.filter(e => state.nodes[e.node]).forEach(({ node, action }, i) => {
        const pt = state.nodes[node];
        const { sx, sy } = imgToScreen(pt.x, pt.y, state.view);
        ctx.fillStyle    = hexToRgba(agv.color, 0.9);
        ctx.font         = '10px monospace';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${i}:${action[0]}`, sx + DOT_RADIUS + 1, sy - 2);
      });
    });
  }

  const conflicts = detectConflicts();

  // Detached trolleys (all AGVs — drawn before AGV bodies)
  state.agvs.forEach(agv => {
    if (agv.trolleyState === 'empty' && agv.trolleyPos) {
      const { sx, sy } = imgToScreen(agv.trolleyPos.x, agv.trolleyPos.y, state.view);
      drawTrolley(sx, sy, agv.trolleyPos.heading ?? 0, false);
    }
  });

  // Each AGV body, hitch, conflict ring, action indicator
  state.agvs.forEach((agv, idx) => {
    // Skip only truly-idle AGVs. Dispatch AGVs waiting at home are 'parked'
    // (rendered) even though their job sequence is momentarily empty.
    if (agv.phase === 'idle' || (agv.phase !== 'parked' && agv.sequence.length === 0)) return;

    const { sx: ax, sy: ay } = imgToScreen(agv.agvPos.x, agv.agvPos.y, state.view);
    const rad = agv.agvHeading * Math.PI / 180;

    if (agv.trolleyState === 'carrying') {
      const HITCH = AGV_SIZE / 2 + 6 + 7;
      const tx = ax - HITCH * Math.cos(rad);
      const ty = ay - HITCH * Math.sin(rad);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = hexToRgba(agv.color, 0.6);
      ctx.lineWidth   = 2.5;
      ctx.lineCap     = 'round';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tx, ty, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#505060';
      ctx.fill();
      ctx.restore();

      drawTrolley(tx, ty, agv.agvHeading, true);
    }

    drawAGV(ax, ay, agv.agvHeading, agv.color);

    // ID label above AGV when multiple AGVs are present
    if (state.agvs.length > 1) {
      ctx.fillStyle    = agv.color;
      ctx.font         = 'bold 9px monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(agv.id, ax, ay - AGV_SIZE / 2 - 2);
    }

    // Conflict ring (blinking red)
    if (conflicts.has(idx)) {
      const blink = 0.4 + 0.6 * Math.abs(Math.sin(state.elapsed * 4));
      ctx.beginPath();
      ctx.arc(ax, ay, AGV_SIZE / 2 + 16, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(220,30,30,${blink.toFixed(2)})`;
      ctx.lineWidth   = 2.5;
      ctx.stroke();
    }

    // Action indicator (Features 3 & 4)
    if (agv.phase === 'action_pause') {
      const seqE     = agv.sequence[agv.currentStep];
      const action   = seqE?.action;
      const duration = actionDurationFor(seqE || { action: 'move' });
      if (action && duration > 0) {
        const progress = agv.actionTimer / duration;
        if (action !== 'move') {
          drawActionIndicator(ax, ay, action, progress, seqE?.label);
          if (seqE?.mode === 'manual') drawPerson(ax, ay, agv.agvHeading);
        } else {
          drawDwellAnnotation(ax, ay, seqE?.label || 'WAIT', progress);
        }
      }
    }
  });

  drawHUD(cw, ch);
  drawHeadingLegend(ctx, cw);
}

function drawHUD(cw, ch) {
  ctx.save();
  ctx.fillStyle = 'rgba(240,240,248,0.92)';
  ctx.fillRect(0, ch - 22, cw, 22);
  ctx.font         = '11px monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'left';

  const activeWalkers = state.agvs.filter(w => w.phase !== 'idle');
  let x = 10;

  if (activeWalkers.length === 0) {
    ctx.fillStyle = '#9090a8';
    ctx.fillText('No layout loaded', x, ch - 11);
  } else {
    const dispatchActive = Dispatch.isActive();
    activeWalkers.slice(0, 3).forEach((w, i) => {
      if (i > 0) {
        ctx.fillStyle = '#c0c0cc';
        ctx.fillText(' | ', x, ch - 11);
        x += ctx.measureText(' | ').width;
      }
      const phaseLabel = dispatchActive
        ? Dispatch.stateLabel(w)
        : (w.phase === 'action_pause'
            ? (w.sequence[w.currentStep]?.action?.toUpperCase() || 'PAUSE')
            : w.phase.toUpperCase());
      const label = `${w.id}: ${phaseLabel}${dispatchActive && w.job ? ` (${w.job})` : ''}`;
      ctx.fillStyle = w.color;
      ctx.fillText(label, x, ch - 11);
      x += ctx.measureText(label).width;
    });
    if (activeWalkers.length > 3) {
      ctx.fillStyle = '#9090a8';
      const more = ` +${activeWalkers.length - 3} more`;
      ctx.fillText(more, x, ch - 11);
      x += ctx.measureText(more).width;
    }
    if (Dispatch.isActive()) {
      const pend = Dispatch.pendingByLine();
      const perLine = Dispatch.lineIds().map(id => `${id}:${pend[id] || 0}`).join('  ');
      ctx.fillStyle = '#9090a8';
      const qtxt = `   Queue: ${Dispatch.queueLength()}   ${perLine}`;
      ctx.fillText(qtxt, x, ch - 11);
      x += ctx.measureText(qtxt).width;
    }
    ctx.fillStyle = '#9090a8';
    ctx.fillText(`   Speed: ${state.timeScale}×`, x, ch - 11);
  }

  if (rec.active) {
    const blink = Math.sin(Date.now() / 350) > 0;
    ctx.beginPath();
    ctx.arc(cw - 14, ch - 11, 5, 0, Math.PI * 2);
    ctx.fillStyle = blink ? '#cc2222' : 'rgba(204,34,34,0.25)';
    ctx.fill();
    ctx.fillStyle    = '#cc2222';
    ctx.font         = 'bold 11px monospace';
    ctx.textAlign    = 'right';
    ctx.fillText('REC', cw - 22, ch - 11);
  }
  ctx.restore();
}

// ── Main loop ─────────────────────────────────────────────────────────────

function tick(timestamp) {
  if (state.lastTimestamp === null) state.lastTimestamp = timestamp;
  const rawDt = (timestamp - state.lastTimestamp) / 1000;
  state.lastTimestamp = timestamp;

  const dt = Math.min(rawDt, 0.1) * state.timeScale;

  const dispatchActive = Dispatch.isActive();
  const anyActive = state.agvs.some(w => w.phase !== 'idle' && w.phase !== 'done' && w.phase !== 'parked');
  if (state.playing && (anyActive || dispatchActive)) {
    state.elapsed += dt;
    updateAllWalkers(dt);
    if (dispatchActive) Dispatch.update(dt);
    updateStatusBadge();
    updateStepCounter();
    const finished = dispatchActive ? Dispatch.allComplete() : allDone();
    if (finished) {
      state.playing = false;
      updatePlayButton();
      if (rec.active) stopRecording();
    }
  }

  drawScene(timestamp);
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
