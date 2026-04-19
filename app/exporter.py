import json
import logging
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import database, settings

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
EXPORT_DIR = DATA_DIR / "static-export"
APP_STATIC = Path(__file__).parent / "static"
DEPLOY_KEY = Path(os.environ.get("CONFIG_DIR", "/config")) / "git_deploy_key"


def _git(*args, cwd: Path) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    if DEPLOY_KEY.exists():
        env["GIT_SSH_COMMAND"] = f"ssh -i {DEPLOY_KEY} -o StrictHostKeyChecking=no"
    return subprocess.run(
        ["git"] + list(args),
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _ensure_git_repo(repo_url: str, branch: str) -> bool:
    """Init or pull the export directory as a git repo."""
    if not (EXPORT_DIR / ".git").exists():
        EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        result = _git("clone", "--depth=1", "-b", branch, repo_url, ".", cwd=EXPORT_DIR)
        if result.returncode != 0:
            # Init fresh if clone fails (repo may be empty)
            _git("init", cwd=EXPORT_DIR)
            _git("remote", "add", "origin", repo_url, cwd=EXPORT_DIR)
            _git("checkout", "-b", branch, cwd=EXPORT_DIR)
            return True
    else:
        _git("fetch", "origin", cwd=EXPORT_DIR)
        _git("reset", "--hard", f"origin/{branch}", cwd=EXPORT_DIR)
    return True


def _export_camera_video(cam_id: int, data_dir: Path) -> None:
    """Build data/cameras/{id}/video.webm and index.json from retained snapshots."""
    snaps = database.get_snapshots(camera_id=cam_id, limit=100_000)
    snaps.sort(key=lambda s: s["captured_at"])

    # Collect frame paths (annotated preferred, fall back to raw)
    frame_paths: list[Path] = []
    index: list[dict] = []
    fps = 4

    for snap in snaps:
        img_rel = snap.get("annotated_path") or snap.get("image_path")
        if not img_rel:
            continue
        full = DATA_DIR / img_rel
        if not full.exists():
            continue
        frame_paths.append(full)
        index.append({
            "t": 0,  # filled in below after filtering
            "ts": snap["captured_at"],
            "car_count":        snap.get("car_count", 0),
            "truck_count":      snap.get("truck_count", 0),
            "bus_count":        snap.get("bus_count", 0),
            "motorcycle_count": snap.get("motorcycle_count", 0),
            "person_count":     snap.get("person_count", 0),
            "bicycle_count":    snap.get("bicycle_count", 0),
            "total_count":      snap.get("total_count", 0),
        })

    if not frame_paths:
        logger.debug("No frames for camera %d — skipping video export", cam_id)
        return

    for i, entry in enumerate(index):
        entry["t"] = round(i / fps, 4)

    out_dir = data_dir / "cameras" / str(cam_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.json").write_text(json.dumps(index))

    # Build ffmpeg concat list — duplicate last frame to avoid VP9 truncation
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, dir="/tmp") as flist:
        for p in frame_paths:
            flist.write(f"file '{p}'\nduration {1/fps}\n")
        flist.write(f"file '{frame_paths[-1]}'\n")
        flist_path = flist.name

    video_path = out_dir / "video.webm"
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0", "-i", flist_path,
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:v", "libvpx-vp9",
                "-b:v", "0", "-crf", "33",
                "-deadline", "good", "-cpu-used", "5",
                "-an",
                str(video_path),
            ],
            capture_output=True,
            timeout=600,
        )
        if result.returncode != 0:
            logger.error("ffmpeg failed for camera %d: %s", cam_id, result.stderr.decode()[-500:])
        else:
            size_kb = video_path.stat().st_size // 1024
            logger.info("Camera %d video: %d frames → %s (%d KB)", cam_id, len(frame_paths), video_path.name, size_kb)
    except FileNotFoundError:
        logger.error("ffmpeg not found — add it to the Docker image")
    except subprocess.TimeoutExpired:
        logger.error("ffmpeg timed out for camera %d", cam_id)
    finally:
        try:
            os.unlink(flist_path)
        except OSError:
            pass


def generate_static_site() -> None:
    cfg = settings.load()
    repo_url = cfg.get("git_repo_url", "")

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    # Copy static assets
    for f in APP_STATIC.rglob("*"):
        if f.is_file():
            dest = EXPORT_DIR / f.relative_to(APP_STATIC)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)

    # Write data bundle
    data_dir = EXPORT_DIR / "data"
    data_dir.mkdir(exist_ok=True)

    cameras = database.get_cameras(active_only=False)
    (data_dir / "cameras.json").write_text(json.dumps(cameras, default=str))

    # Per-camera video + frame index for the static site player
    for cam in cameras:
        _export_camera_video(cam["id"], data_dir)

    hourly = database.get_hourly_aggregates()
    (data_dir / "snapshots_aggregated.json").write_text(json.dumps(hourly, default=str))

    csv_data = database.export_csv()
    (data_dir / "snapshots_raw.csv").write_text(csv_data)

    # Write a flag so JS knows this is the static build (no SSE)
    (EXPORT_DIR / "static-build.json").write_text(json.dumps({"static": True}))

    logger.info("Static site written to %s", EXPORT_DIR)

    if not repo_url:
        logger.info("No git_repo_url configured — skipping push")
        return

    try:
        _ensure_git_repo(repo_url, cfg.get("git_remote_branch", "main"))
        _git("add", "-A", cwd=EXPORT_DIR)
        result = _git("diff", "--cached", "--quiet", cwd=EXPORT_DIR)
        if result.returncode == 0:
            logger.info("No changes to push")
            return
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        _git("commit", "-m", f"data: {ts}", cwd=EXPORT_DIR)
        push = _git("push", "origin", cfg.get("git_remote_branch", "main"), cwd=EXPORT_DIR)
        if push.returncode == 0:
            logger.info("Pushed static site to git")
        else:
            logger.error("Git push failed: %s", push.stderr)
    except Exception as e:
        logger.error("Export git push error: %s", e)


def generate_deploy_key() -> str:
    """Generate an ed25519 SSH key pair. Returns public key content."""
    config_dir = Path(os.environ.get("CONFIG_DIR", "/config"))
    key_path = config_dir / "git_deploy_key"
    key_path.parent.mkdir(parents=True, exist_ok=True)

    if key_path.exists():
        key_path.unlink()
    pub_path = Path(str(key_path) + ".pub")
    if pub_path.exists():
        pub_path.unlink()

    subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-f", str(key_path), "-N", "", "-C", "lynnwoodtraffic"],
        check=True, capture_output=True,
    )
    key_path.chmod(0o600)
    return pub_path.read_text().strip()
