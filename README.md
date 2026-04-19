# LynnwoodTrafficStats

Takes regular snapshots of all Lynnwood, WA traffic cameras and uses YOLOv8 to count pedestrians, cyclists, motorcycles, cars, buses, and trucks over time. Serves a realtime map UI on your LAN and periodically exports a static site to a git repo for Cloudflare Pages.

---

## Synology NAS Deployment

### Prerequisites

- Repo cloned to `/volume1/docker/LynnwoodTrafficStats` on the NAS
- Docker installed (via Synology Package Center)
- SSH access to the NAS as `root`

---

### Step 1 — Create volume directories

```bash
mkdir -p /volume1/docker/lynnwoodtraffic/config
mkdir -p /volume1/docker/lynnwoodtraffic/data
```

---

### Step 2 — Build the image

The build takes 5–10 minutes the first time (downloads Playwright/Chromium and YOLOv8 weights).

```bash
cd /volume1/docker/LynnwoodTrafficStats
docker build -t lynnwoodtraffic:latest .
```

> **Note the trailing `.`** — it tells Docker to use the current directory as the build context.

---

### Step 3 — Deploy via Portainer Stack

In Portainer → Stacks → Add Stack, paste the following:

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

Deploy the stack. The container will:
1. Create `/config/settings.json` with defaults on first run
2. Seed `yolov8n.pt` weights into `/data/models/`
3. Trigger an initial camera discovery against lynnwoodwa.gov
4. Start snapshotting cameras every 5 minutes

The web UI is available at `http://<NAS-IP>:6970`

---

### Step 4 (Optional) — Set up the public static site

To push snapshots to a public Cloudflare Pages site:

1. Create a new **empty** GitHub repo for the static output
2. Open the web UI → **Settings**
3. Click **Generate Deploy Key** and copy the public key shown
4. On GitHub: repo → Settings → Deploy Keys → Add key (enable write access)
5. Back in the web UI, paste your repo's SSH URL into **Git Repo URL** (e.g. `git@github.com:you/lynnwood-traffic-static.git`) and save
6. The container will push an updated static site every 10 minutes

Connect the GitHub repo to [Cloudflare Pages](https://pages.cloudflare.com/) with no build command and `/` as the output directory.

---

### Rebuilding after a code update

```bash
cd /volume1/docker/LynnwoodTrafficStats
git pull
docker build -t lynnwoodtraffic:latest .
```

Then restart the stack in Portainer (or `docker restart lynnwoodtraffic`).

---

### Volume contents reference

```
/volume1/docker/lynnwoodtraffic/
  config/
    settings.json        # All settings — edit here or via the web UI
    git_deploy_key       # SSH private key for git push (generated via UI)
    git_deploy_key.pub   # Public key — add this to your GitHub repo
  data/
    traffic.db           # SQLite database (never deleted)
    images/              # WebP snapshots per camera
    models/
      yolov8n.pt         # Detection weights (seeded from image on first run)
    static-export/       # Generated static site (git-pushed periodically)
```

### Settings reference

All settings are editable in the web UI under **Settings**, or by directly editing `/volume1/docker/lynnwoodtraffic/config/settings.json`:

| Setting | Default | Description |
|---|---|---|
| `snapshot_interval_seconds` | `300` | How often to snapshot all cameras |
| `image_retention_count` | `1000` | Max WebP images stored per camera |
| `static_export_interval_seconds` | `600` | How often to push the static site |
| `git_repo_url` | `""` | SSH URL of the static site git repo |
| `git_remote_branch` | `"main"` | Branch to push to |
| `detection_model` | `"yolov8n.pt"` | YOLOv8 model filename in `/data/models/` |
| `detection_confidence_threshold` | `0.4` | Minimum detection confidence (0–1) |
