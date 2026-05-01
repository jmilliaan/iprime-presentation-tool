// shared.js — utilities used by both cpicker.js and animplayer.js

const COLORS = {
  waypoint:      '#FFC832',
  seq_point:     '#50DC78',
  sequence_line: '#FF64C8',
  seq_highlight: '#FF64C8',
  action: {
    pickup:   '#50DC78',
    release:  '#F4A261',
    exchange: '#50C8FF',
  },
};

const AGV_COLORS = ['#E63946', '#4080e0', '#1a9c50', '#cc44aa'];

const ZOOM_MIN      = 0.1;
const ZOOM_MAX      = 8.0;
const ZOOM_STEP     = 0.15;
const SEQ_HIT_RADIUS = 18;
const DOT_RADIUS    = 6;

function dotColorForType(type) {
  return COLORS[type] || '#AAAAAA';
}

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

// ── Hit detection ─────────────────────────────────────────────────────────

function findNodeAt(sx, sy, nodes, view, hitRadius = SEQ_HIT_RADIUS) {
  let bestId   = null;
  let bestDist = hitRadius + 1;
  for (const [id, pt] of Object.entries(nodes)) {
    const { sx: nx, sy: ny } = imgToScreen(pt.x, pt.y, view);
    const d = Math.hypot(sx - nx, sy - ny);
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  return bestId;
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

// ── Sequence normalisation ────────────────────────────────────────────────
// Handles old format (string[]) and new format ({node,action}[])

function normaliseSequence(rawSeq) {
  return rawSeq.map(entry =>
    typeof entry === 'string'
      ? { node: entry, action: 'move', heading: 0 }
      : { heading: 0, ...entry }   // backfill heading if missing
  );
}

// ── Track normalisation & geometry ───────────────────────────────────────

function normaliseTrack(raw) {
  if (!raw) return { points: {}, segments: [] };
  return {
    points:   raw.points || {},
    segments: (raw.segments || []).map(s => ({
      id:        s.id        || '',
      from:      s.from      || '',
      to:        s.to        || '',
      type:      s.type === 'arc' ? 'arc' : 'straight',
      radius:    s.radius    ?? 100,
      clockwise: s.clockwise !== false,
    })),
  };
}

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

// ── AGV array normalisation ───────────────────────────────────────────────
// Accepts parsed JSON object; returns [{id, color, sequence}] array.
// Backward-compatible: wraps legacy SEQUENCE key into a single AGV entry.

function normaliseAGVS(data) {
  if (data.AGVS && data.AGVS.length > 0) {
    return data.AGVS.map((agv, i) => ({
      id:       agv.id    || `AGV-0${i + 1}`,
      color:    agv.color || AGV_COLORS[i % AGV_COLORS.length],
      sequence: normaliseSequence(agv.sequence || []),
    }));
  }
  if (data.SEQUENCE && data.SEQUENCE.length > 0) {
    return [{ id: 'AGV-01', color: AGV_COLORS[0], sequence: normaliseSequence(data.SEQUENCE) }];
  }
  return [];
}
