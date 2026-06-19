// loopdispatch.js — zoned pairing dispatch engine for the loop-mode (TBM trolley)
// simulation. Parallel to dispatch.js (group/FIFO mode); the Animation Player picks
// one engine per layout via layout.sim.mode. Both expose the same surface
// (isActive / init / reset / enqueue / update / allComplete / *Snapshot / stateLabel)
// so tick() is engine-agnostic.
//
// Model (see _sample_docs/agv_dispatch_system_design): machines (TBMs) sit on a
// one-way loop; each is allocated to a serving AGV (its zone). A call = (machine,
// trolley-type). Per zone, the engine waits for 2 calls then pairs them FCFS (or
// dispatches a single after pairTimeout). It orders the pair by loop position,
// loads the train so REAR = first stop / FRONT = second stop, routes the AGV around
// the loop store→stops→store, and drives the per-machine confirmation LEDs.
//
// Movement, dwell and geometric collision are reused from animplayer.js (the engine
// only emits the same `sequence` shape the walker consumes). Relies on globals
// `state`, `routeWalkerToStep` (animplayer.js), `buildLoopRing`, `makeRng` (shared.js).

const loopdispatch = {
  mode:        'idle',       // 'idle' | 'loop'
  store:       null,         // store node id (single load/unload)
  ring:        [],           // ordered loop node ids from store
  ringIndex:   {},           // nodeId -> index in ring
  trolleyTypes: [],
  serviceTime: 3,
  trainSize:   2,
  pairTimeout: 200,          // seconds a lone call waits before a single-trolley trip
  homeSlots:   [],
  machineAgv:  {},           // machineId -> serving AGV id (zone allocation)
  downAgvs:    new Set(),    // AGVs flagged offline → single-AGV degraded mode
  queue:       [],           // FIFO of calls { machine, type, t }
  led:         {},           // machineId -> 'off' | 'blink' | 'solid'
  rng:         Math.random,
  simTime:     0,
  timelineIdx: 0,
  requests:    [],
  autoGenerate: { enabled: false, meanInterval: 6, seed: 1234 },
  nextGenTime: Infinity,
};

const LoopDispatch = {
  isActive() { return loopdispatch.mode === 'loop'; },

  init(layout) {
    const L = loopdispatch;
    L.store        = layout.sim.store || null;
    L.ring         = buildLoopRing(layout.path, L.store);
    L.ringIndex    = {};
    L.ring.forEach((id, i) => { L.ringIndex[id] = i; });
    L.trolleyTypes = layout.trolleyTypes || [];
    L.serviceTime  = layout.sim.serviceTime;
    L.trainSize    = layout.sim.trainSize || 2;
    L.pairTimeout  = layout.sim.pairTimeout || 200;
    L.homeSlots    = layout.homeSlots || [];
    L.requests     = layout.sim.requests || [];
    L.autoGenerate = layout.sim.autoGenerate;
    L.queue        = [];
    L.downAgvs     = new Set();

    // machine -> serving AGV (zone). Fall back to round-robin over AGVs if a
    // machine has no explicit allocation, so a partially-authored layout still runs.
    L.machineAgv = {};
    const agvIds = (layout.agvs || []).map(a => a.id);
    let rr = 0;
    for (const [id, s] of Object.entries(layout.stations || {})) {
      if (s.role !== 'tbm') continue;
      L.machineAgv[id] = (s.agv && agvIds.includes(s.agv)) ? s.agv : (agvIds[rr++ % agvIds.length] || null);
    }

    const haveMachines = Object.keys(L.machineAgv).length > 0;
    L.mode = (L.store && L.ring.length > 0 && haveMachines && (layout.agvs || []).length > 0) ? 'loop' : 'idle';
    L.led = {};
    Object.keys(L.machineAgv).forEach(id => { L.led[id] = 'off'; });
    return L.mode === 'loop';
  },

  reset() {
    const L = loopdispatch;
    L.queue       = [];
    L.simTime     = 0;
    L.timelineIdx = 0;
    L.rng         = makeRng(L.autoGenerate.seed);
    L.nextGenTime = L.autoGenerate.enabled ? this._nextInterval() : Infinity;
    Object.keys(L.led).forEach(id => { L.led[id] = 'off'; });
    this._parkAll();
  },

  // ── Public API ─────────────────────────────────────────────────────────────

  // A call selects a machine + the empty-trolley type to deliver.
  enqueue(req) {
    const L = loopdispatch;
    if (L.mode !== 'loop' || !req || !L.machineAgv[req.machine]) return;
    const type = (req.type && L.trolleyTypes.some(t => t.id === req.type))
      ? req.type : (L.trolleyTypes[0] && L.trolleyTypes[0].id);
    L.queue.push({ machine: req.machine, type, t: L.simTime });
  },

  update(dt) {
    this._reclaim();
    loopdispatch.simTime += dt;
    this._fireTimeline();
    this._autoGen();
    this._assign();
    this._recomputeLed();
  },

  // Degraded mode toggle: mark an AGV offline (or back online).
  setAgvDown(agvId, down) {
    if (down) loopdispatch.downAgvs.add(agvId);
    else      loopdispatch.downAgvs.delete(agvId);
  },

  allComplete() {
    const L = loopdispatch;
    return L.mode === 'loop'
      && !L.autoGenerate.enabled
      && L.timelineIdx >= L.requests.length
      && L.queue.length === 0
      && state.agvs.every(w => w.phase === 'parked');
  },

  queueLength() { return loopdispatch.queue.length; },
  ledState(machineId) { return loopdispatch.led[machineId] || 'off'; },
  servingAgv(machineId) { return loopdispatch.machineAgv[machineId] || null; },
  isDown(agvId) { return loopdispatch.downAgvs.has(agvId); },

  pendingByMachine() {
    const counts = {};
    loopdispatch.queue.forEach(c => { counts[c.machine] = (counts[c.machine] || 0) + 1; });
    return counts;
  },

  queueSnapshot() {
    return loopdispatch.queue.map((c, idx) => ({
      order: idx + 1, machine: c.machine, type: c.type, state: 'pending',
    }));
  },

  runningSnapshot() {
    return state.agvs.filter(w => w.job).map(w => ({
      agv: w.id,
      stops: (w.tripStops || []).slice(),
      train: (w.train || []).map(s => ({ slot: s.slot, type: s.type, state: s.state })),
      state: this.stateLabel(w),
    }));
  },

  // Trolley types to prepare (front/rear) for AGVs currently loading at the store.
  prepareDisplay() {
    return state.agvs
      .filter(w => w.job && w.phase === 'action_pause' && w.sequence[w.currentStep]?.action === 'load')
      .map(w => ({
        agv: w.id,
        front: (w.train.find(s => s.slot === 'front') || {}).type || null,
        rear:  (w.train.find(s => s.slot === 'rear')  || {}).type || null,
      }));
  },

  stateLabel(w) {
    if (w.phase === 'parked') return 'HOME';
    if (!w.job)               return w.phase.toUpperCase();
    if (w.waiting)            return 'WAIT';
    const seqE = w.sequence[w.currentStep];
    if (w.phase === 'action_pause') {
      if (seqE?.action === 'load')   return 'LOADING';
      if (seqE?.action === 'unload') return 'UNLOADING';
      if (seqE?.action === 'swap')   return 'SWAP';
    }
    // En route: heading back if no swap remains ahead.
    const swapAhead = w.sequence.slice(w.currentStep).some(s => s.action === 'swap');
    return swapAhead ? 'TO STOP' : 'RETURN';
  },

  // ── Internals ────────────────────────────────────────────────────────────

  _nextInterval() {
    const L = loopdispatch;
    const u = Math.max(1e-6, L.rng());
    return L.simTime + (-Math.log(u) * L.autoGenerate.meanInterval);
  },

  _slotNodeId(i) {
    const hs = loopdispatch.homeSlots;
    return hs[i] || hs[hs.length - 1] || loopdispatch.store || null;
  },

  _parkAll() {
    state.agvs.forEach((w, i) => {
      const slotId = this._slotNodeId(i);
      const node   = slotId ? state.nodes[slotId] : null;
      w.homeSlot    = slotId;
      w.agvPos      = node ? { x: node.x, y: node.y } : { x: 40 + i * 50, y: 40 };
      w.agvHeading  = 0;
      w.currentNode = slotId;
      w.sequence    = [];
      w.currentStep = 0;
      w.actionTimer = 0;
      w.load        = 'none';
      w.train       = [];
      w.tripStops   = [];
      w.phase       = 'parked';
      w.job         = null;
      w.waiting     = false;
    });
  },

  _reclaim() {
    state.agvs.forEach(w => {
      if (w.job && w.phase === 'done') {
        w.phase     = 'parked';
        w.job       = null;
        w.sequence  = [];
        w.currentStep = 0;
        w.train     = [];
        w.tripStops = [];
        w.waiting   = false;
      }
    });
  },

  _fireTimeline() {
    const L = loopdispatch;
    while (L.timelineIdx < L.requests.length && L.requests[L.timelineIdx].t <= L.simTime) {
      this.enqueue(L.requests[L.timelineIdx]);
      L.timelineIdx++;
    }
  },

  _autoGen() {
    const L = loopdispatch;
    const machines = Object.keys(L.machineAgv);
    if (!L.autoGenerate.enabled || machines.length === 0) return;
    while (L.simTime >= L.nextGenTime) {
      const m = machines[Math.floor(L.rng() * machines.length) % machines.length];
      const t = L.trolleyTypes[Math.floor(L.rng() * L.trolleyTypes.length) % L.trolleyTypes.length];
      this.enqueue({ machine: m, type: t && t.id });
      L.nextGenTime = this._nextInterval();
    }
  },

  // The AGV that will actually serve a call: its zone's AGV, unless that AGV is
  // offline — then the first live AGV picks it up (single-AGV degraded mode).
  _liveAgvs() { return state.agvs.filter(w => !loopdispatch.downAgvs.has(w.id)); },

  _effectiveServer(call) {
    const L = loopdispatch;
    const owner = L.machineAgv[call.machine];
    if (owner && !L.downAgvs.has(owner)) return owner;
    const live = this._liveAgvs();
    return live.length ? live[0].id : null;   // degraded: funnel to the live AGV
  },

  // Per idle live AGV, pull its servable calls in FCFS order and dispatch a pair
  // (or a single after the timeout). Each AGV pairs only within its own bucket.
  _assign() {
    const L = loopdispatch;
    for (const w of state.agvs) {
      if (w.phase !== 'parked' || L.downAgvs.has(w.id)) continue;
      const mine = L.queue.filter(c => this._effectiveServer(c) === w.id);
      if (mine.length === 0) continue;

      let take;
      if (mine.length >= 2) {
        take = mine.slice(0, this.trainSizeCap());        // first N (FCFS)
      } else if (L.simTime - mine[0].t >= L.pairTimeout) {
        take = [mine[0]];                                  // lone call timed out → single trip
      } else {
        continue;                                          // wait for a second call
      }

      const taken = new Set(take);
      L.queue = L.queue.filter(c => !taken.has(c));
      this._startTrip(w, take);
    }
  },

  trainSizeCap() { return Math.max(1, loopdispatch.trainSize); },

  // Build the loop route + train for a paired (or single) trip.
  _startTrip(w, calls) {
    const L = loopdispatch;
    if (!w.homeSlot || !L.store || L.ring.length === 0) return;

    // Visit order = loop position. REAR = first stop (easy detach), FRONT = second.
    const stops = calls.slice().sort((a, b) =>
      (L.ringIndex[a.machine] ?? 1e9) - (L.ringIndex[b.machine] ?? 1e9));
    const rearStop  = stops[0];
    const frontStop = stops[1] || null;

    const train = [];
    if (frontStop) train.push({ slot: 'front', type: frontStop.type, state: 'empty' });
    train.push({ slot: 'rear', type: rearStop.type, state: 'empty' });

    // Sequence: drive to store (load), follow the ring forward through the stops and
    // all the way back around to the store (unload), then park at the wait spot.
    const seq = [{ node: L.store, action: 'load', dwell: L.serviceTime, store: true }];
    const stopByNode = new Map(stops.map(s => [s.machine, s]));
    const si = L.ringIndex[L.store] ?? 0;
    for (let k = 1; k <= L.ring.length; k++) {
      const node = L.ring[(si + k) % L.ring.length];
      if (node === L.store) break;                         // closed the loop
      if (stopByNode.has(node)) {
        const s = stopByNode.get(node);
        seq.push({ node, action: 'swap', dwell: L.serviceTime, machine: node,
                   slot: node === rearStop.machine ? 'rear' : 'front', deliverType: s.type });
      } else {
        seq.push({ node, action: 'move' });
      }
    }
    seq.push({ node: L.store, action: 'unload', dwell: L.serviceTime, store: true });
    seq.push({ node: w.homeSlot, action: 'move' });        // back to wait spot

    w.job         = 'loop';
    w.tripStops   = stops.map(s => s.machine);
    w.train       = train;
    w.sequence    = seq;
    w.currentStep = 0;
    w.actionTimer = 0;
    w.waiting     = false;
    routeWalkerToStep(w);
  },

  // LED per machine: blink while a call is queued or its trip is loading at store;
  // solid once the serving AGV has departed and the stop is still ahead; off when
  // serviced (the AGV has passed that swap).
  _recomputeLed() {
    const L = loopdispatch;
    const led = {};
    Object.keys(L.machineAgv).forEach(id => { led[id] = 'off'; });
    L.queue.forEach(c => { led[c.machine] = 'blink'; });
    for (const w of state.agvs) {
      if (!w.job) continue;
      const loading = w.sequence[w.currentStep]?.action === 'load';   // still at store
      for (let k = w.currentStep; k < w.sequence.length; k++) {
        const s = w.sequence[k];
        if (s.action === 'swap' && s.machine) led[s.machine] = loading ? 'blink' : 'solid';
      }
    }
    L.led = led;
  },
};
