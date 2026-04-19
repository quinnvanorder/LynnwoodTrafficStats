from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Query

from .. import database

router = APIRouter(prefix="/api", tags=["snapshots"])

TIME_WINDOWS = {
    "5m":     timedelta(minutes=5),
    "10m":    timedelta(minutes=10),
    "30m":    timedelta(minutes=30),
    "1h":     timedelta(hours=1),
    "1d":     timedelta(days=1),
    "1w":     timedelta(weeks=1),
    "1m":     timedelta(days=30),
    "6m":     timedelta(days=182),
    "1y":     timedelta(days=365),
    "5y":     timedelta(days=365 * 5),
    "all":    None,
}


def _window_bounds(window: str) -> tuple[str | None, str | None]:
    delta = TIME_WINDOWS.get(window)
    now = datetime.now(timezone.utc)
    end = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    if delta is None:
        return None, None
    start = (now - delta).strftime("%Y-%m-%dT%H:%M:%SZ")
    return start, end


@router.get("/snapshots")
def get_snapshots(
    camera_id: int | None = Query(None),
    start: str | None = Query(None),
    end: str | None = Query(None),
    limit: int = Query(1000, le=10000),
):
    return database.get_snapshots(camera_id=camera_id, start=start, end=end, limit=limit)


@router.get("/stats")
def get_stats(window: str = Query("1d")):
    start, end = _window_bounds(window)
    return database.get_stats(start=start, end=end)


@router.get("/snapshots/animation")
def get_animation_frames(window: str = Query("1d"), n_frames: int = Query(720, le=2000)):
    """Return evenly-sampled snapshots for animation playback."""
    start, end = _window_bounds(window)
    all_snaps = database.get_snapshots(start=start, end=end, limit=100_000)

    if not all_snaps:
        return []

    # Sort ascending for animation order
    all_snaps.sort(key=lambda s: s["captured_at"])

    total = len(all_snaps)
    if total <= n_frames:
        return all_snaps

    step = total / n_frames
    return [all_snaps[int(i * step)] for i in range(n_frames)]
