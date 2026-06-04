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
   - **action** stations — where an AGV performs `pickup` / `release` / `exchange` / `move`.
   - **home** stations — parking slots (one per AGV). **#AGVs must equal #home stations.**
3. **Groups** — reusable **jobs**: an *explicit, ordered list of clicked nodes* (path corners + action
   stations). **No pathfinding** — the AGV visits exactly those nodes, in order, straight between each.
   Home is **not** in a group; the dispatcher adds the assigned AGV's own home at the start and end.
4. **Call points** — a station marked as an on-canvas **button** bound to a group. Clicking it in the
   player requests that group.

At playback, requests (from call points, a scripted timeline, or a seeded auto-generator) queue
**FIFO**; any idle AGV is dispatched, drives straight from **its own home** to the group's first node,
runs the explicit route, and returns to its home. AGVs **face their direction of travel** automatically
and **reserve each clicked node**, so they genuinely **wait/yield** when two routes share a corner.

---

## Workflow

```
Floor plan image + Layout Picker  →  coords.json  →  Animation Player
```

1. Open the **Layout Picker**, optionally load a floor-plan image and/or an existing JSON.
2. **[1] Path** — place corners and connect them with straight/arc edges.
3. **[2] Stations** — drop *action* and *home* stations right on the path (#AGVs = #home stations).
4. **[3] Groups** — create a group, then click nodes **in travel order** — path corners (pass-through)
   and action stations (you pick the action). Don't include home; it's added per-AGV automatically.
5. **[4] Call** — click a station and pick the group it should call.
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
  **path corner** appends a pass-through; clicking an **action station** asks for the action. (Home
  stations are ignored — home is added per-AGV at run time.) Right-click pops the last node.
- **Call:** click a station → choose a group; right-click a station removes its call.
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

- **Call points** are amber rings drawn on the map; **click one to dispatch** an AGV to its group. A
  count next to it shows how many of that group are queued.
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
    "G-A": { "name": "Serve A", "stops": [
      { "node": "P-H", "action": "move" }, { "node": "P-4", "action": "move" },
      { "node": "LA",  "action": "exchange" },
      { "node": "P-4", "action": "move" }, { "node": "P-H", "action": "move" } ] }
  },
  "CALL_STATIONS": [ { "station": "LA", "group": "G-A" } ],
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
| `GROUPS[].stops[]` | Explicit ordered nodes: `{ node, action }` (+ optional `dwell`, `label`). `node` is a path corner or a station; home is excluded. |
| `CALL_STATIONS[]` | `{ station, group }` → an on-canvas call button. |
| `HOME.slots[]` | Home-station ids, one slot per AGV (**#AGVs = #home slots**; AGV *i* parks at slot *i*). |
| `SIM` | Playback config: speed, service time, request timeline, auto-generator. |

> A ready-made example is in [`sample_dispatch.json`](sample_dispatch.json) — 3 AGVs, a hub of path
> spurs, 3 call points and a multi-stop group; no background image needed.
>
> **Layout tips:** the AGV drives *straight between clicked nodes*, so click corners along the route you
> want (a clicked arc edge is cut as a chord — add corners to follow a curve). Each AGV's home→first-node
> and last-node→home legs are straight too, so place homes near where routes begin. Queueing happens at
> **shared clicked corners**; put stations on **spurs off a hub** so different jobs only contend at the
> hub. Two AGVs traversing the *same* corridor head-on can deadlock — avoid concurrent opposite traffic
> on one lane.

---

## Stack

Vanilla JavaScript · HTML5 Canvas · No frameworks · No build step · Fully client-side.

Files: `cpicker.html`/`cpicker.js` (Layout Picker) · `animplayer.html`/`animplayer.js` (Animation
Player) · `dispatch.js` (FIFO dispatch + queue engine) · `shared.js` (transforms, geometry, layout
normalisation, seeded RNG) · `style.css`.
