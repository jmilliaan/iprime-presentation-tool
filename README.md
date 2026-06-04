# iPrime Presentation Tool

A browser-based AGV layout + simulation suite for designing factory floor flows and presenting them as
animated, recordable videos. Pure client-side — vanilla JavaScript, HTML5 Canvas, no build step, no
backend. Runs straight from GitHub Pages or a local file.

**Live app:** [jmilliaan.github.io/iprime-presentation-tool](https://jmilliaan.github.io/iprime-presentation-tool)

---

## The model

A layout is built from four layers:

1. **Path** — the geometric track the AGV drives on: *corners* joined by straight or arc *edges*. Pure
   geometry, no behaviour. Edges are two-way.
2. **Stations** — the places where something happens, each **auto-linked to the nearest path corner**:
   - **action** stations — where an AGV performs `pickup` / `release` / `exchange` / `move`.
   - **home** stations — parking slots the AGVs dispatch from and return to (one slot per AGV).
3. **Groups** — reusable **jobs**: an ordered list of action stops. `home → stops… → home` is implicit.
   A group can chain multiple stops (e.g. pick up at A, drop at B).
4. **Call points** — a station marked as an on-canvas **button** bound to a group. Clicking it in the
   player requests that group.

At playback, requests (from call points, a scripted timeline, or a seeded auto-generator) queue
**FIFO**; an idle AGV is dispatched from its home slot to run the group and return. AGVs **route
automatically** (shortest path over the path graph, including arcs), **face their direction of travel**
automatically, and **wait/yield** at shared corners so they genuinely queue.

---

## Workflow

```
Floor plan image + Layout Picker  →  coords.json  →  Animation Player
```

1. Open the **Layout Picker**, optionally load a floor-plan image and/or an existing JSON.
2. **[1] Path** — place corners and connect them with straight/arc edges.
3. **[2] Stations** — drop *action* and *home* stations (they snap-link to the nearest corner).
4. **[3] Groups** — create a group, then click stations in order; choose the action at each stop.
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
- **Stations:** toggle **Action / Home**, then click to place. A dashed line shows the corner each
  station links to (draw the path *first* so stations can link).
- **Groups:** pick/create the active group (right panel), then click stations in order — each click asks
  for the action. Right-click pops the last stop. Multi-stop groups are allowed.
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
    "HS-1": { "x": 175, "y": 180, "role": "home",   "link": "P-1" },
    "LA":   { "x": 848, "y": 180, "role": "action", "link": "P-4" }
  },
  "AGVS": [ { "id": "AGV-01", "color": "#E63946" } ],
  "GROUPS": {
    "G-A":  { "name": "Serve A",  "stops": [ { "station": "LA", "action": "exchange" } ] },
    "G-AB": { "name": "A→B",      "stops": [ { "station": "LA", "action": "pickup" },
                                            { "station": "LB", "action": "release" } ] }
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
| `PATH.nodes / edges` | Corners and their straight/arc connections (two-way). |
| `STATIONS[].role` | `home` (parking slot) or `action`. `link` = nearest path corner id. |
| `GROUPS[].stops[]` | `{ station, action }` (+ optional `dwell`, `label`). Home is implicit. |
| `CALL_STATIONS[]` | `{ station, group }` → an on-canvas call button. |
| `HOME.slots[]` | Home-station ids, one slot per AGV (keep AGV count ≤ slots). |
| `SIM` | Playback config: speed, service time, request timeline, auto-generator. |

> A ready-made example is in [`sample_dispatch.json`](sample_dispatch.json) — 3 AGVs, a hub of path
> spurs, 3 call points and a multi-stop group; no background image needed.
>
> **Layout tip:** real queueing assumes a sane path. Put home slots and action stations on **spurs off a
> hub** (as in the sample). Two AGVs driving head-on down a single shared lane can deadlock — use a hub,
> loops, or separate spurs for opposing flows.

---

## Stack

Vanilla JavaScript · HTML5 Canvas · No frameworks · No build step · Fully client-side.

Files: `cpicker.html`/`cpicker.js` (Layout Picker) · `animplayer.html`/`animplayer.js` (Animation
Player) · `dispatch.js` (FIFO dispatch + queue engine) · `shared.js` (transforms, geometry, layout
normalisation, seeded RNG) · `style.css`.
