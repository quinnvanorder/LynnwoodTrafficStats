FROM python:3.12-slim AS builder

WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Install playwright + chromium with deps (builder has full apt access)
RUN pip install --no-cache-dir playwright && \
    playwright install chromium --with-deps

# Pre-download YOLOv8 nano weights
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')" && \
    find /root -name "yolov8n.pt" -exec cp {} /tmp/yolov8n.pt \; 2>/dev/null || true


FROM python:3.12-slim

# Install chromium runtime deps manually — playwright install-deps uses Ubuntu package names
# that don't exist on Debian trixie. These are the correct Debian equivalents.
RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    netcat-openbsd \
    git \
    openssh-client \
    # Chromium runtime libraries (Debian trixie names, many have t64 suffix)
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

# Copy playwright browsers from builder
COPY --from=builder /root/.cache/ms-playwright /root/.cache/ms-playwright

# Copy installed Python packages (includes playwright + all requirements)
COPY --from=builder /install /usr/local

WORKDIR /app
COPY . .

# Bundle weights inside the image (not under /data which is a volume mount)
COPY --from=builder /tmp/yolov8n.pt /app/weights/yolov8n.pt

RUN chmod +x /app/entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
