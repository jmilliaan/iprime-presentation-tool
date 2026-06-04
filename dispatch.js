// dispatch.js — on-demand FIFO dispatch & queue engine for the Animation Player.
//
// Activates only when the loaded JSON contains a DISPATCH block (see
// normaliseDispatch in shared.js).  In that mode AGVs park at home, lines
// request service on demand, requests queue FIFO, an idle AGV is dispatched to
// serve the head of the queue, AGVs genuinely yield on shared track via a
// reservation map, then return to their home slot.
//
// Relies on globals defined in animplayer.js (state, routeWalkerToStep) and
// shared.js (normaliseDispatch, makeRng).  All cross-file access happens at
// call time, so script load order is not load-bearing.

const dispatch = {
  mode:        'scripted',   // 'scripted' | 'dispatch'
  home:        null,
  homeSlots:   [],
  lines:       {},           // id -> { id, node, serviceAction, serviceTime }
  lineOrder:   [],           // line ids in definition order
  queue:       [],           // FIFO of { line, agv }
  reserved:    new Map(),    // trackPointId -> agvId currently holding it
  rng:         Math.random,
  simTime:     0,
  timelineIdx: 0,
  requests:    [],
  autoGenerate: { enabled: false, meanInterval: 6, seed: 1234 },
  nextGenTime: Infinity,
};

const Dispatch = {
  isActive() { return dispatch.mode === 'dispatch'; },

  // Parse the DISPATCH block from a freshly loaded JSON. Returns true if the
  // layout is a dispatch scenario.
  init(data) {
    const d = normaliseDispatch(data);
    dispatch.lines     = {};
    dispatch.lineOrder = [];
    dispatch.queue     = [];
    dispatch.reserved  = new Map();
    if (!d) { dispatch.mode = 'scripted'; return false; }

    dispatch.mode         = 'dispatch';
    dispatch.home         = d.home;
    dispatch.homeSlots    = d.homeSlots;
    dispatch.requests     = d.requests;
    dispatch.autoGenerate = d.autoGenerate;
    d.lines.forEach(l => { dispatch.lines[l.id] = l; dispatch.lineOrder.push(l.id); });
    return true;
  },

  // Park every AGV at its home slot and clear all runtime state. Called from
  // resetAllWalkers (restart / record start) so each run is identical.
  reset() {
    dispatch.queue       = [];
    dispatch.reserved    = new Map();
    dispatch.simTime     = 0;
    dispatch.timelineIdx = 0;
    dispatch.rng         = makeRng(dispatch.autoGenerate.seed);
    dispatch.nextGenTime = dispatch.autoGenerate.enabled ? this._nextInterval() : Infinity;
    this._parkAll();
  },

  // ── Public queue API ──────────────────────────────────────────────────────

  enqueue(req) {
    if (dispatch.mode !== 'dispatch' || !req || !dispatch.lines[req.line]) return;
    dispatch.queue.push({ line: req.line, agv: req.agv || null });
  },

  // Per-tick engine step. Order matters: free finished AGVs first so they are
  // available for assignment this same tick.
  update(dt) {
    this._reclaim();
    dispatch.simTime += dt;
    this._fireTimeline();
    this._autoGen();
    this._assign();
  },

  // ── Reservation API (called from animplayer updateWalker) ─────────────────

  tryReserve(tpId, agvId) {
    const holder = dispatch.reserved.get(tpId);
    if (holder === undefined || holder === agvId) { dispatch.reserved.set(tpId, agvId); return true; }
    return false;
  },

  release(tpId, agvId) {
    if (tpId && dispatch.reserved.get(tpId) === agvId) dispatch.reserved.delete(tpId);
  },

  // ── Completion / HUD helpers ──────────────────────────────────────────────

  // True once the scripted timeline is drained, the queue is empty and all AGVs
  // are back home — used to auto-stop a deterministic recording.
  allComplete() {
    return dispatch.mode === 'dispatch'
      && !dispatch.autoGenerate.enabled
      && dispatch.timelineIdx >= dispatch.requests.length
      && dispatch.queue.length === 0
      && state.agvs.every(w => w.phase === 'parked');
  },

  queueLength() { return dispatch.queue.length; },

  pendingByLine() {
    const counts = {};
    dispatch.lineOrder.forEach(id => { counts[id] = 0; });
    dispatch.queue.forEach(r => { counts[r.line] = (counts[r.line] || 0) + 1; });
    return counts;
  },

  lineIds() { return dispatch.lineOrder.slice(); },

  // Short status label for one walker, used by the HUD.
  stateLabel(w) {
    if (w.phase === 'parked') return 'HOME';
    if (!w.job)               return w.phase.toUpperCase();
    if (w.waiting)            return 'WAIT';
    if (w.phase === 'action_pause' && w.currentStep === 0) return 'SERVING';
    if (w.currentStep >= 1)   return 'RETURN';
    return 'TO LINE';
  },

  // ── Internals ─────────────────────────────────────────────────────────────

  _nextInterval() {
    // Exponential inter-arrival → Poisson process, driven by the seeded RNG.
    const u = Math.max(1e-6, dispatch.rng());
    return dispatch.simTime + (-Math.log(u) * dispatch.autoGenerate.meanInterval);
  },

  _slotNodeId(i) {
    return dispatch.homeSlots[i] || dispatch.home || null;
  },

  _parkAll() {
    state.agvs.forEach((w, i) => {
      const slotId = this._slotNodeId(i);
      const node   = slotId ? state.nodes[slotId] : null;
      w.homeSlot       = slotId;
      w.agvPos         = node ? { x: node.x, y: node.y } : { x: 40 + i * 50, y: 40 };
      w.agvHeading     = node?.heading ?? 0;
      w.currentTrackPt = node?.trackPoint || null;
      w.sequence       = [];
      w.currentStep    = 0;
      w.actionTimer    = 0;
      w.trolleyState   = 'empty';
      w.trolleyPos     = null;
      w.trackPath      = [];
      w.trackPathIdx   = 0;
      w.phase          = 'parked';
      w.job            = null;
      w.waiting        = false;
      if (w.currentTrackPt) dispatch.reserved.set(w.currentTrackPt, w.id);
    });
  },

  _reclaim() {
    state.agvs.forEach(w => {
      if (w.job && w.phase === 'done') {
        w.phase       = 'parked';
        w.job         = null;
        w.sequence    = [];
        w.currentStep = 0;
        w.waiting     = false;
      }
    });
  },

  _fireTimeline() {
    while (dispatch.timelineIdx < dispatch.requests.length
        && dispatch.requests[dispatch.timelineIdx].t <= dispatch.simTime) {
      this.enqueue(dispatch.requests[dispatch.timelineIdx]);
      dispatch.timelineIdx++;
    }
  },

  _autoGen() {
    if (!dispatch.autoGenerate.enabled || dispatch.lineOrder.length === 0) return;
    while (dispatch.simTime >= dispatch.nextGenTime) {
      const idx = Math.floor(dispatch.rng() * dispatch.lineOrder.length) % dispatch.lineOrder.length;
      this.enqueue({ line: dispatch.lineOrder[idx] });
      dispatch.nextGenTime = this._nextInterval();
    }
  },

  _pickIdle(agvId) {
    const idle = state.agvs.filter(w => w.phase === 'parked');
    if (agvId) return idle.find(w => w.id === agvId) || null;
    return idle[0] || null;
  },

  // Strict FIFO: if the head request has no eligible idle AGV (e.g. a request
  // pinned to a specific AGV that is still busy), the whole queue waits.
  _assign() {
    while (dispatch.queue.length > 0) {
      const req = dispatch.queue[0];
      const w   = this._pickIdle(req.agv);
      if (!w) break;
      dispatch.queue.shift();
      this._startJob(w, dispatch.lines[req.line]);
    }
  },

  _startJob(w, line) {
    const lineNode = state.nodes[line.node];
    const slotId   = w.homeSlot;
    const slotNode = slotId ? state.nodes[slotId] : null;
    w.job         = line.id;
    w.waiting     = false;
    w.sequence    = [
      { node: line.node, action: line.serviceAction, heading: lineNode?.heading ?? 0,
        dwell: line.serviceTime, label: line.id },
      { node: slotId,    action: 'move', heading: slotNode?.heading ?? w.agvHeading },
    ];
    w.currentStep = 0;
    w.actionTimer = 0;
    routeWalkerToStep(w);   // animplayer.js — sets up trackPath + phase 'moving'
  },
};
