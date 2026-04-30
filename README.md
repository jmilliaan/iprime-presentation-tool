# iPrime Presentation Tool

A browser-based AGV layout and animation suite for creating and presenting Automated Guided Vehicle sequences on factory floor plans.

**Live app:** [jmilliaan.github.io/iprime-presentation-tool](https://jmilliaan.github.io/iprime-presentation-tool)
**Repository:** [github.com/jmilliaan/iprime-presentation-tool](https://github.com/jmilliaan/iprime-presentation-tool)

---

## Tools

### 📍 Coordinate Picker
Define the physical layout — place nodes on a floor plan image and build the AGV sequence.

### ▶ Animation Player
Load a saved layout JSON and play back the AGV movement sequence as an animation.

---

## Workflow

```
Floor plan image + Coord Picker  →  coords.json  →  Animation Player
```

1. Open **Coordinate Picker**, load your floor plan image and optionally an existing JSON
2. Place **seq_points** (named stops where actions happen) and **waypoints** (anonymous pass-through points)
3. Switch to **Sequence Mode** (`E`), click nodes in order, select action + heading + optional dwell/label/mode
4. Press `S` to save `coords.json`
5. Open **Animation Player**, load `coords.json` and the same floor plan image
6. Press Play

---

## Coordinate Picker

### Modes
| Key | Mode |
|-----|------|
| `E` | Toggle NODE ↔ SEQUENCE mode |
| `S` | Save JSON |
| `Esc` | Cancel current action |
| Right-click | Undo last node / sequence entry |

### NODE Mode
- **Left-click** anywhere to open the placement radial
  - **Left half** → `seq_point` (named stop, can have trolley actions)
  - **Right half** → `waypoint` (auto-named pass-through point)

### SEQUENCE Mode
- **Left-click** a node to add it to the sequence
  - `seq_point` → choose action, then heading angle, then optional details
  - `waypoint` → choose heading angle directly (action is always `move`)
- After selecting a heading, a **details bar** appears:
  - **Dwell (s)** — override the stop duration for this entry (leave blank to use the global setting in the player)
  - **Label** — text annotation shown during the stop (e.g. `dock lock`, `waiting for crane`)
  - **Manual** checkbox — marks this stop as a manual operation; a worker figure is shown in the animation

### Trolley Actions
| Action | Meaning |
|--------|---------|
| `move` | AGV passes through without stopping |
| `pickup` | AGV attaches a trolley |
| `release` | AGV detaches the trolley and leaves it |
| `exchange` | AGV swaps one trolley for another |

### Navigation
| Input | Action |
|-------|--------|
| Scroll | Zoom |
| Middle-click drag | Pan |

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

### Visual Guide

**Path segments**
- **Orange solid line** — AGV is carrying a trolley on this leg
- **Purple dashed line** — AGV is travelling empty on this leg

**During a stop**
- Colored progress ring around the AGV shows how far through the action it is
- Label text above the AGV shows the action type and any custom label
- Blue stick figure next to the AGV = **manual operation** (worker required)

**Recording**
- Click ⏺ Record to capture the animation as a `.webm` video (Chrome / Edge only)
- Recording auto-starts playback from the beginning and stops when done

### Navigation
| Input | Action |
|-------|--------|
| Scroll | Zoom |
| Middle-click drag | Pan |

---

## JSON Format

```json
{
  "NODES": {
    "HP-01": { "x": 420, "y": 310, "type": "seq_point" },
    "WP-01": { "x": 210, "y": 310, "type": "waypoint" }
  },
  "SEQUENCE": [
    { "node": "HP-01", "action": "pickup",  "heading": 0,   "dwell": 3, "label": "dock lock", "mode": "manual" },
    { "node": "WP-01", "action": "move",    "heading": 180 },
    { "node": "HP-01", "action": "release", "heading": 0,   "dwell": 2 }
  ]
}
```

### Sequence entry fields
| Field | Required | Description |
|-------|----------|-------------|
| `node` | Yes | Node ID from `NODES` |
| `action` | Yes | `move` / `pickup` / `release` / `exchange` |
| `heading` | Yes | AGV heading in degrees (0 = right, 90 = down, 180 = left, 270 = up) |
| `dwell` | No | Stop duration in seconds; overrides the global Action dur setting |
| `label` | No | Annotation text shown during the stop |
| `mode` | No | `manual` shows a worker figure; omit or `auto` for no figure |

---

## Stack

Vanilla JavaScript · HTML5 Canvas · No frameworks · No build step · Fully client-side

Runs directly from GitHub Pages with no backend required.
