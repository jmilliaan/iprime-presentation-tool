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
Collisions are handled by **topology, not proximity** — an AGV only waits for another in two cases:

- **Tailing** — both on the **same edge, same direction**: the follower keeps a safe gap (larger when
  the leader is towing a trolley) and never rams it.
- **Merge** — both **entering the same node** from different edges: the one **closer to home** (fewer
  steps left in its job) goes first; the other waits just short of the node.

AGVs on **different edges never block each other** — parallel lanes pass freely, even when running
opposite ways or overlapping on screen. (Two AGVs sent **head-on down a single edge** is unsupported.)
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
- **Stations:** toggle **Action / Home**, then click to place them on the path.
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
| `STATIONS[].role` | `home` (parking slot) or `action`. Position only — no path link. |
| `GROUPS[].stops[]` | Explicit ordered nodes: `{ node, action }` (+ optional `dwell`, `label`). `action` ∈ `move \| none \| empty \| full` (sets the towed-trolley load; `move` = pass-through). `node` is a path corner or a station; home is excluded. |
| `GROUPS[].homeStart / homeEnd` | Optional action at the assigned AGV's own home (before leaving / on return): `none \| attach-empty \| attach-full \| detach-empty \| detach-full`. |
| `CALLS[]` | `{ x, y, group }` → a free-floating on-canvas call button. |
| `HOME.slots[]` | Home-station ids, one slot per AGV (**#AGVs = #home slots**; AGV *i* parks at slot *i*). |
| `SIM` | Playback config: speed, service time, request timeline, auto-generator. |

> Legacy files using `CALL_STATIONS` and `pickup/release/exchange` still load (converted automatically).
> Note: old `homeStart/homeEnd` values (`empty`/`full`/`none`) are **not** migrated — re-pick them as
> `attach-*` / `detach-*`.

> A ready-made example is in [`sample_dispatch.json`](sample_dispatch.json) — 3 AGVs, a hub of path
> spurs, 3 call points and a multi-stop group; no background image needed.
>
> **Layout tips:** the AGV drives *straight between clicked nodes*, so click corners along the route you
> want (a clicked arc edge is cut as a chord — add corners to follow a curve). Each AGV's home→first-node
> and last-node→home legs are straight too, so place homes near where routes begin. AGVs only queue
> where routes **share a node** (tailing on one edge, or merging into a node); parallel routes on
> **separate edges run freely**, so spurs off a hub keep different jobs from waiting on each other. Avoid
> sending two AGVs **head-on along a single edge** (opposite directions on the same two nodes) — that
> case is unsupported and can deadlock; use separate lanes or a one-way loop instead.

---

## Stack

Vanilla JavaScript · HTML5 Canvas · No frameworks · No build step · Fully client-side.

Files: `cpicker.html`/`cpicker.js` (Layout Picker) · `animplayer.html`/`animplayer.js` (Animation
Player) · `dispatch.js` (FIFO dispatch + queue engine) · `shared.js` (transforms, geometry, layout
normalisation, seeded RNG) · `style.css`.
