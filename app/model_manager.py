import logging
import os
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MODELS_DIR = DATA_DIR / "models"
WEIGHTS_DIR = Path("/app/weights")  # models bundled inside the Docker image

# All models the UI exposes
ALL_MODELS = [
    "yolov8n.pt",
    "yolov8s.pt",
    "yolov8m.pt",
    "yolov8l.pt",
    "yolo11n.pt",
    "yolo11s.pt",
    "yolo11m.pt",
    "yolo11l.pt",
    "rtdetr-l.pt",
    "rtdetr-x.pt",
]

# Per-model download state: {name: {"running": bool, "error": str|None}}
_download_status: dict = {}
_download_lock = threading.Lock()


def find_model(model_name: str) -> Path | None:
    """Return path to model weights, checking runtime models dir then bundled weights."""
    for directory in [MODELS_DIR, WEIGHTS_DIR]:
        p = directory / model_name
        if p.exists():
            return p
    return None


def is_available(model_name: str) -> bool:
    return find_model(model_name) is not None


def get_model_status() -> dict:
    status = {}
    for name in ALL_MODELS:
        dl = _download_status.get(name, {})
        status[name] = {
            "available": is_available(name),
            "downloading": dl.get("running", False),
            "error": dl.get("error"),
        }
    return status


def download_model(model_name: str) -> Path:
    """Download model weights to MODELS_DIR. Returns path on success, raises on failure."""
    model_path = MODELS_DIR / model_name
    if model_path.exists():
        return model_path

    if model_name not in ALL_MODELS:
        raise ValueError(f"Unknown model '{model_name}'")

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = model_path.with_suffix(".downloading")
    tmp.unlink(missing_ok=True)

    try:
        from ultralytics import __version__ as _yv
        url = f"https://github.com/ultralytics/assets/releases/download/v{_yv}/{model_name}"
        logger.info("Downloading %s from %s", model_name, url)

        try:
            from ultralytics.utils.downloads import safe_download
            safe_download(url, file=tmp)
        except (ImportError, TypeError):
            import requests
            with requests.get(url, stream=True, timeout=600, allow_redirects=True) as r:
                r.raise_for_status()
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(65536):
                        f.write(chunk)

        if not tmp.exists() or tmp.stat().st_size < 1024:
            raise RuntimeError("Download produced empty file")
        tmp.rename(model_path)
        logger.info("Model %s ready (%.1f MB)", model_name, model_path.stat().st_size / 1e6)
        return model_path
    except Exception as e:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"Download failed for '{model_name}': {e}") from e


def download_model_async(model_name: str) -> None:
    """Start a background download. Check get_model_status() to track progress."""
    with _download_lock:
        if _download_status.get(model_name, {}).get("running"):
            return
        _download_status[model_name] = {"running": True, "error": None}

    def _run():
        try:
            download_model(model_name)
            _download_status[model_name] = {"running": False, "error": None}
        except Exception as e:
            _download_status[model_name] = {"running": False, "error": str(e)}
            logger.error("Async download failed for %s: %s", model_name, e)

    threading.Thread(target=_run, name=f"dl-{model_name}", daemon=True).start()


def ensure_model_background(model_name: str) -> None:
    """Ensure model is available; download in background if missing."""
    if not is_available(model_name):
        logger.info("Model %s not found — attempting background download", model_name)
        download_model_async(model_name)
    else:
        logger.info("Model %s already available at %s", model_name, find_model(model_name))
