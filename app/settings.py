import json
import os
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("CONFIG_DIR", "/config")) / "settings.json"

DEFAULTS = {
    "snapshot_interval_seconds": 30,
    "image_retention_count": 1000,
    "static_export_interval_seconds": 600,
    "git_repo_url": "",
    "git_remote_branch": "main",
    "detection_model": "yolov8n.pt",
    "detection_confidence_threshold": 0.4,
    "detection_imgsz": 800,
    "model_active": {
        "yolov8n.pt": True,
        "yolov8s.pt": False,
        "yolov8m.pt": False,
        "yolov8l.pt": False,
        "yolo11n.pt": False,
        "yolo11s.pt": False,
        "yolo11m.pt": False,
        "yolo11l.pt": False,
        "rtdetr-l.pt": False,
        "rtdetr-x.pt": False,
    },
}


def load() -> dict:
    if CONFIG_PATH.exists():
        try:
            content = CONFIG_PATH.read_text().strip()
            if content:
                return {**DEFAULTS, **json.loads(content)}
        except (json.JSONDecodeError, OSError):
            pass
    return dict(DEFAULTS)


def save(settings: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    merged = {**DEFAULTS, **settings}
    with open(CONFIG_PATH, "w") as f:
        json.dump(merged, f, indent=2)


def get(key: str):
    return load().get(key, DEFAULTS.get(key))
