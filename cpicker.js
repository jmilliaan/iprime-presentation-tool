// cpicker.js — Coordinate picker with radial menu

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

// ── Application state ─────────────────────────────────────────────────────

const state = {
  nodes:    {},       // { ID: {x, y, type} }  — no heading; heading is per sequence entry
  sequence: [],       // [ {node, action, heading} ]
  view:     { offsetX: 0, offsetY: 0, zoom: 1 },
  mode:     'NODE',
  bgImage:  null,
  imgW: 0, imgH: 0,
  outputFilename: 'coords.json',
  mouseScreen: { sx: 0, sy: 0 },
  mouseImg:    { ix: 0, iy: 0 },
  isPanning:        false,
  panStart:         { sx: 0, sy: 0 },
  panViewStart:     { offsetX: 0, offsetY: 0 },
  hoveredNode:      null,
  actionPickerNode: null,
};

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
};

// ── DOM references ────────────────────────────────────────────────────────

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
      if (data.NODES)    state.nodes    = data.NODES;
      if (data.SEQUENCE) state.sequence = normaliseSequence(data.SEQUENCE);
      updateSeqPanel();
      updateNodeList();
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
  updateSeqPanel();
  updateNodeList();
  requestAnimationFrame(drawLoop);
});

// ── Clear ─────────────────────────────────────────────────────────────────

document.getElementById('clearBtn').addEventListener('click', () => confirmClearModal.showModal());

document.getElementById('confirmClearCancel').addEventListener('click', () => confirmClearModal.close());

document.getElementById('confirmClearOk').addEventListener('click', () => {
  confirmClearModal.close();
  state.nodes = {}; state.sequence = [];
  state.bgImage = null; state.imgW = 0; state.imgH = 0;
  state.mode = 'NODE'; state.hoveredNode = null; state.actionPickerNode = null;
  loadJsonInput.value = ''; loadImgInput.value = '';
  filenameInput.value = 'coords.json'; state.outputFilename = 'coords.json';
  closeRadial(); hideActionPicker();
  updateSeqPanel(); updateNodeList(); updateModeBadge();
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
  radial.active = false;
  radial.phase  = null;
  // also cancel any pending sequence entry
  seqEntry.pending = false;
  seqEntry.nodeId  = null;
  seqEntry.action  = null;
  hideNameInput();
}

function selectType(type) {
  if (type === 'waypoint') {
    // Auto-name and save immediately — no angle prompt
    const id = nextWpName();
    state.nodes[id] = { x: Math.round(radial.ix), y: Math.round(radial.iy), type: 'waypoint' };
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
  state.sequence.push({
    node:    seqEntry.nodeId,
    action:  seqEntry.action,
    heading: sectorIdx * 45,
  });
  closeRadial();
  updateSeqPanel();
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
    // Save the seq_point node — no angle prompt in node mode
    state.nodes[val] = { x: Math.round(radial.ix), y: Math.round(radial.iy), type: 'seq_point' };
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
  if (actionPicker.style.display === 'flex' && !actionPicker.contains(e.target)) {
    hideActionPicker();
    seqEntry.pending = false;
  }
});

// ── Keyboard ──────────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (startupModal.open || confirmClearModal.open) return;

  if (e.key === 'Escape') {
    if (radial.active) { closeRadial(); return; }
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

  if (state.mode === 'NODE') {
    const keys = Object.keys(state.nodes);
    if (keys.length) { delete state.nodes[keys[keys.length - 1]]; updateSeqPanel(); updateNodeList(); }
  } else {
    if (state.sequence.length) { state.sequence.pop(); updateSeqPanel(); }
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

  if (state.mode === 'SEQUENCE' && !radial.active) {
    state.hoveredNode = findNodeAt(e.clientX, e.clientY, state.nodes, state.view);
    canvas.style.cursor = state.hoveredNode ? 'pointer' : 'default';
  } else {
    canvas.style.cursor = (state.mode === 'NODE' && !radial.active) ? 'crosshair' : 'default';
  }

  hudCoords.textContent = `(${Math.round(state.mouseImg.ix)}, ${Math.round(state.mouseImg.iy)})`;
  hudZoom.textContent   = `zoom: ${state.view.zoom.toFixed(2)}×`;
  hudCounts.textContent = `nodes: ${Object.keys(state.nodes).length} | seq: ${state.sequence.length}`;
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
  seqPanel.style.display = state.sequence.length > 0 ? 'block' : 'none';
  seqPanelTitle.textContent = `SEQUENCE (${state.sequence.length})`;
  seqList.innerHTML = '';
  state.sequence.forEach(({ node, action, heading }, i) => {
    const row = document.createElement('div');
    row.className = 'seq-entry';
    row.innerHTML =
      `<span class="seq-idx">${i}</span>` +
      `<span class="seq-node">${node}</span>` +
      `<span class="action-badge badge-${action}">${action}</span>` +
      `<span class="seq-heading">${heading ?? 0}°</span>`;
    seqList.appendChild(row);
  });
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
  modeBadge.textContent = state.mode === 'NODE' ? 'NODE MODE' : 'SEQUENCE MODE';
  modeBadge.className   = state.mode === 'NODE' ? 'node-mode' : 'seq-mode';
}

// ── Save JSON ─────────────────────────────────────────────────────────────

function saveJSON() {
  const data = { NODES: state.nodes, SEQUENCE: state.sequence };
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

  // Sequence path lines
  const validSeq = state.sequence.filter(e => state.nodes[e.node]);
  if (validSeq.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = COLORS.sequence_line;
    ctx.lineWidth   = 2;
    ctx.setLineDash([]);
    validSeq.forEach(({ node }, i) => {
      const pt = state.nodes[node];
      const { sx, sy } = imgToScreen(pt.x, pt.y, state.view);
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
  }

  // Sequence step labels + heading arrows
  validSeq.forEach(({ node, heading }, i) => {
    const pt = state.nodes[node];
    const { sx, sy } = imgToScreen(pt.x, pt.y, state.view);

    // Step index
    ctx.fillStyle    = COLORS.sequence_line;
    ctx.font         = '11px monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(i), sx + DOT_RADIUS + 1, sy - 2);

    // Heading arrow for this visit
    if (heading !== undefined) {
      drawHeadingArrow(ctx, sx, sy, heading, 18, COLORS.sequence_line, 1.5);
    }
  });

  // Nodes
  for (const [id, pt] of Object.entries(state.nodes)) {
    const { sx, sy } = imgToScreen(pt.x, pt.y, state.view);
    const col = dotColorForType(pt.type);

    if (state.mode === 'SEQUENCE') {
      if (state.sequence.some(e => e.node === id)) {
        ctx.beginPath();
        ctx.arc(sx, sy, DOT_RADIUS + 5, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.seq_highlight; ctx.lineWidth = 1.5; ctx.stroke();
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

  // Crosshair (NODE mode, no radial)
  if (state.mode === 'NODE' && !radial.active && !startupModal.open) {
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
