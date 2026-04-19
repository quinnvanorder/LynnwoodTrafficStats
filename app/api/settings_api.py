import os
import shutil
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException

from .. import database, exporter, model_manager, scheduler, settings

router = APIRouter(prefix="/api/settings", tags=["settings"])

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
IMAGES_DIR = DATA_DIR / "images"


@router.get("")
def get_settings():
    return settings.load()


@router.put("")
def update_settings(body: dict):
    allowed_keys = set(settings.DEFAULTS.keys())
    filtered = {k: v for k, v in body.items() if k in allowed_keys}
    if not filtered:
        raise HTTPException(400, "No valid settings fields provided")

    current = settings.load()
    merged = {**current, **filtered}
    settings.save(merged)

    scheduler.reschedule(
        merged["snapshot_interval_seconds"],
        merged["static_export_interval_seconds"],
    )
    return merged


@router.get("/model-status")
def get_model_status():
    return model_manager.get_model_status()


@router.post("/download-model")
def download_model(body: dict):
    model = body.get("model", "").strip()
    if not model:
        raise HTTPException(400, "model field required")
    if model not in model_manager.ALL_MODELS:
        raise HTTPException(400, f"Unknown model: {model}")
    if model_manager.is_available(model):
        return {"ok": True, "already_available": True}
    model_manager.download_model_async(model)
    return {"ok": True, "already_available": False}


@router.post("/switch-model")
def switch_model(body: dict):
    model = body.get("model", "").strip()
    if not model:
        raise HTTPException(400, "model field required")

    if not model_manager.is_available(model):
        raise HTTPException(
            400,
            f"Model '{model}' is not downloaded yet. "
            "Download it first using the Download button.",
        )

    current = settings.load()
    current["detection_model"] = model
    settings.save(current)

    # Clear annotated images from DB and disk
    stale_paths = database.clear_annotated_paths()
    for rel_path in stale_paths:
        try:
            (DATA_DIR / rel_path).unlink(missing_ok=True)
        except Exception:
            pass
    if IMAGES_DIR.exists():
        for cam_dir in IMAGES_DIR.iterdir():
            ann = cam_dir / "annotated"
            if ann.is_dir():
                shutil.rmtree(ann, ignore_errors=True)

    scheduler.trigger_backfill(model)
    return {"ok": True, "model": model, "cleared": len(stale_paths)}


@router.get("/backfill-status")
def backfill_status():
    return scheduler.get_backfill_status()


@router.post("/generate-key")
def generate_deploy_key():
    try:
        pub_key = exporter.generate_deploy_key()
        return {"public_key": pub_key}
    except Exception as e:
        raise HTTPException(500, f"Key generation failed: {e}")
