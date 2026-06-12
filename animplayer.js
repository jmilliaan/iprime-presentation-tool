// animplayer.js — AGV animation player (multi-AGV, Feature 2)

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

const BAR_TOP    = 44;
const BAR_BOTTOM = 48;

const AGV_SIZE    = 30;
const TROLLEY_LEN = 56;   // along the heading (~2× the old length)
const TROLLEY_WID = 22;   // across
const CALL_BTN_RADIUS = 13;
const FOLLOW_MARGIN   = 10;   // image units — breathing room kept behind the AGV ahead
const LANE_TOL        = AGV_SIZE;   // max perpendicular offset still counted as "same lane"

// Colours for the load-setting action indicator at a stop.
const LOAD_COLORS = {
  none:  '#9aa0a8',
  empty: '#F4A261',
  full:  '#c0392b',
  'attach-empty': '#F4A261',
  'attach-full':  '#c0392b',
  'detach-empty': '#F4A261',
  'detach-full':  '#c0392b',
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
  callPressFx:   [],
};

// ── Walker architecture ───────────────────────────────────────────────────

function makeWalker(agvDef) {
  return {
    id:           agvDef.id    || 'AGV-01',
    color:        agvDef.color || AGV_COLORS[0],
    sequence:     agvDef.sequence || [],
    currentStep:  0,
    agvPos:       { x: 0, y: 0 },
    agvHeading:   0,
    load:         'none',   // 'none' | 'empty' | 'full' — towed-trolley state
    phase:        'idle',   // 'idle' | 'action_pause' | 'moving' | 'done' | 'parked'
    actionTimer:  0,
    currentNode:  null,     // node id the AGV is at / holding a reservation on
    job:          null,     // current group id being served, or null
    homeSlot:     null,     // node id of this AGV's home slot
    waiting:      false,    // held by a reservation on the node ahead
  };
}

// A sequence node is either a path corner or a station — look up its position.
function nodePos(id) { return state.track.points[id] || state.nodes[id] || null; }

// Safe centre-to-centre distance a follower must keep behind `leader`. A leader
// towing a trolley sticks out further behind, so the gap grows to clear it.
function requiredGapFor(leader) {
  const half = AGV_SIZE / 2;
  const rear = leader.load !== 'none' ? half + 8 + TROLLEY_LEN : half;   // rear extent of the leader
  return rear + half + FOLLOW_MARGIN;
}

// Steps remaining until this job ends (the last step returns home). Fewer steps
// = closer to home → higher priority at a shared node.
function stepsToHome(w) { return w.sequence.length - w.currentStep; }

// Strict, acyclic priority order for two AGVs contending for the same node:
// the one closer to home wins; ties broken by id so it is deterministic.
function hasMergePriority(w, o) {
  const sw = stepsToHome(w), so = stepsToHome(o);
  if (sw !== so) return sw < so;
  return w.id < o.id;
}

// The largest following gap we ever need (a leader towing a trolley). Used to
// decide how far up our own route to look for AGVs in front.
const MAX_GAP = 8 + TROLLEY_LEN + AGV_SIZE + FOLLOW_MARGIN;

// Geometric collision clamp. `w` is driving the edge fromId→toId. Returns how far
// it may advance this frame. We build the polyline `w` will actually drive (its
// live position, then upcoming sequence nodes out to one following-gap of length),
// and test other AGVs against that physical path rather than against node IDs — so
// two AGVs nose-to-tail on the same lane block each other even when the lane is
// drawn with different node IDs, bends, or runs over a free home-leg. Two outcomes:
//   • Merge    — o enters our target node from a DIFFERENT edge: the one closer to
//                home (fewer steps) wins; if o wins we wait a gap short of the node.
//   • Tailing / occupancy — o lies AHEAD on our polyline and within LANE_TOL of it
//                (same physical lane) → keep a safe gap behind it (the gap grows
//                when o tows a trolley). Parallel lanes (lateral > LANE_TOL) and
//                AGVs behind us are ignored — they may overlap on screen but never
//                wait. Head-on on one edge is out of scope. Infinity = nothing blocks.
function pathClampLimit(w, fromId, toId, dx, dy, len) {
  if (len < 1e-6) return Infinity;

  // Our lookahead polyline: live position, then upcoming nodes until the accumulated
  // path length exceeds one max following gap. `base[i]` = path distance to pts[i].
  const pts = [w.agvPos];
  const base = [0];
  let acc = 0, prev = w.agvPos;
  for (let k = w.currentStep; k < w.sequence.length; k++) {
    const p = nodePos(w.sequence[k]?.node);
    if (!p) break;
    acc += Math.hypot(p.x - prev.x, p.y - prev.y);
    pts.push(p);
    base.push(acc);
    prev = p;
    if (acc > MAX_GAP) break;
  }

  let lim = Infinity;
  for (const o of state.agvs) {
    if (o === w || o.phase === 'idle' || o.phase === 'done') continue;
    const oTarget = o.phase === 'moving' ? o.sequence[o.currentStep]?.node : null;
    const need = requiredGapFor(o);

    // Merge into our immediate target node from a different edge → priority by steps-to-home.
    const sameEdge = o.currentNode === fromId && oTarget === toId;
    if (oTarget === toId && !sameEdge && o.currentNode !== toId) {
      if (hasMergePriority(w, o)) continue;       // we're closer to home → we go first
      lim = Math.min(lim, len - need);            // else wait a gap short of the node
      continue;
    }

    // Tailing/occupancy: nearest point on OUR polyline to o, if o is on our lane.
    let bestD = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i].x, ay = pts[i].y;
      const ex = pts[i + 1].x - ax, ey = pts[i + 1].y - ay;
      const segLen2 = ex * ex + ey * ey;
      if (segLen2 < 1e-9) continue;
      const tRaw = ((o.agvPos.x - ax) * ex + (o.agvPos.y - ay) * ey) / segLen2;  // 0..1 along seg
      if (i === 0 && tRaw <= 0) continue;         // o is behind us on the segment we're driving
      const t = Math.max(0, Math.min(1, tRaw));
      const px = ax + ex * t, py = ay + ey * t;
      const lateral = Math.hypot(o.agvPos.x - px, o.agvPos.y - py);
      if (lateral > LANE_TOL) continue;           // parallel lane → not our line
      const D = base[i] + Math.sqrt(segLen2) * t; // path distance from w to o's projection
      if (D < bestD) bestD = D;
    }
    if (bestD === Infinity) continue;             // o not on our lane ahead
    lim = Math.min(lim, bestD - need);
  }
  return lim;
}

// Explicit routing: just switch the walker into 'moving' toward its current
// step. Movement goes straight from node to node — no pathfinding.
function routeWalkerToStep(w) {
  w.phase       = 'moving';
  w.actionTimer = 0;
}

function actionDurationFor(seqE) {
  if (seqE.dwell !== undefined) return seqE.dwell;
  return seqE.action === 'move' ? 0 : state.actionDuration;
}

function applyActionEffect(seqE, nodePos, w) {
  const action = seqE?.action;
  if (!action || action === 'move') return;

  if (seqE.homeAction) {
    if (action === 'attach-empty') w.load = 'empty';
    else if (action === 'attach-full') w.load = 'full';
    else if (action === 'detach-empty' || action === 'detach-full') w.load = 'none';
    return;
  }

  // A station stop sets the AGV's towed-trolley load directly.
  if (action === 'none' || action === 'empty' || action === 'full') w.load = action;
}

function resetWalker(w) {
  if (w.sequence.length === 0) { w.phase = 'idle'; return; }
  const startNodeId = w.sequence[0].node;
  const startPt     = state.nodes[startNodeId];
  if (!startPt) { w.phase = 'idle'; return; }

  w.currentStep    = 0;
  w.agvPos         = { x: startPt.x, y: startPt.y };
  w.agvHeading     = w.sequence[0]?.heading ?? 0;
  w.load           = 'none';
  w.phase          = 'action_pause';
  w.actionTimer    = 0;
  w.currentNode    = startNodeId;
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
    const duration = actionDurationFor(seqE);
    w.actionTimer += dt;

    if (w.actionTimer >= duration) {
      const np = nodePos(seqE.node);
      if (np) applyActionEffect(seqE, np, w);

      w.currentStep++;
      if (w.currentStep >= w.sequence.length) { w.phase = 'done'; return; }
      routeWalkerToStep(w);   // explicit: go straight to the next node
    }
    return;
  }

  if (w.phase === 'moving') {
    const targetId = w.sequence[w.currentStep].node;
    const to       = nodePos(targetId);
    if (!to) { w.phase = 'done'; return; }

    const dx = to.x - w.agvPos.x, dy = to.y - w.agvPos.y;
    const distToTarget = Math.hypot(dx, dy);

    // Face the direction of travel.
    if (distToTarget > 0.5) {
      const targetHeading = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
      let diff = targetHeading - w.agvHeading;
      if (diff >  180) diff -= 360;
      if (diff < -180) diff += 360;
      const maxTurn = 300 * dt;
      w.agvHeading += Math.max(-maxTurn, Math.min(maxTurn, diff));
      w.agvHeading  = ((w.agvHeading % 360) + 360) % 360;
    }

    // Collision handling is topological: only same-edge tailing and same-node
    // merges block. Parallel AGVs on other edges are ignored (graphics may
    // overlap — that's fine).
    let limit = state.agvSpeed * dt;
    limit = Math.min(limit, Math.max(0, pathClampLimit(w, w.currentNode, targetId, dx, dy, distToTarget)));

    w.waiting = limit <= 0.05 && distToTarget > 0.6;

    // Arrive if this frame's step reaches the node (don't overshoot past it).
    if (distToTarget <= 0.5 || limit >= distToTarget) {
      w.agvPos      = { x: to.x, y: to.y };
      w.currentNode = targetId;
      w.phase       = 'action_pause';
      w.actionTimer = 0;
      return;
    }

    // Otherwise advance toward the target by the clamped amount (r < 1).
    if (limit > 0) {
      const r = limit / distToTarget;
      w.agvPos = { x: w.agvPos.x + dx * r, y: w.agvPos.y + dy * r };
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
      const data   = JSON.parse(ev.target.result);
      const layout = normaliseLayout(data);
      state.nodes    = layout.stations;       // stations (action sites + home)
      state.track    = layout.path;           // path geometry (corners + edges)
      state.agvs     = layout.agvs.map(makeWalker);
      state.agvSpeed = layout.sim.agvSpeed;
      document.getElementById('agvSpeedInput').value = layout.sim.agvSpeed;
      Dispatch.init(layout);
      document.getElementById('loadStatus').textContent =
        `${file.name} — ${Object.keys(state.nodes).length} stations · ${state.agvs.length} AGV(s) · ` +
        `${Dispatch.groupIds().length} groups · ${Dispatch.calls().length} call points`;
      state.playing = false;
      updatePlayButton();
      buildDispatchUI();
      resetAllWalkers();
      updateStatusBadge();
      updateStepCounter();
      updateQueuePanel();
    } catch (err) { console.warn(err); alert('Invalid or unreadable layout JSON.'); }
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
const queueBody    = document.getElementById('queueBody');

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

function updateQueuePanel() {
  if (!queueBody) return;
  if (!Dispatch.isActive()) {
    queueBody.innerHTML = '<div class="queue-empty">Load a layout with AGVs to view the queue.</div>';
    return;
  }

  const running = Dispatch.runningSnapshot();
  const pending = Dispatch.queueSnapshot();
  const items = [
    ...running.map(item => ({ ...item, detail: `AGV ${item.agv} is serving this sequence` })),
    ...pending.map(item => ({
      ...item,
      detail: item.agv
        ? `waiting in FIFO queue for ${item.agv}`
        : `waiting in FIFO queue · position ${item.order}`,
    })),
  ];

  if (items.length === 0) {
    queueBody.innerHTML = '<div class="queue-empty">No running or pending sequences.</div>';
    return;
  }

  queueBody.innerHTML = items.map(item => `
    <div class="queue-entry ${item.state}">
      <div class="queue-entry-head">
        <span class="queue-entry-name">${item.name}</span>
        <span class="queue-entry-id">${item.group}</span>
        <span class="queue-entry-state">${item.state}</span>
      </div>
      <div class="queue-entry-detail">${item.detail}</div>
    </div>
  `).join('');
}

// Dispatch toolbar UI. Group calls are made by clicking the on-canvas call
// markers, so the toolbar only carries the Auto-generate toggle + a hint.
function buildDispatchUI() {
  const wrap = document.getElementById('dispatchControls');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!Dispatch.isActive()) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';

  const autoWrap = document.createElement('label');
  const auto = document.createElement('input');
  auto.type    = 'checkbox';
  auto.checked = dispatch.autoGenerate.enabled;
  auto.addEventListener('change', (e) => {
    dispatch.autoGenerate.enabled = e.target.checked;
    if (e.target.checked) dispatch.nextGenTime = Dispatch._nextInterval();
  });
  autoWrap.appendChild(auto);
  autoWrap.appendChild(document.createTextNode(' Auto-call'));
  wrap.appendChild(autoWrap);

  const hint = document.createElement('label');
  hint.style.color = '#9a6800';
  hint.textContent = 'click a call point to dispatch';
  wrap.appendChild(hint);
}

// Fire the group of whatever call marker is under the given screen point.
function callMarkerAt(sx, sy) {
  for (const c of Dispatch.calls()) {
    const { sx: mx, sy: my } = imgToScreen(c.x, c.y, state.view);
    if (Math.hypot(sx - mx, sy - my) <= CALL_BTN_RADIUS + 6) return c;
  }
  return null;
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
  updateQueuePanel();
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

// Left-press tracking so a click (no drag) can fire a call marker without
// being confused with a pan.
const leftPress = { down: false, sx: 0, sy: 0, moved: false };

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    e.preventDefault();
    state.isPanning    = true;
    state.panStart     = { sx: e.clientX, sy: e.clientY };
    state.panViewStart = { offsetX: state.view.offsetX, offsetY: state.view.offsetY };
  } else if (e.button === 0) {
    leftPress.down = true; leftPress.moved = false;
    leftPress.sx = e.clientX; leftPress.sy = e.clientY;
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button === 1) state.isPanning = false;
  if (e.button === 0 && leftPress.down) {
    leftPress.down = false;
    if (!leftPress.moved) {
      const hit = callMarkerAt(e.clientX, e.clientY - BAR_TOP);
      if (hit) {
        Dispatch.enqueue({ group: hit.group });
        state.callPressFx.push({ group: hit.group, x: hit.x, y: hit.y, until: state.elapsed + 0.24 });
        if (!state.playing) { state.playing = true; updatePlayButton(); }
        updateQueuePanel();
      }
    }
  }
});

canvas.addEventListener('mousemove', (e) => {
  state.mouse.sx = e.clientX;
  state.mouse.sy = e.clientY - BAR_TOP;
  if (leftPress.down && Math.hypot(e.clientX - leftPress.sx, e.clientY - leftPress.sy) > 4)
    leftPress.moved = true;
  if (state.isPanning) {
    state.view.offsetX = state.panViewStart.offsetX + (e.clientX - state.panStart.sx);
    state.view.offsetY = state.panViewStart.offsetY + (e.clientY - state.panStart.sy);
  }
  // pointer cursor when hovering a call marker
  canvas.style.cursor = (Dispatch.isActive() && callMarkerAt(e.clientX, e.clientY - BAR_TOP))
    ? 'pointer' : 'default';
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
  const col = LOAD_COLORS[action] || '#4080e0';
  if (!col) return;
  const textMap = {
    none: 'DROP',
    empty: 'EMPTY',
    full: 'FULL',
    'attach-empty': 'ATT EMPTY',
    'attach-full': 'ATT FULL',
    'detach-empty': 'DET EMPTY',
    'detach-full': 'DET FULL',
  };
  const text = textMap[action] || action.toUpperCase();

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
  ctx.fillText(text, sx, sy - AGV_SIZE / 2 - 14);

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

// Draw the towed trolley by load: 'empty' = light/hollow, 'full' = solid + cargo box.
function drawTrolley(sx, sy, heading, load) {
  if (load === 'none') return;
  const w = TROLLEY_LEN, h = TROLLEY_WID;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(heading * Math.PI / 180);

  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, 4);
  ctx.fillStyle   = load === 'full' ? '#F4A261' : '#fdf0df';   // solid amber vs light
  ctx.fill();
  ctx.strokeStyle = '#c07830';
  ctx.lineWidth   = 2.5;
  ctx.stroke();

  if (load === 'full') {
    // cargo box on top so a loaded trolley clearly differs from an empty one
    const cw = w * 0.55, ch = h * 0.6;
    ctx.beginPath();
    ctx.roundRect(-cw / 2, -ch / 2, cw, ch, 2);
    ctx.fillStyle   = '#9c4a1e';
    ctx.fill();
    ctx.strokeStyle = '#5e2c10';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  }

  // wheels at the four corners
  for (const sgn of [-1, 1]) for (const e of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(e * (w / 2 - 6), sgn * (h / 2 - 2), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#5b3415';
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

  // Active job path per AGV — straight legs between the explicit nodes
  state.agvs.forEach(agv => {
    const seq = agv.sequence.filter(e => nodePos(e.node));
    if (seq.length < 2) return;
    let load = 'none';
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i].action;
      if (a === 'none' || a === 'empty' || a === 'full') load = a;   // a stop sets the load
      const carrying = load !== 'none';
      const ptA = nodePos(seq[i].node);
      const ptB = nodePos(seq[i + 1].node);
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

  // ── Stations: home slots (squares) and action sites (circles) ────────────
  for (const [id, st] of Object.entries(state.nodes)) {
    const { sx, sy } = imgToScreen(st.x, st.y, state.view);
    if (activeTargetIds.has(id)) drawActivePulse(sx, sy, state.elapsed);

    if (st.role === 'home') {
      ctx.beginPath();
      ctx.rect(sx - DOT_RADIUS, sy - DOT_RADIUS, DOT_RADIUS * 2, DOT_RADIUS * 2);
      ctx.fillStyle   = '#cfe8ff'; ctx.fill();
      ctx.strokeStyle = '#2c6fbf'; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle   = '#50DC78'; ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.stroke();
    }

    if (state.showLabels) {
      ctx.fillStyle    = '#1a1a2a';
      ctx.font         = '10px monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(id, sx + DOT_RADIUS + 3, sy);
    }
  }

  // ── Call markers (clickable, free-floating) ──────────────────────────────
  const pending = Dispatch.isActive() ? Dispatch.pendingByGroup() : {};
  Dispatch.calls().forEach(c => {
    const { sx, sy } = imgToScreen(c.x, c.y, state.view);
    const r     = CALL_BTN_RADIUS;
    const pulse = 0.45 + 0.55 * Math.abs(Math.sin(state.elapsed * 3));
    const press = state.callPressFx.find(fx => fx.group === c.group && fx.x === c.x && fx.y === c.y && fx.until > state.elapsed);
    const pressT = press ? (press.until - state.elapsed) / 0.24 : 0;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = press ? '#1d7b3b' : '#2fb357';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(sx - 3, sy - 4, Math.max(2, r * 0.45), Math.PI * 1.1, Math.PI * 1.9);
    ctx.strokeStyle = `rgba(255,255,255,${(0.45 + pulse * 0.35).toFixed(2)})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    if (press) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + (1 - pressT) * 8, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(38,140,72,${(pressT * 0.5).toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const q = pending[c.group] || 0;
    ctx.fillStyle    = '#ffffff';
    ctx.font         = 'bold 10px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▶', sx, sy + 0.5);

    ctx.fillStyle    = '#175f31';
    ctx.font         = 'bold 10px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`▶ ${c.group}${q ? ` (${q})` : ''}`, sx, sy - r - 3);
  });

  const conflicts = detectConflicts();

  // Each AGV body, hitch, conflict ring, action indicator
  state.agvs.forEach((agv, idx) => {
    // Skip only truly-idle AGVs. Dispatch AGVs waiting at home are 'parked'
    // (rendered) even though their job sequence is momentarily empty.
    if (agv.phase === 'idle' || (agv.phase !== 'parked' && agv.sequence.length === 0)) return;

    const { sx: ax, sy: ay } = imgToScreen(agv.agvPos.x, agv.agvPos.y, state.view);
    const rad = agv.agvHeading * Math.PI / 180;

    if (agv.load !== 'none') {
      const HITCH = AGV_SIZE / 2 + 8 + TROLLEY_LEN / 2;   // clear the bigger trolley
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

      drawTrolley(tx, ty, agv.agvHeading, agv.load);
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

  drawQueueOverlay(cw, ch);
  drawHUD(cw, ch);
  drawHeadingLegend(ctx, cw);
}

// On-canvas queue list (top-left) so it is captured in the recording. Mirrors
// the running + pending snapshots the engine exposes.
function drawQueueOverlay(cw, ch) {
  if (!Dispatch.isActive()) return;
  const running = Dispatch.runningSnapshot();
  const pending = Dispatch.queueSnapshot();
  const rows    = [...running, ...pending];

  const x = 10, y = 10, w = 248;
  const titleH = 24, rowH = 32, maxRows = 6;
  const shown = rows.slice(0, maxRows);
  const extra = rows.length - shown.length;
  const bodyH = shown.length ? shown.length * rowH + (extra > 0 ? 16 : 0) + 8 : 26;
  const h = titleH + bodyH;

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  drawRoundRect(x, y, w, h, 8, 'rgba(255,255,255,0.95)', '#209144');

  ctx.fillStyle = '#1d7b3b';
  ctx.font = 'bold 11px monospace';
  ctx.fillText(`QUEUE — ${running.length} running · ${pending.length} waiting`, x + 10, y + titleH / 2 + 1);
  ctx.strokeStyle = '#d8eedf';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y + titleH); ctx.lineTo(x + w, y + titleH); ctx.stroke();

  if (!shown.length) {
    ctx.fillStyle = '#7a8790';
    ctx.font = '11px monospace';
    ctx.fillText('No running or pending jobs.', x + 10, y + titleH + 13);
    ctx.restore();
    return;
  }

  let ry = y + titleH + 6;
  shown.forEach(item => {
    const isRun = item.state === 'running';
    drawRoundRect(x + 6, ry, w - 12, rowH - 6, 5,
      isRun ? '#ebf8ef' : '#fbfcfb',
      isRun ? '#4ca567' : '#d8e0db');
    ctx.fillStyle = '#1a1a2a';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(item.name.slice(0, 24), x + 12, ry + 9);
    ctx.fillStyle = isRun ? '#176935' : '#68737d';
    ctx.font = '9px monospace';
    const detail = isRun
      ? `▶ ${item.agv}`
      : (item.agv ? `waiting · ${item.agv}` : `waiting · #${item.order}`);
    ctx.fillText(`${item.group}   ${detail}`, x + 12, ry + 20);
    ry += rowH;
  });
  if (extra > 0) {
    ctx.fillStyle = '#7a8790';
    ctx.font = '10px monospace';
    ctx.fillText(`+${extra} more`, x + 12, ry + 7);
  }
  ctx.restore();
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
      const pend = Dispatch.pendingByGroup();
      const perGroup = Dispatch.groupIds().map(id => `${id}:${pend[id] || 0}`).join('  ');
      ctx.fillStyle = '#9090a8';
      const qtxt = `   Queue: ${Dispatch.queueLength()}   ${perGroup}`;
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
  state.callPressFx = state.callPressFx.filter(fx => fx.until > state.elapsed - 0.05);

  const dispatchActive = Dispatch.isActive();
  const anyActive = state.agvs.some(w => w.phase !== 'idle' && w.phase !== 'done' && w.phase !== 'parked');
  if (state.playing && (anyActive || dispatchActive)) {
    state.elapsed += dt;
    updateAllWalkers(dt);
    if (dispatchActive) Dispatch.update(dt);
    updateStatusBadge();
    updateStepCounter();
    // A scripted timeline (SIM.requests) has a natural end, so it auto-pauses
    // and auto-stops recording once it drains. On-demand mode (no timeline) is
    // live — it only ends when the user pauses or clicks Stop.
    const scripted = dispatchActive && dispatch.requests.length > 0;
    const finished = dispatchActive ? (scripted && Dispatch.allComplete()) : allDone();
    if (finished) {
      state.playing = false;
      updatePlayButton();
      if (rec.active) stopRecording();
    }
  }

  drawScene(timestamp);   // the queue list is drawn on-canvas inside drawScene
  requestAnimationFrame(tick);
}

updateQueuePanel();
requestAnimationFrame(tick);
