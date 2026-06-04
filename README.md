# iPrime Presentation Tool

A browser-based AGV layout and animation suite for creating and presenting Automated Guided Vehicle sequences on factory floor plans.

**Live app:** [jmilliaan.github.io/iprime-presentation-tool](https://jmilliaan.github.io/iprime-presentation-tool)
**Repository:** [github.com/jmilliaan/iprime-presentation-tool](https://github.com/jmilliaan/iprime-presentation-tool)

---

## Tools

### Coordinate Picker
Define the physical layout — place nodes on a floor plan image, draw the magnetic track network, and build sequences for up to 4 AGVs.

### Animation Player
Load a saved layout JSON and play back multi-AGV movement sequences as an animation, with path coloring, manual-stop indicators, and video recording. Supports two modes: **scripted** (fixed per-AGV sequences) and **dispatch** (on-demand FIFO request queue — see below).

---

## Workflow

```
Floor plan image + Coord Picker  →  coords.json  →  Animation Player
```

1. Open **Coordinate Picker**, load your floor plan image and optionally an existing JSON
2. *(For track-following AGVs)* Switch to **Track Mode** (`T`), lay out the magnetic track network with straight and arc segments
3. Place **seq_points** (named stops where actions happen) and **waypoints** (anonymous pass-through points) — they snap to the nearest track point automatically
4. Add up to 4 AGVs in the AGV panel and assign each a sequence in **Sequence Mode** (`E`)
5. For each stop: select action → heading angle → optional dwell / label / manual flag
6. Press `S` to save `coords.json`
7. Open **Animation Player**, load `coords.json` and the same floor plan image
8. Press Play

For a **live dispatch simulation** instead of a fixed script (lines call for service, AGVs queue and
serve on demand), tag home/line nodes in the Coordinate Picker's **DISPATCH** panel and skip the
per-AGV sequences — see [Dispatch Mode](#dispatch-mode-on-demand-fifo-simulation).

---

## Coordinate Picker

### Mode overview
| Key | Mode |
|-----|------|
| `E` | Toggle NODE ↔ SEQUENCE mode |
| `T` | Toggle TRACK mode on / off |
| `S` | Save JSON |
| Right-click | Undo last action in current mode |
| Scroll | Zoom |
| Middle-click drag | Pan |

The **DISPATCH** panel (right side) is always available — use it to turn a layout into a dispatch
scenario by tagging home/line nodes. See [Dispatch Mode](#dispatch-mode-on-demand-fifo-simulation).

---

### NODE Mode
- **Left-click** anywhere to open the placement radial
  - **Left half** → `seq_point` (named stop, supports trolley actions)
  - **Right half** → `waypoint` (auto-named pass-through point)
- If a track point is within 20 px, the new node snaps to it automatically and is linked (`trackPoint` field set)

---

### SEQUENCE Mode
- Select the active AGV from the **AGV panel** (top-left) — up to 4 AGVs, each with an independent color and sequence
- **Left-click** a node to add it to the active AGV's sequence
  - `seq_point` → choose action, then heading angle, then optional details
  - `waypoint` → choose heading angle (action is always `move`)
- After selecting a heading, a **details bar** appears:
  - **Dwell (s)** — override the stop duration for this entry
  - **Label** — annotation text shown during the stop (e.g. `dock lock`, `waiting for crane`)
  - **Manual** checkbox — marks this stop as a manual operation; a worker figure is shown in the animation
- Right-click removes the last sequence entry for the active AGV

### Trolley Actions
| Action | Meaning |
|--------|---------|
| `move` | AGV passes through without stopping |
| `pickup` | AGV attaches a trolley |
| `release` | AGV detaches the trolley |
| `exchange` | AGV swaps one trolley for another |

---

### TRACK Mode
Draw the magnetic track network that constrains track-following AGVs.

| Input / Key | Action |
|-------------|--------|
| **Left-click** empty space | Place new track point (chains from selected point) |
| **Left-click** existing point | Select it (or connect to the currently selected point) |
| `A` | Toggle Arc / Straight segment type |
| Radius input | Set arc radius (applies live to the last-placed arc segment) |
| `CW` / `CCW` buttons | Set arc direction (applies live to the last-placed arc segment) |
| `Esc` | Deselect current track point |
| Right-click | Deselect or undo the last-placed track point |
| `T` | Exit TRACK mode |

Track points are drawn as blue diamonds; segments are drawn as blue lines/arcs. A dashed preview line shows the next segment from the selected point to the cursor.

---

## Animation Player

### Controls
| Control | Action |
|---------|--------|
| ▶ Play / ⏸ Pause | Start or pause playback |
| ⟳ Restart | Reset to the beginning |
| Space | Play / Pause |
| Speed | Playback time multiplier (0.25× – 4×) |
| AGV px/s | AGV movement speed in image pixels per second |
| Action dur (s) | Default duration for pickup / release / exchange stops |
| Grid / Labels | Toggle grid overlay and node labels |
| ⏺ Record | Capture animation as `.webm` video (Chrome / Edge only) |
| **Call LINE-X** | *(dispatch layouts only)* Inject an on-demand request for that line |
| **Auto** | *(dispatch layouts only)* Toggle the seeded random request generator |

### Visual guide

**Path segments**
| Style | Meaning |
|-------|---------|
| Orange solid line | AGV is carrying a trolley on this leg |
| Purple dashed line | AGV is travelling empty on this leg |

**Track network**
- Blue lines/arcs drawn under all nodes — shows the physical magnetic track layout
- Blue diamond markers at each track junction point

**During a stop**
- Colored progress ring around the AGV shows how far through the action it is
- Label text above the AGV shows the action type and any custom label
- Blue stick figure next to the AGV = **manual operation** (worker required)

**Multi-AGV**
- Each AGV is drawn in its own color (red, blue, green, purple by default)
- Conflict indicator: AGVs highlight in red when they occupy the same node simultaneously or are within collision distance
- HUD bar shows each AGV's current phase in its color

### Navigation
| Input | Action |
|-------|--------|
| Scroll | Zoom |
| Middle-click drag | Pan |

---

## JSON Format

### Full example (multi-AGV with track)
```json
{
  "NODES": {
    "HP-01": { "x": 420, "y": 310, "type": "seq_point", "trackPoint": "TP-1" },
    "HP-02": { "x": 820, "y": 310, "type": "seq_point", "trackPoint": "TP-3" },
    "WP-01": { "x": 210, "y": 310, "type": "waypoint",  "trackPoint": "TP-0" }
  },
  "AGVS": [
    {
      "id": "AGV-01",
      "color": "#E63946",
      "sequence": [
        { "node": "HP-01", "action": "pickup",  "heading": 0,   "dwell": 3, "label": "dock lock", "mode": "manual" },
        { "node": "HP-02", "action": "release", "heading": 180, "dwell": 2 }
      ]
    },
    {
      "id": "AGV-02",
      "color": "#4080e0",
      "sequence": [
        { "node": "HP-02", "action": "pickup",  "heading": 0 },
        { "node": "HP-01", "action": "release", "heading": 180 }
      ]
    }
  ],
  "TRACK": {
    "points": {
      "TP-0": { "x": 210, "y": 310 },
      "TP-1": { "x": 420, "y": 310 },
      "TP-2": { "x": 620, "y": 310 },
      "TP-3": { "x": 820, "y": 310 }
    },
    "segments": [
      { "id": "SEG-1", "from": "TP-0", "to": "TP-1", "type": "straight" },
      { "id": "SEG-2", "from": "TP-1", "to": "TP-2", "type": "arc", "radius": 200, "clockwise": true },
      { "id": "SEG-3", "from": "TP-2", "to": "TP-3", "type": "straight" }
    ]
  }
}
```

### NODES fields
| Field | Required | Description |
|-------|----------|-------------|
| `x`, `y` | Yes | Image-coordinate position |
| `type` | Yes | `seq_point` or `waypoint` |
| `trackPoint` | No | ID of the nearest TRACK point — set automatically by snap |

### AGVS entry fields
| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Display name (e.g. `AGV-01`) |
| `color` | Yes | Hex color for this AGV |
| `sequence` | Yes | Array of sequence entries (see below) |

### Sequence entry fields
| Field | Required | Description |
|-------|----------|-------------|
| `node` | Yes | Node ID from `NODES` |
| `action` | Yes | `move` / `pickup` / `release` / `exchange` |
| `heading` | Yes | AGV heading in degrees (0 = right, 90 = down, 180 = left, 270 = up) |
| `dwell` | No | Stop duration in seconds; overrides the global Action dur setting |
| `label` | No | Annotation text shown during the stop |
| `mode` | No | `manual` shows a worker figure; omit or `auto` for none |

### TRACK fields
| Field | Description |
|-------|-------------|
| `points` | Map of track point ID → `{x, y}` in image coordinates |
| `segments[].type` | `straight` or `arc` |
| `segments[].radius` | Arc radius in image pixels (arc only) |
| `segments[].clockwise` | `true` = clockwise arc visually (arc only) |

> **Legacy format:** A single-AGV file with a top-level `SEQUENCE` array (no `AGVS` key) is still supported — the player wraps it as a single red AGV automatically.

---

## Dispatch Mode (on-demand FIFO simulation)

Scripted sequences play a fixed timeline. **Dispatch mode** turns the player into a live
discrete-event simulation: production *lines* request service on demand, requests queue **FIFO**, an
idle AGV is dispatched from **home** to serve the head of the queue, AGVs genuinely **wait/yield** on
shared track (real queueing, not just a collision blink), then return to their home slot.

Dispatch mode activates automatically when the layout JSON contains a `DISPATCH` block. AGVs start
with empty sequences — the engine builds each job (`home → line → serve → home`) dynamically.

### Authoring (Coordinate Picker)
1. Place `seq_point` nodes for the home parking slots and each line's service point (snap them to the
   track so AGVs route correctly).
2. Open the **DISPATCH** panel (right side), tick **Enable dispatch mode**.
3. For each node choose a role: **home** (parking slot — order = AGV order) or **line** (service point,
   with a service-time field).
4. Optionally type a **Requests** timeline (`t  LINE-X  [AGV-0N]`, one per line) for a repeatable
   recording, and/or enable **Auto-generate** (seeded random arrivals).
5. Save — a `DISPATCH` block is added to the JSON.

### Playback controls (Animation Player)
| Control | Action |
|---------|--------|
| **Call LINE-X** | Inject an on-demand request for that line (queues FIFO) |
| **Auto** | Toggle the seeded random request generator |
| HUD | Shows live queue length, pending count per line, and each AGV's state (HOME / TO LINE / SERVING / WAIT / RETURN) |

- A request pinned to a specific AGV (`"agv": "AGV-01"`) is always served by that AGV — strict FIFO
  means the queue head waits for its pinned AGV to free up.
- **Deterministic video:** with a `requests` timeline (and auto-generate off), every recording is
  identical (seeded RNG). Recording auto-stops once the timeline drains and all AGVs are home.

### `DISPATCH` fields
| Field | Description |
|-------|-------------|
| `home` | Node id of the dispatch base (fallback parking spot) |
| `homeSlots` | Ordered node ids — one parking slot per AGV (recommended for multi-AGV so they don't contend for the same track point) |
| `lines[]` | `{ id, node, serviceAction, serviceTime }` — service points that can request an AGV |
| `requests[]` | Deterministic timeline `{ t, line, agv? }` (seconds, line id, optional AGV pin) |
| `autoGenerate` | `{ enabled, meanInterval, seed }` — seeded Poisson on-demand generator |

```json
"DISPATCH": {
  "home": "HS-1",
  "homeSlots": ["HS-1", "HS-2", "HS-3"],
  "lines": [
    { "id": "LINE-A", "node": "LA", "serviceAction": "exchange", "serviceTime": 3 },
    { "id": "LINE-B", "node": "LB", "serviceAction": "exchange", "serviceTime": 3 }
  ],
  "requests": [
    { "t": 1, "line": "LINE-A" },
    { "t": 4, "line": "LINE-A", "agv": "AGV-01" }
  ],
  "autoGenerate": { "enabled": false, "meanInterval": 6, "seed": 1234 }
}
```

> A ready-made example is in [`sample_dispatch.json`](sample_dispatch.json) (3 AGVs, 3 lines, no
> background image needed). Track-yield queueing assumes a sensible track layout — head-on traffic on
> a single shared lane can deadlock, so use loops/spurs for opposing flows.

---

## Project files

| File | Role |
|------|------|
| `index.html` | Landing page linking the two tools |
| `cpicker.html` / `cpicker.js` | Coordinate Picker — layout, track, sequence & dispatch authoring |
| `animplayer.html` / `animplayer.js` | Animation Player — playback, rendering, video recording |
| `dispatch.js` | On-demand FIFO dispatch & queue engine (loaded by the player) |
| `shared.js` | Shared utilities — coordinate transforms, path following, JSON normalisation, seeded RNG |
| `style.css` | Shared styling |
| `sample_dispatch.json` | Ready-to-run 3-AGV / 3-line dispatch example |

---

## Stack

Vanilla JavaScript · HTML5 Canvas · No frameworks · No build step · Fully client-side

Runs directly from GitHub Pages — no backend required.
