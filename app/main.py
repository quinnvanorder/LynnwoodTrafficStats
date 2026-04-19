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

    scheduler.start(
        snapshot_interval=cfg["snapshot_interval_seconds"],
        export_interval=cfg["static_export_interval_seconds"],
    )

    # Ensure the configured model is available (downloads in background if missing)
    model_manager.ensure_model_background(cfg["detection_model"])

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
