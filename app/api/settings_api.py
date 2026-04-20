import os
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

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


# ── Model status (download availability) ─────────────────────────────────────

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


# ── Model configs (active/default table) ─────────────────────────────────────

@router.get("/model-configs")
def get_model_configs():
    """Returns model_configs rows merged with live download status and avg processing time."""
    configs = {c["model_name"]: c for c in database.get_model_configs()}
    status = model_manager.get_model_status()
    avg_ms = database.get_avg_processing_ms()
    result = []
    for name in model_manager.ALL_MODELS:
        cfg = configs.get(name, {})
        s = status.get(name, {})
        result.append({
            "model_name": name,
            "is_active": cfg.get("is_active", 0),
            "is_default": cfg.get("is_default", 0),
            "downloaded_at": cfg.get("downloaded_at"),
            "ultralytics_version": cfg.get("ultralytics_version"),
            "available": s.get("available", False),
            "downloading": s.get("downloading", False),
            "error": s.get("error"),
            "avg_processing_ms": avg_ms.get(name),
        })
    return result


class ModelConfigUpdate(BaseModel):
    is_active: bool | None = None
    is_default: bool | None = None


@router.patch("/model-configs/{model_name:path}")
def update_model_config(model_name: str, body: ModelConfigUpdate):
    if model_name not in model_manager.ALL_MODELS:
        raise HTTPException(404, f"Unknown model: {model_name}")

    if body.is_default is True:
        if not model_manager.is_available(model_name):
            raise HTTPException(400, "Cannot set unavailable model as default — download it first")
        database.set_default_model(model_name)
        cfg = settings.load()
        cfg["detection_model"] = model_name
        settings.save(cfg)
        # Trigger backfill for new default if it has unprocessed snapshots
        scheduler.trigger_backfill([model_name])
        return {"ok": True, "model_name": model_name, "set_default": True}

    if body.is_active is not None:
        active = bool(body.is_active)
        # Cannot deactivate the default model
        default = database.get_default_model()
        if not active and model_name == default:
            raise HTTPException(400, "Cannot deactivate the default model")
        if active and not model_manager.is_available(model_name):
            raise HTTPException(400, "Cannot activate unavailable model — download it first")
        database.set_model_active(model_name, active)
        if active:
            # Backfill unprocessed snapshots for this newly active model
            scheduler.trigger_backfill([model_name])
        return {"ok": True, "model_name": model_name, "is_active": active}

    raise HTTPException(400, "No valid fields to update")


# ── Backfill status ───────────────────────────────────────────────────────────

@router.get("/backfill-status")
def backfill_status():
    return scheduler.get_backfill_status()


# ── Legacy switch-model endpoint (kept for compatibility) ─────────────────────

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

    database.set_default_model(model)
    current = settings.load()
    current["detection_model"] = model
    settings.save(current)

    # Clear all annotated images and re-run backfill for new default
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

    scheduler.trigger_backfill([model])
    return {"ok": True, "model": model, "cleared": len(stale_paths)}


# ── SSH deploy key ────────────────────────────────────────────────────────────

@router.post("/generate-key")
def generate_deploy_key():
    try:
        pub_key = exporter.generate_deploy_key()
        return {"public_key": pub_key}
    except Exception as e:
        raise HTTPException(500, f"Key generation failed: {e}")
