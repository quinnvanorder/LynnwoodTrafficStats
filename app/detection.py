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

import math

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


def _zone_polygon(zone, w: int, h: int) -> list[tuple]:
    """Convert a zone to pixel-space polygon corners.

    Accepts both old [x1,y1,x2,y2] lists and new {cx,cy,w,h,angle} dicts.
    """
    if isinstance(zone, dict):
        cx, cy = zone['cx'] * w, zone['cy'] * h
        hw, hh = zone['w'] * w / 2, zone['h'] * h / 2
        a = zone.get('angle', 0)
        cos_a, sin_a = math.cos(a), math.sin(a)
        return [
            (cx - hw * cos_a + hh * sin_a, cy - hw * sin_a - hh * cos_a),
            (cx + hw * cos_a + hh * sin_a, cy + hw * sin_a - hh * cos_a),
            (cx + hw * cos_a - hh * sin_a, cy + hw * sin_a + hh * cos_a),
            (cx - hw * cos_a - hh * sin_a, cy - hw * sin_a + hh * cos_a),
        ]
    x1, y1, x2, y2 = zone
    return [(x1*w, y1*h), (x2*w, y1*h), (x2*w, y2*h), (x1*w, y2*h)]


def apply_exclusion_zones(image: Image.Image, zones: list) -> Image.Image:
    """Black out zones before inference (supports axis-aligned and rotated rects)."""
    if not zones:
        return image
    from PIL import ImageDraw
    img = image.copy()
    draw = ImageDraw.Draw(img)
    w, h = img.size
    for zone in zones:
        draw.polygon(_zone_polygon(zone, w, h), fill=(0, 0, 0))
    return img


def draw_zone_overlay(image: Image.Image, zones: list) -> Image.Image:
    """Draw grey semi-opaque zone markers on an already-annotated image."""
    if not zones:
        return image
    from PIL import Image as PILImage, ImageDraw
    overlay = PILImage.new('RGBA', image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    w, h = image.size
    for zone in zones:
        draw.polygon(_zone_polygon(zone, w, h), fill=(120, 120, 120, 128))
    base = image.convert('RGBA')
    return PILImage.alpha_composite(base, overlay).convert('RGB')


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
