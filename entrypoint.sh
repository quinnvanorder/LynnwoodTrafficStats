#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Create/update user and group to match requested IDs
if ! getent group appuser > /dev/null 2>&1; then
    groupadd -g "$PGID" appuser
else
    groupmod -g "$PGID" appuser
fi

if ! getent passwd appuser > /dev/null 2>&1; then
    useradd -u "$PUID" -g "$PGID" -s /bin/sh -M appuser
else
    usermod -u "$PUID" -g "$PGID" appuser
fi

# Ensure volume directories exist with correct ownership
mkdir -p /config /data/models /data/images /data/static-export
chown -R appuser:appuser /config /data

# Seed YOLOv8 weights into volume if not already present
if [ ! -f /data/models/yolov8n.pt ] && [ -f /app/weights/yolov8n.pt ]; then
    cp /app/weights/yolov8n.pt /data/models/yolov8n.pt
    chown appuser:appuser /data/models/yolov8n.pt
fi

exec su-exec appuser "$@"
