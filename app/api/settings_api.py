from fastapi import APIRouter, HTTPException

from .. import exporter, scheduler, settings

router = APIRouter(prefix="/api/settings", tags=["settings"])


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

    # Reschedule jobs if intervals changed
    scheduler.reschedule(
        merged["snapshot_interval_seconds"],
        merged["static_export_interval_seconds"],
    )
    return merged


@router.post("/generate-key")
def generate_deploy_key():
    try:
        pub_key = exporter.generate_deploy_key()
        return {"public_key": pub_key}
    except Exception as e:
        raise HTTPException(500, f"Key generation failed: {e}")
