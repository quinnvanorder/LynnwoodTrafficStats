FROM python:3.12-slim AS builder

WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Install playwright browsers
RUN pip install --no-cache-dir playwright && \
    playwright install chromium --with-deps

# Pre-download YOLOv8 nano weights — ultralytics caches to ~/.config/Ultralytics/
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')" && \
    find /root -name "yolov8n.pt" -exec cp {} /tmp/yolov8n.pt \; 2>/dev/null || true


FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    netcat-openbsd \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Copy playwright browsers from builder
COPY --from=builder /root/.cache/ms-playwright /root/.cache/ms-playwright

# Copy installed Python packages
COPY --from=builder /install /usr/local

# Install playwright browser deps
RUN pip install playwright && playwright install-deps chromium

WORKDIR /app
COPY . .

# Bundle weights inside the image (not under /data which is a volume)
COPY --from=builder /tmp/yolov8n.pt /app/weights/yolov8n.pt

RUN chmod +x /app/entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
