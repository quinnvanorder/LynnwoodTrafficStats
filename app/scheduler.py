import cv2
import io
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import requests
from apscheduler.schedulers.background import BackgroundScheduler
from PIL import Image

from . import database, detection, discovery, exporter, settings, sse

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
IMAGES_DIR = DATA_DIR / "images"

_scheduler: BackgroundScheduler | None = None


def _fetch_hls_frame(hls_url: str) -> Image.Image | None:
    try:
        r = requests.get(hls_url, timeout=10)
        r.raise_for_status()
        base = hls_url.rsplit("/", 1)[0]
        stream_path = next((l for l in r.text.splitlines() if l and not l.startswith("#")), None)
        if not stream_path:
            return None
        stream_url = base + "/" + stream_path

        r2 = requests.get(stream_url, timeout=10)
        r2.raise_for_status()
        seg_base = stream_url.rsplit("/", 1)[0]
        seg = next((l for l in r2.text.splitlines() if l and not l.startswith("#")), None)
        if not seg:
            return None
        seg_url = seg if seg.startswith("http") else seg_base + "/" + seg

        seg_data = requests.get(seg_url, timeout=30).content
        with tempfile.NamedTemporaryFile(suffix=".ts", delete=False) as f:
            f.write(seg_data)
            tmp = f.name
        try:
            cap = cv2.VideoCapture(tmp)
            ok, frame = cap.read()
            cap.release()
            if not ok:
                logger.warning("cv2 could not decode frame from %s", seg_url)
                return None
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            return Image.fromarray(frame_rgb)
        finally:
            os.unlink(tmp)
    except Exception as e:
        logger.warning("Failed to fetch HLS frame from %s: %s", hls_url, e)
        return None


def _fetch_image(url: str) -> Image.Image | None:
    if url.endswith(".m3u8"):
        return _fetch_hls_frame(url)
    try:
        resp = requests.get(url, timeout=10, stream=True)
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception as e:
        logger.warning("Failed to fetch %s: %s", url, e)
        return None


def _save_image(camera_id: int, image: Image.Image, captured_at: str, subdir: str | None = None) -> str | None:
    try:
        cam_dir = IMAGES_DIR / str(camera_id)
        if subdir:
            cam_dir = cam_dir / subdir
        cam_dir.mkdir(parents=True, exist_ok=True)
        safe_ts = captured_at.replace(":", "-").replace(" ", "T")
        path = cam_dir / f"{safe_ts}.webp"
        image.save(path, "WEBP", quality=80)
        return str(path.relative_to(DATA_DIR))
    except Exception as e:
        logger.warning("Failed to save image for camera %d: %s", camera_id, e)
        return None


def _prune_images(camera_id: int, retention_count: int) -> None:
    stale_paths = database.prune_images(camera_id, retention_count)
    for rel_path in stale_paths:
        full = DATA_DIR / rel_path
        try:
            full.unlink(missing_ok=True)
        except Exception as e:
            logger.debug("Could not delete %s: %s", full, e)


def snapshot_job() -> None:
    cfg = settings.load()
    model_name = cfg["detection_model"]
    confidence = cfg["detection_confidence_threshold"]
    retention = cfg["image_retention_count"]

    cameras = database.get_cameras(active_only=True)
    if not cameras:
        logger.info("No active cameras — skipping snapshot")
        return

    results = []
    for cam in cameras:
        img = _fetch_image(cam["url"])
        if img is None:
            continue

        counts, annotated_img = detection.detect(img, model_name=model_name, confidence=confidence)

        captured_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        image_path = _save_image(cam["id"], img, captured_at)
        annotated_path = _save_image(cam["id"], annotated_img, captured_at, subdir="annotated")
        snap_id = database.insert_snapshot(
            cam["id"], image_path, counts, captured_at, annotated_path=annotated_path
        )
        _prune_images(cam["id"], retention)

        results.append({**counts, "camera_id": cam["id"], "snapshot_id": snap_id,
                        "captured_at": captured_at})

    if results:
        sse.broadcast("snapshot", {"snapshots": results})
        logger.info("Snapshot complete: %d cameras processed", len(results))


def discovery_job() -> None:
    try:
        count = discovery.discover_cameras()
        sse.broadcast("discovery", {"cameras_found": count})
    except Exception as e:
        logger.error("Discovery job failed: %s", e)


def export_job() -> None:
    try:
        exporter.generate_static_site()
    except Exception as e:
        logger.error("Export job failed: %s", e)


def start(snapshot_interval: int = 300, export_interval: int = 600) -> None:
    global _scheduler
    _scheduler = BackgroundScheduler(timezone="America/Los_Angeles")

    _scheduler.add_job(snapshot_job, "interval", seconds=snapshot_interval,
                       id="snapshot", replace_existing=True, max_instances=1)
    _scheduler.add_job(discovery_job, "interval", seconds=3600,
                       id="discovery", replace_existing=True, max_instances=1)
    _scheduler.add_job(export_job, "interval", seconds=export_interval,
                       id="export", replace_existing=True, max_instances=1)

    _scheduler.start()
    logger.info("Scheduler started (snapshot=%ds, export=%ds)", snapshot_interval, export_interval)


def reschedule(snapshot_interval: int, export_interval: int) -> None:
    if _scheduler is None:
        return
    _scheduler.reschedule_job("snapshot", trigger="interval", seconds=snapshot_interval)
    _scheduler.reschedule_job("export", trigger="interval", seconds=export_interval)


def trigger_snapshot() -> None:
    if _scheduler:
        _scheduler.add_job(snapshot_job, trigger="date", id="snapshot_manual", replace_existing=True)


def trigger_discovery() -> None:
    if _scheduler:
        _scheduler.add_job(discovery_job, trigger="date", id="discovery_manual", replace_existing=True)


def trigger_export() -> None:
    if _scheduler:
        _scheduler.add_job(export_job, trigger="date", id="export_manual", replace_existing=True)


def stop() -> None:
    if _scheduler:
        _scheduler.shutdown(wait=False)
