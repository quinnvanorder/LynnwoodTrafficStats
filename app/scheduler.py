import cv2
import io
import logging
import os
import tempfile
import time
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

# Backfill tracking — one entry per model being/last backfilled
_backfill_statuses: dict[str, dict] = {}
_backfill_generation: int = 0


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


def _save_image(camera_id: int, image: Image.Image, captured_at: str,
                subdir: str | None = None) -> str | None:
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


def _model_slug(model_name: str) -> str:
    return model_name.replace(".pt", "")


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
    confidence = cfg["detection_confidence_threshold"]
    imgsz = cfg.get("detection_imgsz", 800)
    retention = cfg["image_retention_count"]

    active_models = database.get_active_models()
    default_model = database.get_default_model()

    # Fallback: if nothing configured yet, use the settings model
    if not active_models:
        active_models = [cfg["detection_model"]]
    if not default_model:
        default_model = cfg["detection_model"]

    cameras = database.get_cameras(active_only=True)
    if not cameras:
        logger.info("No active cameras — skipping snapshot")
        return

    results = []
    for cam in cameras:
        img = _fetch_image(cam["url"])
        if img is None:
            continue

        captured_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        image_path = _save_image(cam["id"], img, captured_at)

        # Insert snapshot row first (counts start at zero)
        snap_id = database.insert_snapshot(cam["id"], image_path, {}, captured_at)

        zones = database.get_camera_zones(cam["id"])
        default_counts: dict = {}
        default_ann_path: str | None = None

        for model_name in active_models:
            try:
                t0 = time.monotonic()
                counts, annotated_img = detection.detect(
                    img, model_name=model_name, confidence=confidence,
                    imgsz=imgsz, exclusion_zones=zones,
                )
                elapsed_ms = round((time.monotonic() - t0) * 1000)
                if zones:
                    annotated_img = detection.draw_zone_overlay(annotated_img, zones)
                ann_path = _save_image(
                    cam["id"], annotated_img, captured_at,
                    subdir=f"annotated/{_model_slug(model_name)}",
                )
                database.insert_model_count(snap_id, model_name, counts, ann_path, elapsed_ms)
                if model_name == default_model:
                    default_counts = counts
                    default_ann_path = ann_path
            except Exception as e:
                logger.warning("Detection failed model=%s cam=%d: %s", model_name, cam["id"], e)

        # Keep snapshot columns in sync with default model for CSV/export backward compat
        if default_counts:
            database.update_snapshot_analysis(snap_id, default_counts, default_ann_path)

        _prune_images(cam["id"], retention)

        results.append({
            **default_counts,
            "camera_id": cam["id"],
            "snapshot_id": snap_id,
            "captured_at": captured_at,
        })

    if results:
        sse.broadcast("snapshot", {"snapshots": results})
        logger.info("Snapshot complete: %d cameras × %d models", len(results), len(active_models))


def backfill_job(model_name: str, generation: int = 0) -> None:
    global _backfill_statuses

    from . import model_manager

    cfg = settings.load()
    confidence = cfg["detection_confidence_threshold"]
    imgsz = cfg.get("detection_imgsz", 800)

    if not model_manager.is_available(model_name):
        _backfill_statuses[model_name] = {
            "running": False, "done": 0, "total": 0,
            "error": f"Model '{model_name}' not found — download it from Settings first.",
        }
        logger.error("Backfill aborted: model '%s' not available", model_name)
        return

    snapshots = database.get_snapshots_without_model(model_name)
    _backfill_statuses[model_name] = {
        "running": True, "done": 0, "total": len(snapshots), "error": None,
    }
    logger.info("Backfill started: %d snapshots model=%s", len(snapshots), model_name)

    cam_zones: dict = {}
    for snap in snapshots:
        if _backfill_generation != generation:
            logger.info("Backfill generation %d superseded — stopping", generation)
            _backfill_statuses[model_name]["running"] = False
            return

        cam_id = snap["camera_id"]
        if cam_id not in cam_zones:
            cam_zones[cam_id] = database.get_camera_zones(cam_id)

        full_path = DATA_DIR / snap["image_path"]
        if not full_path.exists():
            _backfill_statuses[model_name]["done"] += 1
            continue
        try:
            img = Image.open(full_path).convert("RGB")
            t0 = time.monotonic()
            counts, annotated_img = detection.detect(
                img, model_name=model_name, confidence=confidence,
                imgsz=imgsz, exclusion_zones=cam_zones[cam_id],
            )
            elapsed_ms = round((time.monotonic() - t0) * 1000)
            if cam_zones[cam_id]:
                annotated_img = detection.draw_zone_overlay(annotated_img, cam_zones[cam_id])
            ann_path = _save_image(
                cam_id, annotated_img, snap["captured_at"],
                subdir=f"annotated/{_model_slug(model_name)}",
            )
            database.insert_model_count(snap["id"], model_name, counts, ann_path, elapsed_ms)

            # If this is the default model, also keep snapshot columns current
            if model_name == database.get_default_model():
                database.update_snapshot_analysis(snap["id"], counts, ann_path)
        except Exception as e:
            logger.warning("Backfill failed snapshot %d model=%s: %s", snap["id"], model_name, e)
        _backfill_statuses[model_name]["done"] += 1

    _backfill_statuses[model_name]["running"] = False
    _backfill_statuses[model_name]["error"] = None
    logger.info("Backfill complete: %d snapshots model=%s", len(snapshots), model_name)


def get_backfill_status() -> dict:
    """Return per-model backfill status plus a rolled-up 'any running' flag."""
    running_any = any(s.get("running") for s in _backfill_statuses.values())
    done_total = sum(s.get("done", 0) for s in _backfill_statuses.values())
    total_total = sum(s.get("total", 0) for s in _backfill_statuses.values())
    errors = [s["error"] for s in _backfill_statuses.values() if s.get("error")]

    # Legacy single-model shape (used by older UI code)
    legacy: dict = {
        "running": running_any,
        "done": done_total,
        "total": total_total,
        "error": errors[0] if errors else None,
    }
    return {**legacy, "per_model": dict(_backfill_statuses)}


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


def trigger_backfill(model_names: list[str]) -> None:
    """Queue a backfill job for each of the given model names."""
    global _backfill_generation
    _backfill_generation += 1
    gen = _backfill_generation

    for model_name in model_names:
        _backfill_statuses[model_name] = {"running": False, "done": 0, "total": 0, "error": None}
        if _scheduler:
            _scheduler.add_job(
                backfill_job, trigger="date",
                id=f"backfill_{model_name}", replace_existing=True,
                kwargs={"model_name": model_name, "generation": gen},
            )


def trigger_discovery() -> None:
    if _scheduler:
        _scheduler.add_job(discovery_job, trigger="date", id="discovery_manual", replace_existing=True)


def trigger_export() -> None:
    if _scheduler:
        _scheduler.add_job(export_job, trigger="date", id="export_manual", replace_existing=True)


def stop() -> None:
    if _scheduler:
        _scheduler.shutdown(wait=False)
