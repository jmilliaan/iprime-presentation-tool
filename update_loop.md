# Update: loop dispatch is moving from AGV→ZONE to AGV→LOOPS

> **Read this if your mental model of "loop mode" is "each AGV owns a *zone* (a flat set of
> machines) on one big ring, and the engine pairs any 2 calls in that zone."** That model is being
> replaced. This document explains the change, the target model, and what in the code/schema must
> change. Pair it with [JSON_FORMAT.md](JSON_FORMAT.md) (current format) and the loop section of
> [README.md](README.md) (current behaviour).

---

## 1. TL;DR of the change

| | **OLD (current code)** | **NEW (target)** |
|---|---|---|
| Allocation unit | **Zone** = one AGV owns a flat set of machines | **Loop** = a fixed *route* + its machine set; **an AGV owns several loops** |
| Track | **One** global one-way cycle, derived from the store (`buildLoopRing`) | **Several** explicit loop routes over a **branched** track, all rooted at a common home/attach area |
| Pairing bucket | by **AGV/zone** — any 2 calls the AGV serves can pair | by **LOOP** — 2 calls can pair **only if on the same loop** |
| A trip | one lap of the global ring, ≤`trainSize` machines | **exactly one loop**, ≤`trainSize` machines |
| Load / unload | single **store** node does both | **Attach-trolley** node loads empties; **Home** node unloads fulls (two distinct nodes) |

The driver: the real plant (below) is **not one cycle**. It is a branched network with **4 distinct
loops** that share a spine and all start/end at one home/attach area. The old single-ring, pair-by-zone
engine cannot express that.

---

## 2. The OLD model, precisely (so you know what to unlearn)

In [loopdispatch.js](loopdispatch.js) today:

- `machineAgv[machineId] = agvId` — each machine is allocated to a serving AGV. **That allocation *is*
  the zone.** (Built in `init`, ~L61-67.)
- `_assign()` (~L255-275) buckets the pending-call queue **by AGV**:
  `mine = queue.filter(c => effectiveServer(c) === w.id)`, then takes the first 2 (FCFS) — or 1 after
  `pairTimeout`. **Any two calls the AGV serves may pair, regardless of where they are.**
- `_startTrip()` (~L280-321) orders the paired stops by position on the **single** ring
  (`buildLoopRing(path, store)` in [shared.js](shared.js#L376)) and builds the sequence
  `store(load) → walk ring → swap at each stop → store(unload) → home`.

So "loop mode" today = *one ring + zone pairing*. **This is the thing that's changing.**

---

## 3. The NEW model (target)

### Entities
- **Loop** — a first-class object: an **owning AGV**, an **explicit ordered route**, and the **set of
  machines** on it. Machines belong to **exactly one** loop. A loop's route is authored (the track is
  branched, so it cannot be auto-derived as a single cycle).
- **AGV** — owns **one or more loops** (no longer "a zone"). It services its loops, one loop per trip.
- **Attach-trolley node** — where empties are loaded onto the train, *after* a call (replaces the
  load half of the store).
- **Home node** — per-AGV parking spot where **full trolleys are detached** at end of trip (replaces
  the unload half of the store; also the park slot). Each AGV has its own home.

### Pairing policy (the headline rule)
Pairing buckets **by loop, not by AGV**. Two calls share a trip **iff they are on the same loop**.
An AGV with two of its loops each holding calls runs them as **separate trips** — it never merges
loops. Concretely: replace the `machineAgv` bucketing with `machineLoop`, and dispatch per loop.

### Per-trip lifecycle
1. AGV idle, **parked at its Home**.
2. Calls accumulate, **bucketed per loop**.
3. A loop owned by this AGV becomes dispatchable (≥2 calls on that loop, or 1 call past `pairTimeout`).
4. Trip:
   `Home → Attach-trolley (wait + confirm: load empties, rear = first stop, front = second)
        → drive that loop's route, swap empty→full at each called machine
        → Home (detach fulls) → park (idle)`.
5. Charging: **ignored** in the sim.

`trainSize` (default 2) still caps machines per trip, so a loop with many pending calls is cleared
**a few at a time over multiple trips** (NOT "serve all pending on the loop in one pass").

---

## 4. The concrete plant (the motivating instance)

Floor: "103 TYRE BUILDING". Combined **Home + Attach** area on the right side. **2 AGVs, 4 loops, 38
machines:**

| Loop | Owning AGV | Machines (count) |
|------|-----------|------------------|
| **Loop 1** | AGV-1 | MRU 1–4 (4) |
| **Loop 2** | AGV-1 | BTU 9–24 (16) |
| **Loop 3** | AGV-2 | BTU 1–8 + STU 1–6 (14) |
| **Loop 4** | AGV-2 | STU 7–10 (4) |

Policy restated in plant terms: **AGV-1 serves loops 1 & 2; AGV-2 serves loops 3 & 4. Loops 1 and 2
cannot go together; loops 3 and 4 cannot go together** (per-loop pairing). Each AGV has its own home
(Home AGV1, Home AGV2); both use the shared Attach-trolley node.

Some stop positions physically serve **two machines** (one stop ↔ 2 machines) — modelling of this is
still open (see §7).

---

## 5. Proposed schema additions (NOT yet implemented — for discussion)

The current schema has **no loop concept**; this is the minimal extension. Treat the field names as a
proposal to confirm.

```jsonc
{
  // … PATH / STATIONS / AGVS / TROLLEY_TYPES as today …

  "STATIONS": {
    // machines unchanged except: their loop is derived from LOOPS[].route membership
    "MRU1": { "x": …, "y": …, "role": "tbm" },
    // NEW roles (or reuse): the attach point and homes
    "ATT":  { "x": …, "y": …, "role": "attach" },   // single shared load point
    "HOME-1": { "x": …, "y": …, "role": "home" },
    "HOME-2": { "x": …, "y": …, "role": "home" }
  },

  "LOOPS": {
    "L-1": {
      "name": "MRU loop",
      "agv":  "AGV-01",
      // explicit travel order over PATH corners + machine stops, from the first node
      // AFTER attach to the last node BEFORE returning home. Machines on this loop are
      // the route entries that are `tbm` stations.
      "route": ["P-10", "MRU1", "MRU2", "MRU3", "MRU4", "P-11"]
    },
    "L-2": { "name": "BTU 9–24", "agv": "AGV-01", "route": [ … "BTU24", …, "BTU9" … ] },
    "L-3": { "name": "BTU 1–8 + STU 1–6", "agv": "AGV-02", "route": [ … ] },
    "L-4": { "name": "STU 7–10", "agv": "AGV-02", "route": [ … ] }
  },

  "HOME": { "slots": ["HOME-1", "HOME-2"] },        // AGV i ↔ slot i (unchanged)

  "SIM": {
    "mode": "loop",
    "attach": "ATT",          // NEW: shared attach-trolley node id
    "trainSize": 2,
    "pairTimeout": 200,
    "serviceTime": 3,
    "agvSpeed": 120
    // NOTE: SIM.store is superseded by SIM.attach (load) + per-AGV HOME (unload)
  }
}
```

Derived at load time:
- `machineLoop[machineId]` from each `LOOPS[id].route` (a machine appears in exactly one route).
- `loopAgv[loopId] = LOOPS[id].agv`.
- The engine wraps each loop trip as `home → attach(load) → route(swaps) → home(unload)` — mirroring
  how group mode already wraps `home → stops → home`.

---

## 6. Engine changes required (in [loopdispatch.js](loopdispatch.js))

1. **Replace zone bucketing with loop bucketing.** In `init`, build `machineLoop` + `loopAgv` from
   `LOOPS` instead of (or in addition to) `machineAgv`.
2. **`_assign()`** — iterate each idle AGV's **loops**; for each loop, bucket its pending calls; pair 2
   (or single after timeout) **within that loop only**; dispatch a trip for that one loop. Never merge
   loops.
3. **`_startTrip()`** — stop ordering follows the **loop's authored `route`** (not the global ring);
   build sequence `home → attach(load) → route swaps → home(unload)`. Drop the `buildLoopRing`
   dependency for routing (it may still help validation).
4. **Nodes** — introduce `attach` handling (load empties + confirm dwell) and make Home the
   unload+park point. Retire single-`store` load/unload, or keep `store` as an alias.
5. **LEDs / snapshots / degraded mode** — re-express in terms of loops. (Degraded mode is open: if an
   AGV is down, do its loops get reassigned to the other AGV? See §7.)

---

## 7. Open / unconfirmed items (do not treat as settled)

- **trainSize stays 2 per trip** (clear loops a few machines at a time) — *assumed*, pending final OK.
- **Loop routes authored explicitly** (vs auto-derived) — *assumed yes* (branched track forces it).
- **Attach node** is a single shared node; "wait for confirm" is a fixed dwell (`serviceTime`) —
  *assumed yes*.
- **One stop ↔ two machines**: how to model a position that services two machines (two trolleys at one
  stop? two independent calls funnelling to one stop?) — **unresolved**.
- **Degraded mode** semantics under loops (reassign a down AGV's loops?) — **unresolved**.
- **Layout Picker authoring** of loops (drawing a route + assigning its AGV) does not exist yet — needs
  design.

---

## 8. How to convey the plant's shape to an LLM (process note)

Do **not** rely on the floor-plan image or prose to communicate the 38-machine branched topology — an
LLM cannot reconstruct it reliably. Make it **data**:

1. Draw the track in the **Layout Picker** and save JSON → `PATH.nodes`/`edges` capture exact geometry
   and connectivity.
2. Define the **`LOOPS`** explicitly (§5) so each loop's route + owning AGV is data, not inferred.
3. Give the LLM the **JSON instance + this doc + [JSON_FORMAT.md](JSON_FORMAT.md)**. The image is a
   human aid only; the JSON is the source of truth.
