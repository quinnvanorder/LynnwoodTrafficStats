import os

# Must be set before torch/ultralytics are ever imported.
# NNPACK_DISABLE=1 stops PyTorch from attempting (and warning about) NNPACK on
# hardware that doesn't support it (e.g. Synology NAS ARM/x86 without NNPACK).
# The config-dir vars redirect matplotlib, fontconfig, and ultralytics away from
# /home/appuser (which doesn't exist or isn't writable at runtime PUID).
os.environ.setdefault("NNPACK_DISABLE", "1")
os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib")
os.environ.setdefault("YOLO_CONFIG_DIR", "/tmp")
os.environ.setdefault("FC_CACHEDIR", "/tmp")

from pathlib import Path

import cv2
import numpy as np
from PIL import Image

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MODELS_DIR = DATA_DIR / "models"

# COCO class IDs we care about
WANTED_CLASSES = {
    0:  "person_count",
    1:  "bicycle_count",
    3:  "motorcycle_count",
    2:  "car_count",
    5:  "bus_count",
    7:  "truck_count",
}

_model = None


def _get_model(model_name: str = "yolov8n.pt"):
    global _model
    if _model is None:
        from ultralytics import YOLO
        import torch
        # Disable NNPACK before any inference. NNPACK_DISABLE=1 env var doesn't
        # suppress these warnings when PyTorch runs on background threads (the
        # C++ → Python warning bridge is bypassed). This API call disables the
        # NNPACK convolution path at the dispatcher level so it's never attempted.
        if hasattr(torch.backends, "nnpack"):
            torch.backends.nnpack.enabled = False
        model_path = MODELS_DIR / model_name
        if not model_path.exists():
            model_path = model_name
        _model = YOLO(str(model_path))
    return _model


def detect(
    image: Image.Image,
    model_name: str = "yolov8n.pt",
    confidence: float = 0.4,
) -> tuple[dict, Image.Image]:
    """Run detection on a PIL image. Returns (count dict, annotated image)."""
    model = _get_model(model_name)
    img_array = np.array(image)
    results = model(img_array, conf=confidence, verbose=False)

    counts = {v: 0 for v in WANTED_CLASSES.values()}
    for result in results:
        if result.boxes is None:
            continue
        for cls_id in result.boxes.cls.tolist():
            cls_id = int(cls_id)
            if cls_id in WANTED_CLASSES:
                counts[WANTED_CLASSES[cls_id]] += 1

    annotated_bgr = results[0].plot()
    annotated_img = Image.fromarray(cv2.cvtColor(annotated_bgr, cv2.COLOR_BGR2RGB))
    return counts, annotated_img
