# Reading iPrime Layout JSON — Technical Reference

> **Audience:** an engineer (or LLM) who has *never seen this codebase* and is handed one of its
> `.json` files. Goal: be able to fully read, validate, and mentally simulate a layout file without
> running anything. This document is self-contained.

---

## 1. What these files are

The iPrime Presentation Tool is a browser-based AGV (Automated Guided Vehicle) simulator. A human
draws a factory floor layout in a "Layout Picker" and saves it as a JSON file (often `coords.json`).
An "Animation Player" loads that JSON and animates AGVs (little robots) driving routes, towing
trolleys, and serving stations — for making recorded demo videos.

So a layout JSON is a **complete declarative description of a simulation**: the track geometry, the
robots, the jobs they can do, and a script of when work arrives. There is **no code in the file** —
just data. Everything below describes how that data is interpreted.

There are **two distinct simulation engines**, and a single field (`SIM.mode`) picks which one a file
targets:

| Mode | `SIM.mode` | What it models | Key sections used |
|------|-----------|----------------|-------------------|
| **Group / FIFO** (default) | absent or anything ≠ `"loop"` | On-demand multi-stop delivery jobs, dispatched FIFO to idle AGVs | `GROUPS`, `CALLS`, `STATIONS(action/home)` |
| **Loop** | `"loop"` | Machines that get typed calls; AGVs tow a train of trolleys; calls are paired | `STATIONS(tbm/attach/store/home)`, `TROLLEY_TYPES`, `LOOPS`, loop fields in `SIM` |

A file is almost always *one or the other*. Identify the mode first; it changes how you read
`STATIONS` and `SIM.requests`.

**Loop mode has two allocation sub-models**, distinguished by whether the file defines a `LOOPS` object:

| Sub-model | Selector | Allocation | Load / unload | Pairing bucket |
|-----------|----------|-----------|---------------|----------------|
| **Loops** | `LOOPS` present | An AGV owns several **loops** (each a route + machine set) | **attach** node loads; per-AGV **home** unloads | per **loop** |
| **Zone** (legacy) | no `LOOPS`, has a `store` | Each machine owned by an AGV (`tbm.agv`) = its **zone**; one global ring | single **store** does both | per **AGV/zone** |

---

## 2. Coordinate system & units

- All positions (`x`, `y`) are in **image-space pixels** of the (optional) floor-plan background.
- **Origin is top-left. `x` grows right, `y` grows DOWN** (standard HTML canvas convention, *not*
  math convention).
- **Headings** (not stored in the file, but used at runtime) are degrees measured `atan2(dy, dx)`:
  `0°` = pointing right (+x), `90°` = pointing **down** (+y), `180°` = left, `270°` = up.
- **Time** (`SIM.requests[].t`, `serviceTime`, `pairTimeout`) is in **seconds** of simulated time.
- **Speed** (`SIM.agvSpeed`) is in **pixels per second**.

---

## 3. Top-level shape

```jsonc
{
  "PATH":          { "nodes": {…}, "edges": [...] },
  "STATIONS":      { …id → {x,y,role,…} },
  "AGVS":          [ {id,color}, … ],
  "TROLLEY_TYPES": [ {id,name,color}, … ],   // optional; loop mode only
  "GROUPS":        { …id → {name,stops,homeStart,homeEnd} },   // group mode
  "CALLS":         [ {x,y,group}, … ],        // group mode
  "LOOPS":         { …id → {name,agv,route} }, // loop mode (loops sub-model)
  "HOME":          { "slots": [stationId, …] },
  "SIM":           { …playback config + request script }
}
```

Every section is **optional and defaulted** by the loader — a partial file still loads. Missing
arrays/objects become empty; bad cross-references are silently dropped (see §10). Do not assume a
field is present; assume the loader filled a default.

---

## 4. Section-by-section reference

### 4.1 `PATH` — the drawn track (geometry only)

```jsonc
"PATH": {
  "nodes": { "P-1": { "x": 200, "y": 300 }, … },
  "edges": [
    { "id": "E-1", "from": "P-1", "to": "P-H", "type": "straight" },
    { "id": "E-2", "from": "P-H", "to": "P-4", "type": "arc", "radius": 120, "clockwise": true }
  ]
}
```

- `nodes` is a map of **corner id → point**. These are the geometric vertices of the track.
- `edges` connect two corners. `type` is `"straight"` or `"arc"`; arcs add `radius` and `clockwise`
  (visual clockwise in y-down space).
- **CRITICAL — edges are a visual guide, not a movement constraint.** AGVs always drive in **straight
  lines between consecutive nodes** of their route. A drawn arc edge is *only rendered* as a curve;
  the robot cuts it as a chord. So `type/radius/clockwise` never affect motion or timing — they are
  cosmetic. (To make an AGV follow a curve, the author adds more corners along it.)
- Edges whose `from`/`to` is not in `nodes` are dropped by the loader.
- Defaults applied if omitted: `type` → `straight`, `radius` → `100`, `clockwise` → `true`.
- In **loop mode**, edges additionally define the **one-way cycle** the ring router walks (see §6),
  so there `from→to` direction is meaningful.

### 4.2 `STATIONS` — points where something happens

```jsonc
"STATIONS": {
  "HS-1": { "x": 175, "y": 180, "role": "home" },
  "LA":   { "x": 848, "y": 180, "role": "action" },
  "M1":   { "x": 220, "y": 120, "role": "tbm", "agv": "AGV-01" },   // zone model
  "S2":   { "x": 360, "y": 120, "role": "tbm", "stop": "P-10" },    // loops: serviced at P-10
  "ATT":  { "x": 900, "y": 400, "role": "attach" },                 // loops model
  "ST":   { "x": 120, "y": 400, "role": "store" }                   // zone model
}
```

A station is a named point with a **`role`** that determines its behavior. There are exactly five
valid roles; an unknown role falls back to `"action"`.

| `role` | Mode | Meaning |
|--------|------|---------|
| `action` | group | A stop where the AGV **sets its towed-trolley load** (to none/empty/full). Placed freely anywhere. |
| `home` | both | A **parking / wait slot**, one per AGV. Listed in `HOME.slots`. In the loops model it is also the **unload** point. Excluded from group routes; added per-AGV automatically. |
| `tbm` | loop | A **machine** (demand point). Zone model: carries `agv` = the **serving AGV** (its zone). Loops model: optional `stop` = the route node it's serviced at (default = its own id); two `tbm`s sharing a `stop` = a **shared stop**. |
| `store` | loop (zone) | The single **load/unload** point of the legacy ring. One per zone-model layout. **Legacy: still loaded/run, but no longer created by the Layout Picker.** |
| `attach` | loop (loops) | The shared **load** point (empties loaded here). One per loops-model layout; paired with per-AGV `home` unload. Free-floating (the AGV drives straight to it). |

Notes:
- Any station may carry an optional **`name`** — a *visual display label* shown in the Picker and player
  (machine markers, the call type-picker). It is **display-only**: the station **key/id** (e.g. `M-7`) is
  the **operational** name used in `LOOPS[].route`, `stop`, `HOME.slots`, etc. Renaming changes `name`,
  never the id. If `name` is absent, the id is shown.
- Only `tbm` stations carry `agv` (zone) and `stop` (loops shared stop). Other roles ignore them.
- **A `tbm`/`store`/`attach` station id usually equals a `PATH.nodes` id** — the same id appears in
  *both* `PATH.nodes` and `STATIONS`. Load-bearing for routing; see §6.
- `action`/`home` station ids are independent of path corners (e.g. `HS-1`, `LA`) and are *not* on the
  path graph — the AGV just drives straight to their coordinates.

### 4.3 `AGVS` — the robots

```jsonc
"AGVS": [ { "id": "AGV-01", "color": "#E63946", "heading": 0 }, … ]
```

Identity, render colour, and an optional initial heading. The number of AGVs should equal the number of
`HOME.slots` (**AGV index *i* parks at `HOME.slots[i]`**). Defaults: `id` → `AGV-0{i+1}`, `color` → a
rotating palette (`#E63946, #4080e0, #1a9c50, #cc44aa`). `heading` is the AGV's **initial (parked)
facing** — one of `0 / 90 / 180 / 270` (degrees, y-down; default `0`), clamped to those four. It governs
only the earliest/parked state; once the AGV moves it auto-faces its travel direction. The AGV body is
rendered as an elongated **tag** (1.5× long along heading × the lateral width) with a chamfered nose.

### 4.4 `TROLLEY_TYPES` — loop mode only (optional)

```jsonc
"TROLLEY_TYPES": [ { "id": "TT-1", "name": "Type 1", "color": "#E63946" }, … ]
```

The catalogue of empty-trolley types a machine can request. If omitted, a **default 6-type palette**
is used. Referenced by `SIM.requests[].type` (loop mode). Ignored in group mode.

### 4.5 `GROUPS` — reusable jobs (group mode)

```jsonc
"GROUPS": {
  "G-A": {
    "name": "Deliver to A",
    "homeStart": "attach-full",
    "homeEnd":   "none",
    "stops": [
      { "node": "P-H", "action": "move" },
      { "node": "P-4", "action": "move" },
      { "node": "LA",  "action": "none" },
      { "node": "P-4", "action": "move" },
      { "node": "P-H", "action": "move" }
    ]
  }
}
```

A group is an **explicit, ordered list of nodes to visit** — there is **no pathfinding**. The AGV
goes to each `stop.node` in order, straight-line between them.

- **The key (`"G-A"`) is the group's stable ID** used by `CALLS` and `SIM.requests`. `name` is just a
  human label and may be renamed without breaking references.
- `stops[].node` is a **path corner OR a station id**. Stops referencing nonexistent nodes are dropped.
- `stops[].action` — what the AGV does on arrival. After normalization it is one of:

  | `action` | Effect |
  |----------|--------|
  | `move` | Pass-through; no load change; **dwell 0**. |
  | `none` | Set towed load to **none** (drop trolley). |
  | `empty` | Set towed load to **empty** trolley. |
  | `full` | Set towed load to **full** trolley. |

  The load is a *latched state*: once a stop sets `full`, the AGV tows a full trolley until a later
  stop changes it.
- `stops[].dwell` *(optional, seconds)* — explicit pause at this stop; overrides the default. If
  absent, dwell = `0` for `move`, else `SIM.serviceTime`.
- `stops[].label` *(optional)* — text shown above the AGV during the stop.
- `stops[].mode: "manual"` *(optional)* — draws a little "person" figure at the stop (a human-handled
  step). Cosmetic.
- `homeStart` / `homeEnd` — an optional action performed at the **AGV's own home**, before leaving /
  on return. One of `none | attach-empty | attach-full | detach-empty | detach-full` (default `none`).
  `attach-*` hooks up a trolley before departure; `detach-*` drops it on return.

**Home is never listed in `stops`.** The dispatcher wraps each job as:
`[home (homeStart)] → stops… → [home (homeEnd)]`, using whichever home slot the assigned AGV owns.

### 4.6 `CALLS` — on-canvas call buttons (group mode)

```jsonc
"CALLS": [ { "x": 852, "y": 130, "group": "G-A" } ]
```

A free-floating clickable button at `(x,y)` that, when clicked in the player, enqueues a request for
`group`. `group` must be a valid key of `GROUPS` (else dropped). Purely an *input device* — it does
not constrain routing.

### 4.6b `LOOPS` — loop routes (loops sub-model)

```jsonc
"LOOPS": {
  "L-1": { "name": "MRU loop", "agv": "AGV-01",
           "route": ["P-10", "MRU1", "MRU2", "MRU3", "MRU4", "P-11"],
           "pair": false },                              // single-immediate
  "L-2": { "name": "BTU loop", "agv": "AGV-01",
           "route": [ … ], "pair": true, "pairTimeout": 15 }  // wait for 2, 15 s
}
```

Present **only** in the loops sub-model; its presence selects the loops engine. Each loop is:

- `name` — a human label.
- `agv` — the **owning AGV** (must be an `AGVS` id, else the loop is dropped). An AGV may own several
  loops; it runs **one loop per trip** and never merges loops.
- `route` — an **explicit ordered list of node ids** the AGV drives: path corners, machines, and
  **optionally the `attach` node** (place it where loading should happen along the path). Nodes not in
  `PATH.nodes`/`STATIONS` are dropped. There is **no pathfinding** — straight legs between consecutive
  route nodes (like a group). Home is *not* in the route (added automatically at start/end).
- `pair` *(default `true`)* — pairing policy. `false` → dispatch **each call immediately** as a
  single-trolley trip. `true` → **wait for 2 calls** on the loop (then a 2-trolley trip), or send a lone
  call single after `pairTimeout`.
- `pairTimeout` *(default `15`, seconds)* — for `pair:true` loops, how long a lone call waits for a
  partner before going single. Ignored when `pair:false`.

**Machine → loop** is derived: a `tbm` belongs to the loop whose `route` contains it, or contains its
`stop` node (shared stop). A machine in zero or multiple routes is a layout error. **Pairing buckets by
loop:** two calls pair only if on the same loop — any two on that loop (the AGV visits up to two stop
positions, or one if they share it). Each trip is `home → … route … → home(unload)`, loading at the
**attach** node: if the `route` lists the attach node, the AGV loads when it reaches it in sequence (so
it follows the track, e.g. `home → P-1 → … → attach → … → home`); if the route omits it, the engine
beelines to attach first (`home → attach → route → home`).

### 4.7 `HOME` — parking slot assignment

```jsonc
"HOME": { "slots": ["HS-1", "HS-2", "HS-3"] }
```

An ordered list of **`home`-role station ids**. **AGV *i* parks at `slots[i]`.** Invalid ids are
filtered out. Should have the same length as `AGVS` (if shorter, extra AGVs fall back to the last
slot).

### 4.8 `SIM` — playback config + request script

Shared fields:

```jsonc
"SIM": {
  "agvSpeed": 120,        // px/s            (default 120)
  "serviceTime": 3,       // s dwell at action/swap/load/unload stops (default 3)
  "trolleyMode": "tow",   // "tow" (trolley behind, default) | "lurk" (trolley on the AGV)
  "requests": [ … ],      // scripted timeline (see below)
  "autoGenerate": { "enabled": false, "meanInterval": 6, "seed": 1234 }
}
```

- `trolleyMode` — how a carried trolley is drawn (whole layout, one mode). **`tow`** (default) trails the
  trolley behind the AGV on a hitch; **`lurk`** places it **on top of** the AGV at the AGV's rotation.
  Applies to the **group system's single trolley**; loop-mode 2-trolley trains always tow. In `lurk` the
  trolley adds no trailing length, so following AGVs keep only the bare-AGV gap.

- `requests` is a **time-ordered script** of work. Its element shape **depends on mode**:
  - **Group mode:** `{ "t": <sec>, "group": "G-A", "agv": "AGV-01"? }` — at time `t`, enqueue group
    `G-A`. Optional `agv` **pins** it to a specific AGV (only that AGV may serve it; strict FIFO means
    the queue head will *wait* for that AGV). Entries with unknown `group` are dropped; list is sorted
    by `t`.
  - **Loop mode:** `{ "t": <sec>, "machine": "M2", "type": "TT-1" }` — at time `t`, a call for
    machine `M2` requesting empty trolley type `TT-1`. Entries whose `machine` is not a `tbm` station
    are dropped; an invalid/missing `type` falls back to the first trolley type; sorted by `t`.
- `autoGenerate` — a **seeded random** request generator (Poisson-ish via `meanInterval`). When
  `enabled`, the player can spawn random requests; `seed` makes it reproducible. When using a scripted
  `requests` timeline for a deterministic recording, this is normally `enabled:false`.

**Loop-mode-only `SIM` fields:**

```jsonc
"mode": "loop",
"trainSize": 2,         // trolleys per train / max calls paired per trip (default 2)
"pairTimeout": 200,     // s a lone call waits before going as a single-trolley trip (default 200)
"attach": "ATT",        // loops model: shared load node id (paired with per-AGV home unload)
"store": "ST"           // zone model: single load/unload node id
```

A loops-model file sets `attach`; a zone-model file sets `store`. Each resolves to the first station of
that role if the named one is missing/invalid.

---

## 5. Determining the mode (do this first)

The loader sets mode purely from the flag: **`mode = (SIM.mode === "loop") ? "loop" : "group"`.**

- It does **not** infer loop mode just because `tbm`/`store` stations exist. A file with machines but
  no `SIM.mode:"loop"` is treated as **group mode** (and those machines are effectively inert).
- Files saved by the Layout Picker set `SIM.mode:"loop"` automatically: with a `LOOPS` definition it
  also writes `SIM.attach` (loops sub-model). The Picker no longer authors a `store`, so `SIM.store`
  appears only in legacy/hand-authored zone files. Hand-authored loop files **must** include
  `SIM.mode:"loop"`.

Within loop mode the engine picks the **sub-model** by data: if `LOOPS` is non-empty → **loops**
(needs a valid `attach`, ≥1 machine mapped to a loop, ≥1 home, ≥1 AGV); otherwise → **zone** (needs a
valid `store`, a non-empty ring built from it, ≥1 machine, ≥1 AGV). If the requirements aren't met the
loop engine goes inert.

---

## 6. The loop-ring convention (critical for **zone-model** loop files)

> Applies to the **zone sub-model only**. In the **loops sub-model** routing follows each `LOOPS[].route`
> explicitly (§4.6b) — `buildLoopRing` is not used, and machines need not form a single cycle.

The zone model routes by **walking the `PATH` graph as a directed cycle**, not by straight lines between
arbitrary points. Understand this or you will misread zone-model files:

1. **Machines and the store are simultaneously `PATH.nodes` AND `STATIONS`** — the *same id* in both.
   E.g. in a loop file you'll see `"M1"` under `PATH.nodes` *and* `"M1"` under `STATIONS` with
   `role:"tbm"`. This is required so the machine is a vertex the ring can pass through.
2. The router starts at `store` and follows `edges` (`from → to`), always preferring an unvisited
   successor, until the cycle closes. This yields an **ordered ring** of node ids:
   `[store, n1, n2, …]`.
3. A machine is only ever visited **if it is a node on that ring.** A `tbm` station that is *not* a
   path node (no edges through it) gets index "infinity" and is **never serviced** — the trolley is
   loaded but never delivered. (For zone-model files, machines/the store must therefore sit on path
   corners that form the ring. The loops sub-model removes this constraint entirely — machines are
   free-floating and ordered by their position in `LOOPS[].route`.)
4. `edges` therefore must form a **single one-way cycle** through the store and all machines.

So when reading a loop file, reconstruct the ring by following the edges from `SIM.store`, and check
every `tbm` id appears in it.

---

## 7. What the loader normalizes / defaults (read JSON *as the app sees it*)

The file is passed through a normalizer before use. To read a file the way the app does, apply these:

- **PATH.edges:** drop edges with missing endpoints; `type→straight`, `radius→100`, `clockwise→true`
  defaults.
- **STATIONS:** clamp `role` to `action|home|tbm|store|attach` (else `action`); keep `agv` and `stop`
  only for `tbm`.
- **LOOPS:** drop loops whose `agv` isn't an `AGVS` id; filter `route` to existing nodes; drop empty;
  default `pair→true`, `pairTimeout→15`.
- **AGVS:** fill `id`/`color` defaults.
- **TROLLEY_TYPES:** default 6-type palette if absent/empty.
- **GROUPS.stops:** drop stops whose `node` doesn't exist; map `action` to `move|none|empty|full`
  (see §9 for legacy verbs); keep `dwell` only if numeric; keep `label`; keep `mode` only if
  `"manual"`.
- **GROUPS.homeStart/homeEnd:** clamp to the 5 valid home actions, else `none` (see §9 legacy note).
- **CALLS:** keep only those with a valid `group` and numeric `x,y`.
- **HOME.slots:** keep only ids that are real stations.
- **SIM:** `agvSpeed→120`, `serviceTime→3`, `trainSize→2`, `pairTimeout→200`,
  `autoGenerate.meanInterval→6`, `autoGenerate.seed→1234`; resolve `store` and `attach` (use the named
  station if it's a valid `store`/`attach`, else the first of that role, else null); parse `requests`
  per mode.

---

## 8. Invariants & cross-references to verify

When validating a file, check:

- `len(AGVS) == len(HOME.slots)` (AGV *i* ↔ slot *i*). Mismatch isn't fatal but parks AGVs oddly.
- Every `HOME.slots[i]` is a `home`-role station.
- Every `CALLS[].group` and every group-mode `requests[].group` is a key of `GROUPS`.
- Every `GROUPS[].stops[].node` is a `PATH.nodes` id or a `STATIONS` id.
- **Loop (zone):** exactly one `store`; `SIM.store` matches it; every `tbm` has a valid `agv` in `AGVS`;
  every `tbm` and the `store` are reachable on the ring (§6); `edges` form one directed cycle.
- **Loop (loops):** exactly one `attach`; `SIM.attach` matches it; every `LOOPS[].agv` is in `AGVS`;
  every `tbm` is on **exactly one** loop's `route` (directly or via its `stop`); a shared `stop` serves
  ≤ `trainSize` machines; per-AGV `HOME.slots` cover every AGV that owns a loop.
- **Loop (both):** `requests[].machine` is a `tbm`; `requests[].type` is a `TROLLEY_TYPES` id.

---

## 9. Legacy / migration gotchas

Older files still load (auto-converted), so you may encounter:

- **`CALL_STATIONS`** (instead of `CALLS`): `[{station, group}]` anchored to a station — converted to
  free-floating `CALLS` using that station's position.
- **Old stop verbs** `pickup` / `exchange` → mapped to `full`; `release` → mapped to `none`.
- **Old `homeStart`/`homeEnd` values** `"empty"` / `"full"` — these are **NOT** migrated to the new
  `attach-*`/`detach-*` vocabulary. Since they aren't valid home actions, they normalize to `none`
  (i.e., silently become "do nothing"). Watch for this in older group files (e.g. `homeStart:"full"`
  reads as `none`). `null` likewise becomes `none`.

---

## 10. Worked reading — a group/FIFO file

Given (abridged from `sample_dispatch.json`):

- `PATH`: a hub `P-H` with three spurs in (`P-1/2/3 → P-H`) and three out (`P-H → P-4/5/6`).
- `STATIONS`: homes `HS-1/2/3` (left), action sites `LA/LB/LC` (right).
- `AGVS`: 3 robots; `HOME.slots = [HS-1, HS-2, HS-3]` → AGV-01@HS-1, etc.
- `GROUPS.G-A`: `homeStart:"full"` (legacy → reads as **none**), stops
  `P-H, P-4, LA(none), P-4, P-H`.
- `SIM`: `agvSpeed 160`, `serviceTime 3`, scripted `requests` firing G-A/B/C/AB at t=1..4, then a
  **pinned** `{t:70, group:"G-A", agv:"AGV-01"}`.

How it runs: at t=1 the request for `G-A` enqueues; the first idle AGV (AGV-01) is dispatched. Its
full sequence becomes `HS-1 → P-H → P-4 → LA(set load none) → P-4 → P-H → HS-1`. It dwells 3 s at
`LA` (serviceTime), 0 s at `move` nodes. Meanwhile G-B/G-C go to AGV-02/03. At t=70 the pinned G-A
request will only be served by AGV-01 (others wait behind it in FIFO).

## 11. Worked reading — a loop file (zone model)

Given (abridged from `sample_loop.json`):

- `PATH` nodes form one cycle: `ST → A → M1 → M2 → M3 → M4 → B → C → M5 → M6 → M7 → M8 → D → ST`.
- `STATIONS`: `ST` is `store`; `M1..M4` are `tbm` served by **AGV-01** (zone 1); `M5..M8` are `tbm`
  served by **AGV-02** (zone 2); `HS1/HS2` are homes. No `LOOPS` → **zone** sub-model.
- `SIM`: `mode:"loop"`, `store:"ST"`, `pairTimeout:200`, 6 trolley types; scripted calls at t=1..4 on
  M2/M4 (zone 1) and M6/M8 (zone 2).

How it runs: the ring is built from `ST` following the edges. Calls bucket by zone. Zone 1 gets calls
for M2 (TT-1) and M4 (TT-3); once it has 2, AGV-01 dispatches a paired trip. Stops are ordered by ring
position (M2 before M4), the train is loaded **rear = first stop (M2), front = second (M4)**, and the
route is `ST(load) → … → M2(swap) → … → M4(swap) → … → ST(unload) → HS1`. Zone 2 does the same with
AGV-02 for M6/M8. A lone call with no partner would wait up to `pairTimeout` (200 s) then go single.

## 11b. Worked reading — a loop file (loops model)

Given (abridged from `sample_loops.json`, the *103 Tyre Building* plant):

- `STATIONS`: one `attach` (`ATT`), two `home`s (`HOME-1/2`), 38 `tbm` machines. **Shared stops** via
  `stop`: `BTU17..BTU24` point at `BTU9..BTU16`; `STU1..STU6` point at `BTU1..BTU6`.
- `LOOPS`: `L-1` (AGV-01, MRU 1-4, **`pair:false`**), `L-2` (AGV-01, BTU 9-24, **`pair:true`**),
  `L-3` (AGV-02, BTU 1-8 + STU 1-6, **`pair:true`**), `L-4` (AGV-02, STU 7-10, **`pair:false`**). So
  AGV-01 owns L-1 & L-2; AGV-02 owns L-3 & L-4.
- `SIM`: `mode:"loop"`, `attach:"ATT"`, scripted calls across several loops.

How it runs: calls bucket **by loop**. `L-1`/`L-4` are `pair:false`, so each call dispatches
**immediately** as a single-trolley trip `HOME → ATT(load 1) → machine(swap) → HOME(unload)`. `L-2`/`L-3`
are `pair:true` — the AGV **waits for 2 calls** (15 s timeout → single). A `L-2` pair of `BTU9` + `BTU17`
resolves to the **same** stop node (`BTU17.stop = BTU9`), so the AGV stops **once** and delivers **both**
trolleys in one dwell; a pair of `BTU12` + `BTU14` (different positions) makes **two** stops. AGV-01 runs
its L-1 and L-2 trips **separately** — loops never merge. If AGV-02 is toggled down, its `L-3`/`L-4`
calls **stall** until it's back.

---

## 12. Predicting runtime behavior from a file (summary)

1. **Mode** = `SIM.mode === "loop"` ? loop : group.
2. **Geometry**: positions are y-down pixels; AGVs move in **straight lines between consecutive route
   nodes**; arc edges are cosmetic.
3. **Group mode**: `requests`/`CALLS`/auto-gen feed a **FIFO queue**; each idle AGV runs
   `home → group.stops → home` with its own home slot; `agv`-pinned requests are head-of-line
   blocking. `action` stops latch the towed-trolley load; dwell = `dwell` or `serviceTime` (0 for
   `move`).
4. **Loop mode**: calls = `(machine, type)`; the engine **pairs 2 calls** (or sends a single after
   `pairTimeout`), train loaded rear=first/front=second.
   - *Loops model* (`LOOPS`): pairing buckets **per loop** with a per-loop policy — `pair:false` =
     single-immediate, `pair:true` = wait for 2 (or 1 after `pairTimeout`, default 15 s). Each trip is
     one loop, `home → … route … → home(unload)`, loading at the `attach` node (in route order if the
     route lists it, else beelined first); two machines sharing a `stop` are served in one dwell; a down
     AGV's loops **stall**.
   - *Zone model* (`store`): pairing buckets **per AGV/zone**, ordered by **ring position**, routed
     `store(load) → stops → store(unload) → home`; a down AGV funnels its zone to a live AGV.
5. **Determinism**: motion + the seeded RNG mean that, with a scripted `requests` timeline and
   `autoGenerate.enabled=false`, a recording is byte-for-byte reproducible.
6. **Timing**: travel time per leg = `distance / agvSpeed`; add `serviceTime` (or explicit `dwell`)
   at each non-`move` stop.
