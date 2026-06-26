# iPrime Presentation Tool

A browser-based AGV layout + simulation suite for designing factory floor flows and presenting them as
animated, recordable videos. Pure client-side — vanilla JavaScript, HTML5 Canvas, no build step, no
backend. Runs straight from GitHub Pages or a local file.

**Live app:** [jmilliaan.github.io/iprime-presentation-tool](https://jmilliaan.github.io/iprime-presentation-tool)

---

## The model

A layout is built from four layers:

1. **Path** — the geometric track you draw: *corners* joined by straight or arc *edges*. It's a visual
   guide for placing/clicking nodes; the AGV drives straight from one clicked node to the next.
2. **Stations** — the places where something happens (positioned right on the path):
   - **action** stations — where an AGV **sets its trolley load** to `none` / `empty` / `full`.
   - **home** stations — parking slots (one per AGV). **#AGVs must equal #home stations.**
3. **Groups** — reusable **jobs**: an *explicit, ordered list of clicked nodes* (path corners +
   action stations). **No pathfinding** — the AGV visits exactly those nodes, in order, straight
   between each. Home is **not** in a group; the dispatcher adds the assigned AGV's own home at the
   start and end. A group may also carry an optional **home-start** and **home-end** action performed
   at the AGV's home — `attach-empty` / `attach-full` (hook up a trolley before leaving) or
   `detach-empty` / `detach-full` (drop it on return).
4. **Call points** — free-floating on-canvas **buttons** placed anywhere, each bound to a group.
   Clicking one in the player requests that group.

At playback, requests (from call points, a scripted timeline, or a seeded auto-generator) queue
**FIFO**; any idle AGV is dispatched, drives straight from **its own home** to the group's first node,
runs the explicit route, and returns to its home. AGVs **face their direction of travel** automatically.
Collisions are handled **geometrically**, not by node IDs: each moving AGV looks ahead along the actual
polyline it will drive (its live position plus its upcoming nodes, out to one max following-gap) and
checks every other AGV's distance to that line. It waits in two cases:

- **Tailing / occupancy** — another AGV lies **ahead on the same lane** (within roughly one AGV-width
  laterally of the line being driven): the follower keeps a safe gap behind it (larger when the leader
  tows a trolley or a 2-trolley train) and never rams it.
- **Merge** — another AGV is **entering the same target node from a different edge**: the one **closer to
  home** (fewer steps left in its job) goes first; the other waits a gap short of the node.

Because the test is lateral distance, parallel lanes pass freely **as long as they stay more than ~one
AGV-width apart** — two paths that actually overlap on screen along the same line *will* queue. As an
exception, an AGV in the **last few nodes of its run home** (the cramped, shared run-in to its private
home slot) suppresses collision entirely — it neither waits nor is waited for, so the home corridor
doesn't pile up. (Two AGVs sent **head-on down a single edge** is still unsupported.)
The towed **trolley** is drawn by load — `none` (no trolley), `empty` (hollow), `full` (solid + cargo box).

---

## Workflow

```
Floor plan image + Layout Picker  →  coords.json  →  Animation Player
```

1. Open the **Layout Picker**, optionally load a floor-plan image and/or an existing JSON.
2. **[1] Path** — place corners and connect them with straight/arc edges.
3. **[2] Stations** — drop *action* and *home* stations right on the path (#AGVs = #home stations).
4. **[3] Groups** — create a group, then click nodes **in travel order** — path corners (pass-through)
   and action stations (you pick the load: none/empty/full). Optionally set **Home-start/Home-end**
   attach/detach actions in the group panel. Don't click home; it's added per-AGV automatically.
5. **[4] Call** — click **anywhere** to drop a call button and pick the group it fires.
6. Set fleet size / service time / requests in the **Fleet & Sim** panel; press **Save**.
7. Open the **Animation Player**, load the JSON (and the same image), click a call point or press Play.

---

## Layout Picker

| Key | Mode | Key | Action |
|-----|------|-----|--------|
| `1` | Path     | `5` | Loops |
| `2` | Stations | `S` | Save JSON |
| `3` | Groups   | `A` | Toggle arc/straight (Path mode) |
| `4` | Call     | Right-click / Scroll / MMB-drag | Undo / Zoom / Pan |

- **Path:** click empty space to drop a corner (it chains from the selected one); click a corner to
  select/connect; `A` toggles arc, with radius + CW/CCW controls; right-click undoes.
- **Stations:** toggle **Action / Home**, then click to place them. The same bar also has **Machine /
  Attach / Share stop** for authoring loop-mode layouts — all drop **free-floating** at the click. A
  machine's serving AGV comes from the **loop** that contains it (assigned in *Loops* mode), so there's
  no per-machine zone selector. A **Machines** panel (right) lists every machine — **double-click** one to
  give it a friendly **display name** (the operational id `M-…` used in routes stays fixed). See
  *Loop-dispatch mode* below.
- **Loops:** (loops-mode authoring) **+ New loop**, pick its **AGV**, then click corners/machines in
  travel order to build the route; right-click pops the last node. **Double-click a loop's name** to
  rename it (display only; the loop id stays). See *Loop-dispatch mode* below.
- **Groups:** pick/create the active group (right panel), then click nodes in travel order. Clicking a
  **path corner** appends a pass-through; clicking an **action station** asks for the load (none/empty/
  full). Toggle **Add / Delete** in the group bar to add stops or remove an action stop by clicking it.
  The **Home-start/Home-end** dropdowns in the group panel set an optional attach/detach action at the
  AGV's home. (Home stations are ignored in the route — home is added per-AGV at run time.) Right-click
  pops the last node. **Double-click a group's name** in the panel to rename it (the friendly label only;
  its ID stays the same so call points keep working).
- **Call:** click anywhere → choose a group to drop a call button; right-click a call marker removes it.
- **Fleet & Sim panel:** number of AGVs, service time, AGV speed, auto-generate (interval + seed), and a
  requests timeline (`t  GROUP  [AGV]`, one per line) for repeatable recordings.

---

## Animation Player

| Control | Action |
|---------|--------|
| ▶ Play / ⏸ Pause / Space | Start / pause |
| ⟳ Restart | Reset to the start (re-parks AGVs, reseeds RNG) |
| Speed | Playback time multiplier (0.25×–4×) |
| AGV px/s | Movement speed |
| Action dur (s) | Default dwell at a stop when the stop sets no explicit `dwell` |
| Grid / Labels | Overlays |
| **Auto-call** | Toggle the seeded random request generator |
| ⏺ Record | Capture as `.webm` (Chrome / Edge) |

- **Call points** are amber rings placed anywhere on the map; **click one to dispatch** an AGV to its
  group. A count next to it shows how many of that group are queued.
- **Queue list** (top-left) shows running + waiting jobs. It is drawn **on the canvas**, so it is
  captured in recordings.
- **HUD** shows the queue length, pending count per group, and each AGV's state
  (`HOME / TO STOP / SERVING / WAIT / RETURN`) in its colour.
- **Pinning:** a request bound to a specific AGV (`"agv":"AGV-01"`) is always served by that AGV; strict
  FIFO means the queue head waits for it.
- **Deterministic video:** with a `SIM.requests` timeline (auto-call off) every recording is identical
  (seeded RNG) and auto-stops once the timeline drains and all AGVs are home.

---

## JSON schema

> For a deep, standalone walk-through of the file format — every field, both engine modes, the
> loop-ring convention, normalisation/defaults, invariants, and worked readings of both samples — see
> [`JSON_FORMAT.md`](JSON_FORMAT.md). The summary below is the quick reference.

```jsonc
{
  "PATH": {
    "nodes": { "P-1": { "x": 200, "y": 300 } },
    "edges": [ { "id": "E-1", "from": "P-1", "to": "P-H", "type": "straight" },
               { "id": "E-2", "from": "P-H", "to": "P-4", "type": "arc", "radius": 120, "clockwise": true } ]
  },
  "STATIONS": {
    "HS-1": { "x": 175, "y": 180, "role": "home" },
    "LA":   { "x": 848, "y": 180, "role": "action" }
  },
  "AGVS": [ { "id": "AGV-01", "color": "#E63946", "heading": 0 } ],
  "GROUPS": {
    "G-A": { "name": "Deliver to A", "homeStart": "attach-full", "homeEnd": "none", "stops": [
      { "node": "P-H", "action": "move" }, { "node": "P-4", "action": "move" },
      { "node": "LA",  "action": "none" },
      { "node": "P-4", "action": "move" }, { "node": "P-H", "action": "move" } ] }
  },
  "CALLS": [ { "x": 852, "y": 130, "group": "G-A" } ],
  "HOME": { "slots": ["HS-1", "HS-2", "HS-3"] },
  "SIM": {
    "agvSpeed": 120, "serviceTime": 3, "trolleyMode": "tow",
    "requests": [ { "t": 1, "group": "G-A" }, { "t": 7, "group": "G-A", "agv": "AGV-01" } ],
    "autoGenerate": { "enabled": false, "meanInterval": 6, "seed": 1234 }
  }
}
```

| Section | Notes |
|---------|-------|
| `PATH.nodes / edges` | Corners and their straight/arc connections — a drawn guide for clicking. |
| `STATIONS[].role` | `action` (group-mode load-setting stop), `home` (parking / unload slot), `tbm` (loop-mode machine; carries `agv` = its zone, and optional `stop` = the route node it's serviced at), `store` (legacy single load/unload), or `attach` (loops-mode shared load point). Position only — no path link. Unknown roles fall back to `action`. |
| `GROUPS[].stops[]` | Explicit ordered nodes: `{ node, action }` (+ optional `dwell`, `label`, and `mode:"manual"` to draw a person at the stop). `action` ∈ `move \| none \| empty \| full` (sets the towed-trolley load; `move` = pass-through). `node` is a path corner or a station; home is excluded. |
| `GROUPS[].homeStart / homeEnd` | Optional action at the assigned AGV's own home (before leaving / on return): `none \| attach-empty \| attach-full \| detach-empty \| detach-full`. |
| `CALLS[]` | `{ x, y, group }` → a free-floating on-canvas call button. |
| `HOME.slots[]` | Home-station ids, one slot per AGV (**#AGVs = #home slots**; AGV *i* parks at slot *i*). |
| `SIM` | Playback config: `agvSpeed`, `serviceTime`, `requests` timeline, `autoGenerate`. Loop mode adds `mode:"loop"`, `trainSize` (trolleys per train, default 2), `pairTimeout` (seconds a lone call waits before a single trip, default 200), and either `attach` (loops model — shared load node) or `store` (legacy zone model). In loop mode each `requests[]` entry is `{ t, machine, type }` instead of `{ t, group, agv }`. |
| `LOOPS` | Loops model only: `id → { name, agv, route:[nodeId…], pair, pairTimeout }` — an owning AGV, an explicit ordered route (corners + machines), and pairing policy (`pair` default `true`; `pairTimeout` seconds, default `15`). Its presence selects the loops engine over the legacy zone engine. |

> Legacy files using `CALL_STATIONS` and `pickup/release/exchange` still load (converted automatically).
> Note: old `homeStart/homeEnd` values (`empty`/`full`/`none`) are **not** migrated — re-pick them as
> `attach-*` / `detach-*`.

> A ready-made example is in [`sample_dispatch.json`](sample_dispatch.json) — 3 AGVs, a hub of path
> spurs, 3 call points and a multi-stop group; no background image needed.
>
> **Layout tips:** the AGV drives *straight between clicked nodes*, so click corners along the route you
> want (a clicked arc edge is cut as a chord — add corners to follow a curve). Each AGV's home→first-node
> and last-node→home legs are straight too, so place homes near where routes begin. AGVs queue only when
> one runs **ahead on the same physical lane** (tailing) or two **merge into the same node**; lanes more
> than ~one AGV-width apart run freely, so keeping parallel routes visually separated stops different jobs
> from waiting on each other. Avoid sending two AGVs **head-on along a single edge** (opposite directions
> on the same two nodes) — that case is unsupported and can deadlock; use separate lanes or a one-way
> loop instead.

---

## Loop-dispatch mode (TBM trolley system)

Alongside the default **group/FIFO** model, a layout can opt into **loop mode** (`SIM.mode:"loop"`) — a
simulation of the factory trolley-dispatch system: machines that get **calls**, AGVs that tow a **train
of trolleys** (2 by default, `SIM.trainSize`), and **pairing**. The player picks the engine
automatically; everything else (play/pause, recording, geometric collision) is shared. Loop mode has
**two allocation models**, chosen by whether the layout defines `LOOPS`:

- **Loops model** (`LOOPS` present) — the realistic plant: a **branched** track with several **loops**,
  each a fixed route owned by one AGV; an AGV owns **several loops**. *(Primary model.)*
- **Legacy zone model** (no `LOOPS`, just a `store`) — one **single one-way ring** with per-machine AGV
  **zones**. Older loop files keep working unchanged.

Shared behaviour (both models):

- **Machines (TBMs)** are tagged `role:"tbm"`. **Calls** are per-machine and per **trolley type** (6
  types; a layout may define `TROLLEY_TYPES`). In the player, **click a machine → pick a type** to call
  an empty trolley. Each machine has a status **LED**: *off* (idle) → *blink* (queued / loading) →
  *solid* (AGV en route) → *off* (serviced).
- **Train + loading order:** stops are visited in route order; the train is loaded so the **rear**
  trolley serves the **first** stop (easy detach) and the **front** the **second**. The "PREPARE"
  overlay shows the front/rear types. At each machine the empty is swapped for a full (full type not
  tracked).
- **Traffic:** the same **geometric** collision engine resolves catch-up/merge on the shared spine (the
  AGV closer to finishing its route proceeds); no RFID conflict table is needed.

### Loops model (`LOOPS`)

- A **loop** is a first-class object: `LOOPS[id] = { name, agv, route, pair, pairTimeout }` — an **owning
  AGV**, an **explicit ordered route** (path corners + machines), and its **pairing policy**. A machine
  belongs to the loop whose route contains it (or its `stop` node). An AGV owns **one or more** loops and
  runs **one loop per trip**; calls pair **only within the same loop** (loops never merge).
- **Per-loop pairing policy:**
  - `pair: false` → the AGV dispatches **each call immediately** as a **single-trolley** trip (1 empty
    out, 1 full back). Use for loops you don't want to wait on.
  - `pair: true` (default) → the AGV **waits for 2 calls** on that loop, then runs a 2-trolley trip;
    a lone call goes single after the loop's **`pairTimeout`** (default **15 s**). Any 2 calls on the
    loop may pair — the AGV visits up to 2 stop positions (or one, if they share it).
- **Attach + home:** empties load at a shared **attach** node (`role:"attach"`, `SIM.attach`); fulls
  unload at each AGV's own **home** slot. A trip is `home → … route … → home(unload)`, loading at the
  attach node. **Put the attach node *in* the loop's route** at the position where loading should happen,
  so the AGV follows the track to it (e.g. `home → 1 → … → 5 → attach → 6 → …`). If a route omits the
  attach node, the AGV instead **beelines to attach first** (`home → attach → route → home`).
- **Shared stops:** two machines can be serviced at **one route position** — each stays a separate
  machine (its own **6-button call panel + LED**) but points its `stop` at the shared route node. If both
  call in one trip, both empties are delivered in a **single** stop/dwell.
- **Degraded mode:** toggle an AGV **down** → its loops **stall** (its calls wait); the other AGV is
  **not** reassigned its loops.

**Authoring (Layout Picker):**
1. **Path** mode — draw the track.
2. **Stations** mode — place an **Attach** depot (one per layout) and per-AGV **Homes**. These and
   **Machines** all drop **free-floating** at the click (click a corner if you want a machine *on* the
   track). Use **Share stop** to link two machines to one stopping position: click the host machine, then
   the machine that joins it (sets its `stop`).
3. **Loops** mode (`5`) — **+ New loop**, pick its **AGV**, toggle **pair** + set its **timeout**, then
   click route nodes **in travel order**: path corners, host machines, **and the Attach point** where
   loading should occur. (Don't click homes — start/end home is added automatically.)

Saving a layout that has `LOOPS` sets `SIM.mode:"loop"` and `SIM.attach` automatically. A ready example
is [`sample_loops.json`](sample_loops.json) — the *103 Tyre Building* plant: 2 AGVs, **4 loops**, 38
machines, single-immediate loops (MRU, STU 7-10), paired loops with shared stops (BTU 9-24, BTU 1-8 +
STU 1-6).

### Legacy zone model (`store`)

Machines are path corners tagged `role:"tbm"` with a **serving AGV** (`agv`) — that allocation *is* the
zone. One **store** (`role:"store"`) is the single load/unload point; the ring is derived from the drawn
one-way cycle. The engine pairs **2 calls in one zone** (FCFS); a down AGV's machines are **funnelled**
to the live AGV (zones dropped). This model is **retained for backward compatibility only** — such files
still load, run, and render, but the Layout Picker no longer authors a **store**, so new layouts use the
loops model. Example: [`sample_loop.json`](sample_loop.json) — a one-way loop, 8 machines across 2
zones, a store and 2 AGVs.

---

## Stack

Vanilla JavaScript · HTML5 Canvas · No frameworks · No build step · Fully client-side.

Files: `cpicker.html`/`cpicker.js` (Layout Picker) · `animplayer.html`/`animplayer.js` (Animation
Player) · `dispatch.js` (group/FIFO dispatch engine) · `loopdispatch.js` (loop-mode zoned-pairing
engine) · `shared.js` (transforms, geometry, layout normalisation, loop-ring routing, seeded RNG) ·
`style.css`.
