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

import cv2
import numpy as np
from PIL import Image

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
_model_name: str | None = None


def _get_model(model_name: str = "yolov8n.pt"):
    global _model, _model_name
    if _model is None or _model_name != model_name:
        from . import model_manager
        from ultralytics import YOLO
        import torch
        # Disable NNPACK at the dispatcher level — env var alone doesn't suppress
        # warnings when PyTorch runs in APScheduler background threads.
        if hasattr(torch.backends, "nnpack"):
            torch.backends.nnpack.enabled = False
        model_path = model_manager.find_model(model_name)
        if model_path is None:
            raise FileNotFoundError(
                f"Model '{model_name}' not found. "
                "Download it from Settings → Detection Model."
            )
        _model = YOLO(str(model_path))
        _model_name = model_name
    return _model


def apply_exclusion_zones(image: Image.Image, zones: list) -> Image.Image:
    """Black out rectangular zones before inference. Zones: [[x1,y1,x2,y2], ...] as 0.0–1.0 fractions."""
    if not zones:
        return image
    from PIL import ImageDraw
    img = image.copy()
    draw = ImageDraw.Draw(img)
    w, h = img.size
    for zone in zones:
        x1, y1, x2, y2 = zone
        draw.rectangle([x1 * w, y1 * h, x2 * w, y2 * h], fill=(0, 0, 0))
    return img


def detect(
    image: Image.Image,
    model_name: str = "yolov8n.pt",
    confidence: float = 0.4,
    imgsz: int = 640,
    exclusion_zones: list | None = None,
) -> tuple[dict, Image.Image]:
    """Run detection on a PIL image. Returns (count dict, annotated image)."""
    if exclusion_zones:
        image = apply_exclusion_zones(image, exclusion_zones)
    model = _get_model(model_name)
    img_array = np.array(image)
    results = model(img_array, conf=confidence, imgsz=imgsz, verbose=False)

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
