FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_WARN_SCRIPT_LOCATION=1 \
    PIP_ROOT_USER_ACTION=ignore

# libgl1 is required by opencv-python (pulled in by ultralytics) for cv2 to import
RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0t64 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Install playwright (browser download happens in runtime stage)
RUN pip install --no-cache-dir playwright

# Pre-download ALL model weights into the image so the NAS doesn't need internet at runtime.
# Ultralytics saves to WORKDIR (/build/) when the model file doesn't exist there.
RUN PYTHONPATH=/install/lib/python3.12/site-packages python -c "from ultralytics import YOLO; [YOLO(m) for m in ['yolov8n.pt','yolov8s.pt','yolov8m.pt','yolov8l.pt','yolo11n.pt','yolo11s.pt','yolo11m.pt','yolo11l.pt','rtdetr-l.pt','rtdetr-x.pt']]"


FROM python:3.12-slim

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_WARN_SCRIPT_LOCATION=1 \
    PIP_ROOT_USER_ACTION=ignore \
    NNPACK_DISABLE=1 \
    PYTORCH_NO_CUDA_MEMORY_CACHING=1 \
    MPLCONFIGDIR=/tmp/matplotlib \
    YOLO_CONFIG_DIR=/tmp \
    FC_CACHEDIR=/tmp \
    FONTCONFIG_PATH=/etc/fonts

RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    netcat-openbsd \
    git \
    openssh-client \
    ffmpeg \
    libgl1 \
    libglib2.0-0t64 \
    libnss3 \
    libnspr4 \
    libatk1.0-0t64 \
    libatk-bridge2.0-0t64 \
    libcups2t64 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2t64 \
    libpango-1.0-0 \
    libcairo2 \
    libx11-6 \
    libxcb1 \
    libxext6 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages
COPY --from=builder /install /usr/local

# Install chromium browser — system deps already installed above
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN playwright install chromium && chmod -R a+rX /ms-playwright

WORKDIR /app
COPY . .

# Bundle ALL model weights inside the image (not under /data which is a volume mount)
RUN mkdir -p /app/weights
COPY --from=builder /build/yolov8n.pt  /app/weights/yolov8n.pt
COPY --from=builder /build/yolov8s.pt  /app/weights/yolov8s.pt
COPY --from=builder /build/yolov8m.pt  /app/weights/yolov8m.pt
COPY --from=builder /build/yolov8l.pt  /app/weights/yolov8l.pt
COPY --from=builder /build/yolo11n.pt  /app/weights/yolo11n.pt
COPY --from=builder /build/yolo11s.pt  /app/weights/yolo11s.pt
COPY --from=builder /build/yolo11m.pt  /app/weights/yolo11m.pt
COPY --from=builder /build/yolo11l.pt  /app/weights/yolo11l.pt
COPY --from=builder /build/rtdetr-l.pt /app/weights/rtdetr-l.pt
COPY --from=builder /build/rtdetr-x.pt /app/weights/rtdetr-x.pt

RUN chmod +x /app/entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
