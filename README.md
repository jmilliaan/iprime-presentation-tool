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
| `1` | Path     | `S` | Save JSON |
| `2` | Stations | `A` | Toggle arc/straight (Path mode) |
| `3` | Groups   | Right-click | Undo in current mode |
| `4` | Call     | Scroll / MMB-drag | Zoom / Pan |

- **Path:** click empty space to drop a corner (it chains from the selected one); click a corner to
  select/connect; `A` toggles arc, with radius + CW/CCW controls; right-click undoes.
- **Stations:** toggle **Action / Home**, then click to place them on the path. The same bar also has
  **Machine / Store** (with a **Zone** AGV selector) for authoring loop-mode layouts — see *Loop-dispatch
  mode* below.
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
  "AGVS": [ { "id": "AGV-01", "color": "#E63946" } ],
  "GROUPS": {
    "G-A": { "name": "Deliver to A", "homeStart": "attach-full", "homeEnd": "none", "stops": [
      { "node": "P-H", "action": "move" }, { "node": "P-4", "action": "move" },
      { "node": "LA",  "action": "none" },
      { "node": "P-4", "action": "move" }, { "node": "P-H", "action": "move" } ] }
  },
  "CALLS": [ { "x": 852, "y": 130, "group": "G-A" } ],
  "HOME": { "slots": ["HS-1", "HS-2", "HS-3"] },
  "SIM": {
    "agvSpeed": 120, "serviceTime": 3,
    "requests": [ { "t": 1, "group": "G-A" }, { "t": 7, "group": "G-A", "agv": "AGV-01" } ],
    "autoGenerate": { "enabled": false, "meanInterval": 6, "seed": 1234 }
  }
}
```

| Section | Notes |
|---------|-------|
| `PATH.nodes / edges` | Corners and their straight/arc connections — a drawn guide for clicking. |
| `STATIONS[].role` | `action` (group-mode load-setting stop), `home` (parking slot), `tbm` (loop-mode machine; carries `agv` = its serving AGV/zone), or `store` (loop-mode load/unload point). Position only — no path link. Unknown roles fall back to `action`. |
| `GROUPS[].stops[]` | Explicit ordered nodes: `{ node, action }` (+ optional `dwell`, `label`, and `mode:"manual"` to draw a person at the stop). `action` ∈ `move \| none \| empty \| full` (sets the towed-trolley load; `move` = pass-through). `node` is a path corner or a station; home is excluded. |
| `GROUPS[].homeStart / homeEnd` | Optional action at the assigned AGV's own home (before leaving / on return): `none \| attach-empty \| attach-full \| detach-empty \| detach-full`. |
| `CALLS[]` | `{ x, y, group }` → a free-floating on-canvas call button. |
| `HOME.slots[]` | Home-station ids, one slot per AGV (**#AGVs = #home slots**; AGV *i* parks at slot *i*). |
| `SIM` | Playback config: `agvSpeed`, `serviceTime`, `requests` timeline, `autoGenerate`. Loop mode adds `mode:"loop"`, `store` (store node id), `trainSize` (trolleys per train, default 2), and `pairTimeout` (seconds a lone call waits before a single trip, default 200). In loop mode each `requests[]` entry is `{ t, machine, type }` instead of `{ t, group, agv }`. |

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

Alongside the default **group/FIFO** model, a layout can opt into **loop mode** — a simulation of the
factory trolley-dispatch system: machines on a **one-way loop**, AGVs that tow a **train of trolleys**
(2 by default, set via `SIM.trainSize`), and **zoned pairing**. The player picks the engine
automatically from the layout (`SIM.mode: "loop"`); everything else (play/pause, recording, geometric
collision) is shared.

How it works:

- **Machines (TBMs)** are path corners tagged with `role:"tbm"` and a **serving AGV** (`agv`) — that
  allocation *is* the zone. Any number of machines (layout-driven). One **store** (`role:"store"`) is
  the single load/unload point; each AGV parks at its own **home/wait** slot.
- **Calls** are per-machine and per **trolley type** (6 types; a layout may define `TROLLEY_TYPES`).
  In the player, **click a machine → pick a type** to call an empty trolley. Each machine has a status
  **LED**: *off* (idle) → *blink* (queued / loading) → *solid* (AGV en route) → *off* (serviced).
- **Pairing:** the engine waits for **2 calls in one zone**, then dispatches that zone's AGV with a
  2-stop trip (FCFS). A lone call dispatches as a **single-trolley trip** after `pairTimeout` (200 s).
  Calls in **different zones never pair**.
- **Visit + loading order:** stops are visited in **loop order**; the train is loaded so the **rear**
  trolley serves the **first** stop (easy detach) and the **front** serves the **second**. The store
  "PREPARE" overlay shows the front/rear types to load. At each machine the empty is swapped for a full
  (full type is not tracked); the AGV completes the loop back to the store and parks.
- **Degraded mode:** toggle an AGV **down** in the player toolbar → the other AGV serves **all**
  machines (zones dropped) until it's back.
- **Traffic:** the same **geometric** collision engine resolves catch-up/merge on the shared loop (the
  AGV closer to finishing its route proceeds); no RFID conflict table is needed.

**Authoring (Layout Picker):** draw the loop in **Path** mode (corners + one-way edges forming a single
cycle), then in **Stations** mode use **Machine** / **Store** to tag corners — for machines, pick the
**Zone AGV** first so each machine is allocated to a serving AGV. You don't need a corner there: drop a
machine/store **anywhere along a line** and it **snaps onto the nearest edge**, inserting a corner at
that point (so loop routing can still reach it — clicking directly on an existing corner reuses it
instead). Place **Home** wait spots near the store. Saving a layout with machines + a store sets
`SIM.mode:"loop"` automatically.

A ready example is [`sample_loop.json`](sample_loop.json) — a one-way loop, 8 machines across 2 zones,
a store and 2 AGVs.

---

## Stack

Vanilla JavaScript · HTML5 Canvas · No frameworks · No build step · Fully client-side.

Files: `cpicker.html`/`cpicker.js` (Layout Picker) · `animplayer.html`/`animplayer.js` (Animation
Player) · `dispatch.js` (group/FIFO dispatch engine) · `loopdispatch.js` (loop-mode zoned-pairing
engine) · `shared.js` (transforms, geometry, layout normalisation, loop-ring routing, seeded RNG) ·
`style.css`.
