# LynnwoodTrafficStats — CLAUDE.md

## Project Purpose

Docker container on a Synology NAS. Automatically discovers and snapshots every traffic camera
on lynnwoodwa.gov at a configurable interval, runs YOLOv8 nano object detection on each frame,
stores counts in SQLite, and serves:
- A **realtime LAN web UI** (Leaflet map + heatmap + animation playback + settings)
- A **periodically-exported static site** pushed to a git repo for Cloudflare Pages

Owner: Quinn Van Order (quinn@qmvo.org)

---

## Tech Stack

### Backend
- Python 3.12+
- FastAPI + Uvicorn (port 8000 internal, 6970 external)
- APScheduler — 2 jobs: snapshot job (configurable interval) + camera discovery (every 60 min)
- Ultralytics YOLOv8 nano (`yolov8n.pt`) for object detection
- SQLite via stdlib `sqlite3` (no ORM)
- Playwright (headless Chromium) for camera discovery — lynnwoodwa.gov returns 403 on direct HTTP
- Nominatim geocoding API — GPS fallback if coordinates not extractable from page JS
- SSE (Server-Sent Events) for realtime browser push

### Frontend (LAN + Static Export — same codebase)
- Pure HTML/CSS/JavaScript, no build step
- Leaflet.js + OpenStreetMap tiles (free, no API key, LAN-friendly)
- leaflet.heat plugin for heatmap overlays
- EventSource (SSE) for realtime updates on LAN; disabled in static export
- All data for static site bundled as pre-generated JSON files

---

## Docker Deployment

### Portainer Stack

```yaml
services:
  lynnwoodtraffic:
    image: lynnwoodtraffic:latest
    container_name: lynnwoodtraffic
    restart: on-failure:5
    ports:
      - "6970:8000"
    volumes:
      - /volume1/docker/lynnwoodtraffic/config:/config:rw
      - /volume1/docker/lynnwoodtraffic/data:/data:rw
    environment:
      TZ: America/Los_Angeles
      PUID: 1029
      PGID: 100
    security_opt:
      - no-new-privileges:true
      - seccomp:unconfined
    healthcheck:
      test: ["CMD", "nc", "-z", "localhost", "8000"]
      interval: 30s
      timeout: 5s
      retries: 3
```

### Entrypoint
`entrypoint.sh` uses `su-exec` to drop from root to PUID/PGID before starting Uvicorn.

### Docker Build Notes
- Multi-stage build (builder + runtime)
- Pre-download `yolov8n.pt` weights during `docker build` so NAS doesn't need internet at runtime
- Playwright + Chromium adds ~500MB to the image; `curl_cffi` is a possible lighter alternative
  to bypass the 403 — worth investigating if image size becomes a problem

---

## Volume Layout

```
/config/
  settings.json           # All user-configurable settings (plaintext JSON, human-readable)
  git_deploy_key          # SSH private key for git push (chmod 600, generated via UI)
  git_deploy_key.pub      # SSH public key (copy to GitHub repo as deploy key)

/data/
  traffic.db              # SQLite database (stats kept forever)
  images/                 # WebP snapshot images (count-based retention per camera)
  models/
    yolov8n.pt            # Pre-downloaded during docker build
  static-export/          # Generated static site (git-pushed every static_export_interval_seconds)
    index.html
    data/
      cameras.json
      snapshots_aggregated.json   # Hourly bucket aggregates (for map/heatmap/animation)
      snapshots_raw.csv           # Full raw data (for CSV download)
```

---

## settings.json Schema

All fields are editable via the web UI Settings page. File lives at `/config/settings.json`.

```json
{
  "snapshot_interval_seconds": 300,
  "image_retention_count": 1000,
  "static_export_interval_seconds": 600,
  "git_repo_url": "git@github.com:user/lynnwood-traffic-static.git",
  "git_remote_branch": "main",
  "detection_model": "yolov8n.pt",
  "detection_confidence_threshold": 0.4
}
```

---

## Database Schema

Stats records are kept **forever**. Only image files have configurable retention (count-based per camera).

### `cameras`
| column    | type    | notes                           |
|-----------|---------|---------------------------------|
| id        | INTEGER | PRIMARY KEY                     |
| url       | TEXT    | UNIQUE — image endpoint URL     |
| address   | TEXT    | Display name / street address   |
| lat       | REAL    | GPS latitude                    |
| lon       | REAL    | GPS longitude                   |
| is_custom | INTEGER | 0=auto-discovered, 1=user-added |
| active    | INTEGER | 0=skip in snapshot job          |
| added_at  | TEXT    | ISO8601                         |

### `snapshots`
| column           | type    | notes                                          |
|------------------|---------|------------------------------------------------|
| id               | INTEGER | PRIMARY KEY                                    |
| camera_id        | INTEGER | FK → cameras.id                                |
| captured_at      | TEXT    | ISO8601                                        |
| image_path       | TEXT    | Relative path under /data/images/              |
| annotated_path   | TEXT    | Annotated image from default model (compat)    |
| person_count … total_count | INTEGER | Mirrored from default model's model_counts |

### `model_configs`
| column              | type    | notes                                        |
|---------------------|---------|----------------------------------------------|
| model_name          | TEXT    | PRIMARY KEY (e.g. yolo11s.pt)                |
| is_active           | INTEGER | 1 = run on every snapshot                    |
| is_default          | INTEGER | 1 = counts shown on map (only one row = 1)   |
| downloaded_at       | TEXT    | ISO8601 — when last downloaded               |
| ultralytics_version | TEXT    | Library version at download time             |

### `model_counts`
| column           | type    | notes                                          |
|------------------|---------|------------------------------------------------|
| id               | INTEGER | PRIMARY KEY                                    |
| snapshot_id      | INTEGER | FK → snapshots.id                              |
| model_name       | TEXT    | e.g. yolo11s.pt                                |
| annotated_path   | TEXT    | images/{cam_id}/annotated/{model_slug}/{ts}.webp |
| person/bicycle/motorcycle/car/bus/truck/total_count | INTEGER | |
| processed_at     | TEXT    | ISO8601                                        |
| UNIQUE(snapshot_id, model_name)                     | — idempotent INSERT OR IGNORE |

---

## Detected Categories

YOLOv8 nano is trained on COCO. We use these classes:

| COCO class | UI label    |
|------------|-------------|
| person     | Pedestrians |
| bicycle    | Cyclists    |
| motorcycle | Motorcycles |
| car        | Cars        |
| bus        | Buses       |
| truck      | Trucks      |

---

## Camera Discovery

Job runs every **60 minutes** (fixed, not configurable):
1. Playwright fetches lynnwoodwa.gov traffic camera page
2. Extracts camera URLs + GPS coordinates from JS-rendered map
3. GPS fallback: Nominatim geocoding using street address if coordinates unavailable
4. New cameras → insert into DB. Disappeared cameras → set `active=0` (never deleted).
5. Manual trigger available via POST `/api/cameras/discover`

### Custom Cameras
User adds via web UI with 3 fields: image endpoint URL, address/display name, GPS (lat/lon).

---

## Local LAN Web UI

### Map View
- Leaflet.js centered on Lynnwood, WA
- One pin per active camera; click → popup with stats summary for selected time window
- Category layer checkboxes (Pedestrians, Cyclists, Motorcycles, Cars, Buses, Trucks)
- Each checked category renders a `leaflet.heat` overlay with its own color
- Heatmap intensity = count of that category in selected time window
- Circle radius scales with count magnitude

### Time Window Selector
Dropdown: **All time / 5 years / 1 year / 6 months / 1 month / 1 week / 1 day / 1 hour**

### Animation Playback
- Same time window selector as map view
- "Play" button starts animation; duration slider (default 30s)
- Frame count: `N = fps × duration_seconds` (target ~24fps)
- Snapshots are evenly sampled from the time window to produce exactly N frames
  (e.g. "all time" → widely spaced samples; "1 hour" → dense samples)
- Each frame renders the heatmap for that snapshot's category counts
- Progress bar + timestamp display during playback

### CSV Download
Full export of `snapshots` JOIN `cameras`:
`timestamp, camera_url, address, lat, lon, person_count, bicycle_count, motorcycle_count, car_count, bus_count, truck_count, total_count`

### Realtime Updates (LAN only)
- SSE endpoint `/api/events` pushes JSON after each completed snapshot job
- Browser `EventSource` receives event → updates map heatmap + camera popup stats without page reload
- Static export disables SSE (no server to connect to)

### Settings Page
- All `settings.json` fields as form inputs
- "Generate Deploy Key" button: creates `/config/git_deploy_key` + displays public key for copying to GitHub
- "Trigger Discovery Now" button
- "Export Static Site Now" button

---

## Static Site Export (Cloudflare Pages)

Every `static_export_interval_seconds` (default 600s = 10 min):
1. Aggregate all snapshot data into hourly buckets → `snapshots_aggregated.json`
2. Write full raw CSV → `snapshots_raw.csv`
3. Write camera metadata → `cameras.json`
4. Copy static HTML/JS/CSS to `/data/static-export/`
5. `git add -A && git commit -m "data: <timestamp>" && git push` via SSH deploy key

### SSH Deploy Key Setup
```bash
# Done via Settings UI "Generate Deploy Key" button, or manually:
ssh-keygen -t ed25519 -f /config/git_deploy_key -N ""
# Then add /config/git_deploy_key.pub as a deploy key on the GitHub repo (read/write)
```
Container sets:
```
GIT_SSH_COMMAND="ssh -i /config/git_deploy_key -o StrictHostKeyChecking=no"
```

### Static Data Bundling Rationale
Raw snapshot data at "all time" scale (years of 5-min snapshots) is too large to bundle as JSON.
`snapshots_aggregated.json` uses **hourly bucket aggregates** (sum per camera per hour).
Animation playback on the static site uses these hourly buckets as its frames.
Full raw data is available only via CSV download.

---

## API Endpoints (FastAPI)

| Method | Path                       | Description                            |
|--------|----------------------------|----------------------------------------|
| GET    | /                          | Serve local UI index.html              |
| GET    | /api/cameras               | List all cameras                       |
| POST   | /api/cameras               | Add custom camera                      |
| PATCH  | /api/cameras/{id}          | Update camera (active toggle, etc.)    |
| DELETE | /api/cameras/{id}          | Remove custom camera                   |
| POST   | /api/cameras/discover      | Trigger manual discovery               |
| GET    | /api/snapshots             | Query snapshots (camera_id, start, end, limit) |
| GET    | /api/stats                 | Aggregated stats (time window param)   |
| GET    | /api/events                | SSE stream                             |
| GET    | /api/settings              | Read settings.json                     |
| PUT    | /api/settings              | Write settings.json                    |
| POST   | /api/settings/generate-key | Generate SSH deploy key pair           |
| GET    | /api/export/csv            | Download full CSV                      |
| POST   | /api/export/static         | Trigger manual static site export      |

---

## Source File Structure

```
LynnwoodTrafficStats/
  CLAUDE.md                  # This file — architecture + design decisions
  Dockerfile
  docker-compose.yml         # Reference stack for Portainer
  requirements.txt
  entrypoint.sh              # su-exec privilege drop → uvicorn
  app/
    main.py                  # FastAPI app, lifespan startup, mounts static/
    scheduler.py             # APScheduler: snapshot_job + discovery_job
    discovery.py             # Playwright scraper for lynnwoodwa.gov
    detection.py             # YOLOv8 inference wrapper
    database.py              # SQLite: connection, schema init, all queries
    settings.py              # settings.json read/write helpers
    exporter.py              # Static site generator + git push
    sse.py                   # SSE event queue + broadcast helper
    api/
      __init__.py
      cameras.py             # /api/cameras routes
      snapshots.py           # /api/snapshots + /api/stats routes
      settings.py            # /api/settings routes
      events.py              # /api/events SSE route
      export.py              # /api/export routes
    static/
      index.html             # Single-page app shell (LAN + static export)
      css/
        main.css
      js/
        map.js               # Leaflet map init, pins, popups
        heatmap.js           # leaflet.heat layer management per category
        animation.js         # Playback engine, frame sampling, slider
        settings.js          # Settings form, deploy key UI
        realtime.js          # SSE EventSource (disabled in static export)
        data.js              # Data fetching abstraction (API vs bundled JSON)
```

---

## Design Decisions Log

| Decision | Choice | Reason |
|----------|--------|--------|
| Camera scraping | Playwright | lynnwoodwa.gov returns 403 on direct HTTP |
| Detection model | YOLOv8 nano | Small (~6MB), fast CPU inference on NAS |
| Model weight download | During docker build | NAS may not have internet access at runtime |
| Database | SQLite | No external deps; single-file; sufficient throughput |
| Stats retention | Forever | Historical data is the entire point of the project |
| Image retention | Count-based per camera | Predictable disk use regardless of capture interval |
| Image format | WebP | Space-efficient; good quality; native browser support |
| Map library | Leaflet + OpenStreetMap | Free, no API key, fully LAN-compatible |
| Realtime delivery | SSE not WebSocket | Read-only push; SSE is simpler and sufficient |
| Static export data | Hourly bucket aggregates | Raw snapshot data is too large to bundle for "all time" |
| Static site auth | SSH deploy key | No token expiry; repo-scoped; more secure than user PAT |
| Deploy key generation | Via Settings UI button | Reduces manual setup steps |
| Config location | /config/settings.json | Survives container recreation; separate from data volume |
| Port | 6970 external → 8000 internal | Avoids conflict with common Synology NAS ports |
| GPS fallback | Nominatim | Free, no key required; used only when JS extraction fails |
| Custom cameras | 3-field form | Minimal friction; URL + address + GPS is sufficient |
| Buses category | Included | COCO-native; relevant for Lynnwood transit corridors |
| Multi-model counts | model_counts table (not snapshot columns) | Allows per-model historical data; default model shown on map |
| Snapshot count columns | Mirrored from default model | Backward compat for CSV/hourly export; get_stats uses model_counts with COALESCE fallback |
| Annotated path | images/{cam_id}/annotated/{model_slug}/{ts}.webp | Per-model subdirectory prevents collisions |
| Model weights | All 10 bundled in Docker image | NAS has no internet; update check at startup re-downloads if ultralytics version changed |
| Backfill | Incremental per-model (INSERT OR IGNORE) | Only processes snapshots not yet in model_counts for that model |
| Model UI | Table with Active checkbox + Default radio | Active = runs on snapshots; Default = shown on map; default is always forced active |

---

## Session Continuity Guide

This CLAUDE.md is the primary source of truth. Future Claude sessions should:

1. **Read this file first** — full architecture and all prior design decisions are here
2. **`git log --oneline`** — see what has been implemented so far
3. **Check `app/` directory** — verify current implementation state vs. this plan
4. **Update the Design Decisions Log above** when any architectural choice changes
5. **Update `.claude/projects/.../memory/project_lynnwood_traffic.md`** with any significant new facts for cross-session cold-start context

### Session opener examples
- "I'm implementing `discovery.py` — read CLAUDE.md first for context"
- "I'm implementing the animation playback feature — see CLAUDE.md §Animation Playback"
- "I'm debugging the static export — see CLAUDE.md §Static Site Export"

### What goes where
| Store | What |
|-------|------|
| **CLAUDE.md** | Architecture, schema, design decisions, file structure (timeless) |
| **Memory file** | Quick facts for cold-start: deployment target, key libs, owner, major pivots |
| **Git log** | What was built and when |
| **Code** | Implementation details |
