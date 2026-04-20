import asyncio
import logging
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import database, model_manager, scheduler, settings
from .api import cameras, events, export
from .api import settings_api
from .api import snapshots as snapshots_api

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    cfg = settings.load()
    settings.save(cfg)  # write defaults if missing

    from . import sse
    sse.set_loop(asyncio.get_event_loop())

    # Sync model_configs with available models; set default if not already set
    configured_model = cfg["detection_model"]
    default_model = database.get_default_model()
    if default_model is None:
        # Fresh DB — bootstrap active/default state from settings.json
        database.set_default_model(configured_model)
        for model_name, active in cfg.get("model_active", {}).items():
            if active and model_name != configured_model:
                database.set_model_active(model_name, True)
        logger.info("Initialized model active states from settings.json")

    # Sync camera zones from settings.json → DB (settings.json is authoritative)
    for cam_id_str, zones in cfg.get("camera_zones", {}).items():
        try:
            database.set_camera_zones(int(cam_id_str), zones)
        except Exception:
            pass

    # Check for version updates on bundled models and mark available ones in DB
    threading.Thread(target=model_manager.sync_model_configs, daemon=True).start()

    # Ensure the configured model is available (downloads in background if missing)
    model_manager.ensure_model_background(configured_model)

    scheduler.start(
        snapshot_interval=cfg["snapshot_interval_seconds"],
        export_interval=cfg["static_export_interval_seconds"],
    )

    # Run initial discovery in a background thread if no cameras exist
    cameras_list = database.get_cameras(active_only=False)
    if not cameras_list:
        logger.info("No cameras in DB — starting initial discovery")
        threading.Thread(target=scheduler.discovery_job, daemon=True).start()

    yield

    scheduler.stop()


app = FastAPI(title="LynnwoodTrafficStats", lifespan=lifespan)

app.include_router(cameras.router)
app.include_router(snapshots_api.router)
app.include_router(settings_api.router)
app.include_router(events.router)
app.include_router(export.router)

# Serve camera snapshot images
_images_dir = Path(os.environ.get("DATA_DIR", "/data")) / "images"
_images_dir.mkdir(parents=True, exist_ok=True)
app.mount("/data/images", StaticFiles(directory=str(_images_dir)), name="snapshots")

# Serve static files last so API routes take priority
static_dir = Path(__file__).parent / "static"
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
