// shared.js — utilities used by both cpicker.js and animplayer.js

const AGV_COLORS = ['#E63946', '#4080e0', '#1a9c50', '#cc44aa'];
const HOME_ACTIONS = ['none', 'attach-empty', 'attach-full', 'detach-empty', 'detach-full'];

// Loop-dispatch mode (TBM trolley system). Six empty-trolley types; a call button
// selects the type to deliver. Default palette used when a layout omits TROLLEY_TYPES.
const DEFAULT_TROLLEY_TYPES = [
  { id: 'TT-1', name: 'Type 1', color: '#E63946' },
  { id: 'TT-2', name: 'Type 2', color: '#4080e0' },
  { id: 'TT-3', name: 'Type 3', color: '#1a9c50' },
  { id: 'TT-4', name: 'Type 4', color: '#cc44aa' },
  { id: 'TT-5', name: 'Type 5', color: '#e08a1e' },
  { id: 'TT-6', name: 'Type 6', color: '#16a0a0' },
];

const ZOOM_MIN  = 0.1;
const ZOOM_MAX  = 8.0;
const ZOOM_STEP = 0.15;
const DOT_RADIUS = 6;

// ── Coordinate transforms ─────────────────────────────────────────────────

function imgToScreen(ix, iy, view) {
  return {
    sx: ix * view.zoom + view.offsetX,
    sy: iy * view.zoom + view.offsetY,
  };
}

function screenToImg(sx, sy, view) {
  return {
    ix: (sx - view.offsetX) / view.zoom,
    iy: (sy - view.offsetY) / view.zoom,
  };
}

// ── Path following (port of advance_along_path from pygame_sim.py) ────────
// pos: {x, y}  path: [{x,y}, ...]  targetIdx: index of next waypoint to reach
// Returns {pos, targetIdx}

function advanceAlongPath(pos, path, targetIdx, speed, dt) {
  if (targetIdx >= path.length) {
    return { pos: { x: path[path.length - 1].x, y: path[path.length - 1].y }, targetIdx };
  }
  const target = path[targetIdx];
  const dx   = target.x - pos.x;
  const dy   = target.y - pos.y;
  const dist = Math.hypot(dx, dy);
  const step = speed * dt;

  if (dist < 0.5) {
    return advanceAlongPath({ x: target.x, y: target.y }, path, targetIdx + 1, speed, dt);
  }
  if (step >= dist) {
    const leftover = (step - dist) / speed;
    return advanceAlongPath({ x: target.x, y: target.y }, path, targetIdx + 1, speed, leftover);
  }
  const ratio = step / dist;
  return {
    pos: { x: pos.x + dx * ratio, y: pos.y + dy * ratio },
    targetIdx,
  };
}

// ── Drawing ───────────────────────────────────────────────────────────────

function drawHeadingArrow(ctx, cx, cy, deg, length, color, width = 2) {
  const rad  = (deg * Math.PI) / 180;
  const tx   = cx + length * Math.cos(rad);
  const ty   = cy + length * Math.sin(rad);
  const bx   = cx + length * 0.35 * Math.cos(rad);
  const by   = cy + length * 0.35 * Math.sin(rad);
  const perp = ((deg + 90) * Math.PI) / 180;
  const hw   = Math.max(4, length / 8);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(bx + hw * Math.cos(perp), by + hw * Math.sin(perp));
  ctx.lineTo(bx - hw * Math.cos(perp), by - hw * Math.sin(perp));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawGrid(ctx, imgW, imgH, view) {
  const step = 100;
  ctx.save();
  ctx.strokeStyle = 'rgba(160,160,160,0.35)';
  ctx.lineWidth   = 0.5;
  ctx.fillStyle   = 'rgba(140,140,140,0.7)';
  ctx.font        = '11px monospace';
  ctx.textBaseline = 'top';

  for (let x = 0; x <= imgW; x += step) {
    const { sx } = imgToScreen(x, 0, view);
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, ctx.canvas.height);
    ctx.stroke();
    if (x % 500 === 0) {
      ctx.textAlign = 'left';
      ctx.fillText(x, sx + 2, 2);
    }
  }
  for (let y = 0; y <= imgH; y += step) {
    const { sy } = imgToScreen(0, y, view);
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(ctx.canvas.width, sy);
    ctx.stroke();
    if (y % 500 === 0) {
      ctx.textAlign = 'left';
      ctx.fillText(y, 2, sy + 2);
    }
  }
  ctx.restore();
}

function drawHeadingLegend(ctx, canvasW, offsetY = 0) {
  const cx = canvasW - 80;
  const cy = offsetY + 80;
  const rOuter = 48;
  const rLabel = 66;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter + 18, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(240,240,248,0.92)';
  ctx.fill();
  ctx.strokeStyle = '#c0c0d0';
  ctx.lineWidth   = 1;
  ctx.stroke();

  const hdgs = [
    { deg: 0,   label: '0',   color: '#64DC64' },
    { deg: 90,  label: '90',  color: '#64B4FF' },
    { deg: 180, label: '180', color: '#FFA03C' },
    { deg: 270, label: '270', color: '#DC64DC' },
  ];
  for (const { deg, label, color } of hdgs) {
    drawHeadingArrow(ctx, cx, cy, deg, rOuter, color, 2);
    const rad = (deg * Math.PI) / 180;
    const lx  = cx + rLabel * Math.cos(rad);
    const ly  = cy + rLabel * Math.sin(rad);
    ctx.fillStyle   = color;
    ctx.font        = 'bold 12px monospace';
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx, ly);
  }

  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#1a1a2a';
  ctx.fill();

  ctx.fillStyle    = '#606070';
  ctx.font         = 'bold 11px monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('HDG', cx, cy - rOuter - 10);
  ctx.restore();
}

// ── Colour helpers ────────────────────────────────────────────────────────

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Track geometry ────────────────────────────────────────────────────────

// Compute arc center given two image-coord points, radius, and visual CW direction.
// In canvas (y-down), CW visually = center is to the right of the A→B chord.
// Returns null when the chord is longer than the diameter.
function arcCenter(A, B, radius, clockwise) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.001 || dist > 2 * radius + 0.001) return null;
  const h  = Math.sqrt(Math.max(0, radius * radius - (dist / 2) * (dist / 2)));
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  // CW-perpendicular of chord in canvas (y-down): rotate chord 90° CW → (-dy, dx)
  const px = -dy / dist, py = dx / dist;
  const sign = clockwise ? 1 : -1;
  return { x: mx + sign * h * px, y: my + sign * h * py };
}

// Stroke a single track segment onto ctx.  A, B are image-coord points.
function strokeTrackSegment(ctx, A, B, seg, view) {
  const sA = imgToScreen(A.x, A.y, view);
  const sB = imgToScreen(B.x, B.y, view);
  ctx.beginPath();
  if (seg.type === 'arc' && seg.radius) {
    const cImg = arcCenter(A, B, seg.radius, seg.clockwise !== false);
    if (cImg) {
      const sC = imgToScreen(cImg.x, cImg.y, view);
      const r  = Math.hypot(sA.sx - sC.sx, sA.sy - sC.sy);
      const sa = Math.atan2(sA.sy - sC.sy, sA.sx - sC.sx);
      const ea = Math.atan2(sB.sy - sC.sy, sB.sx - sC.sx);
      // clockwise=true → visual CW → canvas anticlockwise=false
      ctx.arc(sC.sx, sC.sy, r, sa, ea, seg.clockwise === false);
    } else {
      ctx.moveTo(sA.sx, sA.sy); ctx.lineTo(sB.sx, sB.sy);
    }
  } else {
    ctx.moveTo(sA.sx, sA.sy); ctx.lineTo(sB.sx, sB.sy);
  }
}

// ── Deterministic RNG (LCG, Numerical Recipes) ────────────────────────────
// Returns a function producing floats in [0,1).  Seeded → reproducible runs,
// which is what makes a recorded dispatch video identical every time.

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ── Layout normalisation (Path / Stations / Groups / Call-stations) ────────
// The authoring schema. Routing is EXPLICIT: a group is the literal ordered
// list of clicked nodes (path corners + action stations, no home); the AGV
// drives straight from one to the next. PATH.nodes/edges are kept as a drawn
// guide ({ points, segments }); the engine references node ids directly. Every
// section is defaulted and bad cross-references are dropped so a partial file
// still loads instead of throwing.

function normaliseLayout(data) {
  // PATH (geometry, drawn guide)
  const rawPath  = data.PATH || {};
  const points   = rawPath.nodes || {};
  const segments = (rawPath.edges || []).map(e => ({
    id:        e.id || '',
    from:      e.from || '',
    to:        e.to || '',
    type:      e.type === 'arc' ? 'arc' : 'straight',
    radius:    e.radius ?? 100,
    clockwise: e.clockwise !== false,
  })).filter(e => points[e.from] && points[e.to]);
  const path = { points, segments };

  // STATIONS — positions only; no path link needed. Roles:
  //   action — group-mode load-setting stop
  //   home   — AGV parking / waiting slot
  //   tbm    — loop-mode machine (demand point); `agv` = its serving AGV (zone)
  //   store  — loop-mode single load/unload area
  const STATION_ROLES = ['action', 'home', 'tbm', 'store'];
  const stations = {};
  for (const [id, s] of Object.entries(data.STATIONS || {})) {
    if (!s) continue;
    const role = STATION_ROLES.includes(s.role) ? s.role : 'action';
    stations[id] = { x: s.x, y: s.y, role, kind: 'station' };
    if (role === 'tbm') stations[id].agv = s.agv || null;   // serving AGV (zone allocation)
  }

  // AGVS — identities only (#AGVs should equal #home stations)
  const agvs = (data.AGVS || []).map((a, i) => ({
    id:    a.id    || `AGV-0${i + 1}`,
    color: a.color || AGV_COLORS[i % AGV_COLORS.length],
  }));

  // TROLLEY_TYPES — loop mode; default 6-type palette when omitted
  const trolleyTypes = (Array.isArray(data.TROLLEY_TYPES) && data.TROLLEY_TYPES.length
    ? data.TROLLEY_TYPES : DEFAULT_TROLLEY_TYPES
  ).map((t, i) => ({
    id:    t.id    || `TT-${i + 1}`,
    name:  t.name  || `Type ${i + 1}`,
    color: t.color || AGV_COLORS[i % AGV_COLORS.length],
  }));

  // A group node may be a path corner OR a station.
  const nodeExists = id => !!points[id] || !!stations[id];

  // A stop's action sets the AGV's towed-trolley load (move = pass-through).
  // Legacy verbs are mapped so older files still load.
  const normAction = a => {
    if (a === 'pickup' || a === 'exchange') return 'full';
    if (a === 'release') return 'none';
    return ['move', 'none', 'empty', 'full'].includes(a) ? a : 'move';
  };
  const normHomeAct = a => (HOME_ACTIONS.includes(a) ? a : 'none');

  // GROUPS — explicit ordered node lists (home excluded; added per-AGV at run time)
  const groups = {};
  for (const [id, g] of Object.entries(data.GROUPS || {})) {
    if (!g) continue;
    const stops = (g.stops || [])
      .filter(st => st && nodeExists(st.node))
      .map(st => {
        const o = { node: st.node, action: normAction(st.action) };
        if (typeof st.dwell === 'number') o.dwell = st.dwell;
        if (st.label) o.label = st.label;
        if (st.mode === 'manual') o.mode = 'manual';
        return o;
      });
    groups[id] = { name: g.name || id, stops, homeStart: normHomeAct(g.homeStart), homeEnd: normHomeAct(g.homeEnd) };
  }

  // CALLS — free-floating call buttons { x, y, group }. Legacy CALL_STATIONS
  // (anchored to a station) are converted using that station's position.
  const calls = [];
  (data.CALLS || []).forEach(c => {
    if (c && groups[c.group] && typeof c.x === 'number' && typeof c.y === 'number')
      calls.push({ x: c.x, y: c.y, group: c.group });
  });
  (data.CALL_STATIONS || []).forEach(c => {
    if (c && groups[c.group] && stations[c.station])
      calls.push({ x: stations[c.station].x, y: stations[c.station].y, group: c.group });
  });

  // HOME slots — valid station ids only
  const homeSlots = ((data.HOME && data.HOME.slots) || []).filter(id => stations[id]);

  // SIM — optional playback config
  const rawSim = data.SIM || {};
  const ag     = rawSim.autoGenerate || {};
  const mode   = rawSim.mode === 'loop' ? 'loop' : 'group';

  // Requests differ by engine: group mode fires a GROUP; loop mode fires a
  // (machine, trolley-type) call. Parse the one matching the active mode.
  const firstType = trolleyTypes[0] && trolleyTypes[0].id;
  const typeIds   = new Set(trolleyTypes.map(t => t.id));
  const requests = mode === 'loop'
    ? (rawSim.requests || [])
        .map(r => ({ t: +r.t || 0, machine: r.machine, type: typeIds.has(r.type) ? r.type : firstType }))
        .filter(r => stations[r.machine] && stations[r.machine].role === 'tbm')
        .sort((a, b) => a.t - b.t)
    : (rawSim.requests || [])
        .map(r => ({ t: +r.t || 0, group: r.group, agv: r.agv || null }))
        .filter(r => groups[r.group])
        .sort((a, b) => a.t - b.t);

  const sim = {
    mode,
    trainSize:   typeof rawSim.trainSize === 'number' ? rawSim.trainSize : 2,
    pairTimeout: typeof rawSim.pairTimeout === 'number' ? rawSim.pairTimeout : 200,
    store:       (rawSim.store && stations[rawSim.store] && stations[rawSim.store].role === 'store')
                   ? rawSim.store
                   : (Object.keys(stations).find(id => stations[id].role === 'store') || null),
    agvSpeed:    typeof rawSim.agvSpeed === 'number' ? rawSim.agvSpeed : 120,
    serviceTime: typeof rawSim.serviceTime === 'number' ? rawSim.serviceTime : 3,
    requests,
    autoGenerate: {
      enabled:      !!ag.enabled,
      meanInterval: typeof ag.meanInterval === 'number' && ag.meanInterval > 0 ? ag.meanInterval : 6,
      seed:         typeof ag.seed === 'number' ? ag.seed : 1234,
    },
  };

  return { path, stations, agvs, groups, calls, homeSlots, trolleyTypes, sim };
}

// ── Loop-ring routing (loop-dispatch mode) ─────────────────────────────────
// The drawn PATH is treated as a single one-way cycle. Starting at the store,
// follow authored edge direction (from→to) around the loop, returning the node
// ids in travel order [store, n1, n2, …] (store not repeated at the end). At a
// branch, prefer an unvisited successor. Used to order paired stops by line
// position and to build the AGV's straight node-to-node route around the loop.
function buildLoopRing(path, storeId) {
  if (!storeId) return [];
  const out = {};
  (path.segments || []).forEach(e => { (out[e.from] = out[e.from] || []).push(e.to); });
  const ring = [];
  const seen = new Set();
  let cur = storeId;
  while (cur && !seen.has(cur)) {
    ring.push(cur);
    seen.add(cur);
    const nexts = out[cur] || [];
    const next  = nexts.find(n => !seen.has(n));
    cur = (next !== undefined) ? next : null;   // null when the loop closes (only edge goes back to a seen node)
  }
  return ring;
}
