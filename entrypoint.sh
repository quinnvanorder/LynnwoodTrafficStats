#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Use existing group if the GID is already taken, otherwise create one
if ! getent group "$PGID" > /dev/null 2>&1; then
    groupadd -g "$PGID" appuser
fi
GROUPNAME=$(getent group "$PGID" | cut -d: -f1)

# Use existing user if the UID is already taken, otherwise create one
if ! getent passwd "$PUID" > /dev/null 2>&1; then
    useradd -u "$PUID" -g "$PGID" -s /bin/sh -M appuser
fi
USERNAME=$(getent passwd "$PUID" | cut -d: -f1)

# Ensure volume directories exist with correct ownership
mkdir -p /config /data/models /data/images /data/static-export
chown -R "$USERNAME":"$GROUPNAME" /config /data

# Seed YOLOv8 weights into volume if not already present
if [ ! -f /data/models/yolov8n.pt ] && [ -f /app/weights/yolov8n.pt ]; then
    cp /app/weights/yolov8n.pt /data/models/yolov8n.pt
    chown "$USERNAME":"$GROUPNAME" /data/models/yolov8n.pt
fi

exec gosu "$USERNAME" "$@"
