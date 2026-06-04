// dispatch.js — on-demand FIFO dispatch & queue engine for the Animation Player.
//
// Groups (multi-stop jobs) are requested on demand — via on-canvas call markers,
// a scripted timeline, or a seeded auto-generator. Requests queue FIFO; an idle
// AGV is dispatched from its home slot to run the group's stops in order and
// return home. AGVs genuinely wait/yield on shared path corners via a track-point
// reservation map.
//
// Relies on globals from animplayer.js (state, routeWalkerToStep) and shared.js
// (makeRng). All cross-file access happens at call time, so load order is free.

const dispatch = {
  mode:        'idle',       // 'idle' | 'dispatch'
  homeSlots:   [],
  groups:      {},           // id -> { name, stops:[{station,action,dwell?,label?,mode?}] }
  groupOrder:  [],
  callStations: [],          // [{ station, group }]
  serviceTime: 3,
  queue:       [],           // FIFO of { group, agv }
  reserved:    new Map(),    // trackPointId -> agvId holding it
  rng:         Math.random,
  simTime:     0,
  timelineIdx: 0,
  requests:    [],
  autoGenerate: { enabled: false, meanInterval: 6, seed: 1234 },
  nextGenTime: Infinity,
};

const Dispatch = {
  isActive() { return dispatch.mode === 'dispatch'; },

  // Accepts the normalised layout (from normaliseLayout in shared.js).
  init(layout) {
    dispatch.groups       = layout.groups || {};
    dispatch.groupOrder   = Object.keys(dispatch.groups);
    dispatch.callStations = layout.callStations || [];
    dispatch.homeSlots    = layout.homeSlots || [];
    dispatch.serviceTime  = layout.sim.serviceTime;
    dispatch.requests     = layout.sim.requests || [];
    dispatch.autoGenerate = layout.sim.autoGenerate;
    dispatch.queue        = [];
    dispatch.reserved     = new Map();
    dispatch.mode         = (layout.agvs && layout.agvs.length > 0) ? 'dispatch' : 'idle';
    return dispatch.mode === 'dispatch';
  },

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
    if (dispatch.mode !== 'dispatch' || !req || !dispatch.groups[req.group]) return;
    dispatch.queue.push({ group: req.group, agv: req.agv || null });
  },

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

  allComplete() {
    return dispatch.mode === 'dispatch'
      && !dispatch.autoGenerate.enabled
      && dispatch.timelineIdx >= dispatch.requests.length
      && dispatch.queue.length === 0
      && state.agvs.every(w => w.phase === 'parked');
  },

  queueLength() { return dispatch.queue.length; },

  pendingByGroup() {
    const counts = {};
    dispatch.groupOrder.forEach(id => { counts[id] = 0; });
    dispatch.queue.forEach(r => { counts[r.group] = (counts[r.group] || 0) + 1; });
    return counts;
  },

  groupIds()     { return dispatch.groupOrder.slice(); },
  callStations() { return dispatch.callStations; },

  // Short status label for one walker (HUD).
  stateLabel(w) {
    if (w.phase === 'parked') return 'HOME';
    if (!w.job)               return w.phase.toUpperCase();
    if (w.waiting)            return 'WAIT';
    if (w.phase === 'action_pause') return 'SERVING';
    const last = w.sequence.length - 1;
    if (w.currentStep >= last) return 'RETURN';
    return 'TO STOP';
  },

  // ── Internals ─────────────────────────────────────────────────────────────

  _nextInterval() {
    const u = Math.max(1e-6, dispatch.rng());
    return dispatch.simTime + (-Math.log(u) * dispatch.autoGenerate.meanInterval);
  },

  _slotNodeId(i) {
    return dispatch.homeSlots[i] || dispatch.homeSlots[dispatch.homeSlots.length - 1] || null;
  },

  _parkAll() {
    state.agvs.forEach((w, i) => {
      const slotId = this._slotNodeId(i);     // AGV i ↔ home slot i (#AGVs should equal #homes)
      const node   = slotId ? state.nodes[slotId] : null;
      w.homeSlot     = slotId;
      w.agvPos       = node ? { x: node.x, y: node.y } : { x: 40 + i * 50, y: 40 };
      w.agvHeading   = 0;
      w.currentNode  = slotId;                // node id the AGV is parked at / holding
      w.sequence     = [];
      w.currentStep  = 0;
      w.actionTimer  = 0;
      w.trolleyState = 'empty';
      w.trolleyPos   = null;
      w.phase        = 'parked';
      w.job          = null;
      w.waiting      = false;
      if (w.currentNode) dispatch.reserved.set(w.currentNode, w.id);
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
    if (!dispatch.autoGenerate.enabled || dispatch.groupOrder.length === 0) return;
    while (dispatch.simTime >= dispatch.nextGenTime) {
      const idx = Math.floor(dispatch.rng() * dispatch.groupOrder.length) % dispatch.groupOrder.length;
      this.enqueue({ group: dispatch.groupOrder[idx] });
      dispatch.nextGenTime = this._nextInterval();
    }
  },

  _pickIdle(agvId) {
    const idle = state.agvs.filter(w => w.phase === 'parked');
    if (agvId) return idle.find(w => w.id === agvId) || null;
    return idle[0] || null;
  },

  // Strict FIFO: if the head request can't be assigned (e.g. pinned to a busy
  // AGV), the whole queue waits.
  _assign() {
    while (dispatch.queue.length > 0) {
      const req = dispatch.queue[0];
      const w   = this._pickIdle(req.agv);
      if (!w) break;
      dispatch.queue.shift();
      this._startJob(w, req.group);
    }
  },

  // Build the walker's sequence: the group's explicit nodes, then a straight
  // return to THIS AGV's own home. The AGV is parked at home, so its first move
  // (home → group's first node) is also a straight leg.
  _startJob(w, groupId) {
    const g = dispatch.groups[groupId];
    if (!g || g.stops.length === 0 || !w.homeSlot) return;
    const stops = g.stops.map(s => {
      const o = { node: s.node, action: s.action,
                  dwell: s.dwell ?? (s.action === 'move' ? 0 : dispatch.serviceTime) };
      if (s.label) o.label = s.label;
      if (s.mode === 'manual') o.mode = 'manual';
      return o;
    });
    w.job         = groupId;
    w.waiting     = false;
    w.sequence    = [...stops, { node: w.homeSlot, action: 'move', dwell: 0 }];
    w.currentStep = 0;
    w.actionTimer = 0;
    routeWalkerToStep(w);   // animplayer.js — starts the straight move to step 0
  },
};
