import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(os.environ.get("DATA_DIR", "/data")) / "traffic.db"


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def get_db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with get_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS cameras (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                url       TEXT    NOT NULL UNIQUE,
                address   TEXT    NOT NULL,
                lat       REAL    NOT NULL,
                lon       REAL    NOT NULL,
                is_custom INTEGER NOT NULL DEFAULT 0,
                active    INTEGER NOT NULL DEFAULT 1,
                added_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                camera_id         INTEGER NOT NULL REFERENCES cameras(id),
                captured_at       TEXT    NOT NULL DEFAULT (datetime('now')),
                image_path        TEXT,
                person_count      INTEGER NOT NULL DEFAULT 0,
                bicycle_count     INTEGER NOT NULL DEFAULT 0,
                motorcycle_count  INTEGER NOT NULL DEFAULT 0,
                car_count         INTEGER NOT NULL DEFAULT 0,
                bus_count         INTEGER NOT NULL DEFAULT 0,
                truck_count       INTEGER NOT NULL DEFAULT 0,
                total_count       INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_snapshots_camera_time
                ON snapshots (camera_id, captured_at);
        """)


# ── cameras ──────────────────────────────────────────────────────────────────

def upsert_camera(url: str, address: str, lat: float, lon: float, is_custom: int = 0) -> int:
    with get_db() as db:
        db.execute("""
            INSERT INTO cameras (url, address, lat, lon, is_custom)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
                address   = excluded.address,
                lat       = excluded.lat,
                lon       = excluded.lon,
                active    = 1
        """, (url, address, lat, lon, is_custom))
        row = db.execute("SELECT id FROM cameras WHERE url = ?", (url,)).fetchone()
        return row["id"]


def get_cameras(active_only: bool = True) -> list[dict]:
    with get_db() as db:
        q = "SELECT * FROM cameras"
        if active_only:
            q += " WHERE active = 1"
        q += " ORDER BY address"
        return [dict(r) for r in db.execute(q).fetchall()]


def set_camera_active(camera_id: int, active: bool) -> None:
    with get_db() as db:
        db.execute("UPDATE cameras SET active = ? WHERE id = ?", (int(active), camera_id))


def delete_camera(camera_id: int) -> None:
    with get_db() as db:
        db.execute("DELETE FROM cameras WHERE id = ? AND is_custom = 1", (camera_id,))


def deactivate_missing_cameras(known_urls: list[str]) -> None:
    """Mark auto-discovered cameras not in known_urls as inactive."""
    with get_db() as db:
        placeholders = ",".join("?" * len(known_urls))
        db.execute(
            f"UPDATE cameras SET active = 0 WHERE is_custom = 0 AND url NOT IN ({placeholders})",
            known_urls,
        )


# ── snapshots ─────────────────────────────────────────────────────────────────

def insert_snapshot(
    camera_id: int,
    image_path: str | None,
    counts: dict,
    captured_at: str | None = None,
) -> int:
    total = sum(counts.get(k, 0) for k in
                ("person_count", "bicycle_count", "motorcycle_count",
                 "car_count", "bus_count", "truck_count"))
    with get_db() as db:
        cur = db.execute("""
            INSERT INTO snapshots
                (camera_id, captured_at, image_path, person_count, bicycle_count, motorcycle_count,
                 car_count, bus_count, truck_count, total_count)
            VALUES (?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            camera_id, captured_at, image_path,
            counts.get("person_count", 0),
            counts.get("bicycle_count", 0),
            counts.get("motorcycle_count", 0),
            counts.get("car_count", 0),
            counts.get("bus_count", 0),
            counts.get("truck_count", 0),
            total,
        ))
        return cur.lastrowid


def get_snapshots(camera_id: int | None = None, start: str | None = None,
                  end: str | None = None, limit: int = 1000) -> list[dict]:
    conditions, params = [], []
    if camera_id is not None:
        conditions.append("camera_id = ?")
        params.append(camera_id)
    if start:
        conditions.append("captured_at >= ?")
        params.append(start)
    if end:
        conditions.append("captured_at <= ?")
        params.append(end)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    with get_db() as db:
        rows = db.execute(
            f"SELECT * FROM snapshots {where} ORDER BY captured_at DESC LIMIT ?",
            params + [limit],
        ).fetchall()
        return [dict(r) for r in rows]


def get_stats(start: str | None = None, end: str | None = None) -> list[dict]:
    """Aggregate counts per camera for the given time window."""
    conditions, params = [], []
    if start:
        conditions.append("s.captured_at >= ?")
        params.append(start)
    if end:
        conditions.append("s.captured_at <= ?")
        params.append(end)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    with get_db() as db:
        rows = db.execute(f"""
            SELECT
                c.id, c.address, c.lat, c.lon, c.url,
                SUM(s.person_count)     AS person_count,
                SUM(s.bicycle_count)    AS bicycle_count,
                SUM(s.motorcycle_count) AS motorcycle_count,
                SUM(s.car_count)        AS car_count,
                SUM(s.bus_count)        AS bus_count,
                SUM(s.truck_count)      AS truck_count,
                SUM(s.total_count)      AS total_count,
                COUNT(s.id)             AS snapshot_count
            FROM cameras c
            LEFT JOIN snapshots s ON s.camera_id = c.id
            {where}
            GROUP BY c.id
            ORDER BY c.address
        """, params).fetchall()
        return [dict(r) for r in rows]


def get_hourly_aggregates(start: str | None = None, end: str | None = None) -> list[dict]:
    """Hourly bucket aggregates for static site export."""
    conditions, params = [], []
    if start:
        conditions.append("captured_at >= ?")
        params.append(start)
    if end:
        conditions.append("captured_at <= ?")
        params.append(end)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    with get_db() as db:
        rows = db.execute(f"""
            SELECT
                camera_id,
                strftime('%Y-%m-%dT%H:00:00', captured_at) AS hour,
                SUM(person_count)     AS person_count,
                SUM(bicycle_count)    AS bicycle_count,
                SUM(motorcycle_count) AS motorcycle_count,
                SUM(car_count)        AS car_count,
                SUM(bus_count)        AS bus_count,
                SUM(truck_count)      AS truck_count,
                SUM(total_count)      AS total_count
            FROM snapshots
            {where}
            GROUP BY camera_id, hour
            ORDER BY hour
        """, params).fetchall()
        return [dict(r) for r in rows]


def prune_images(camera_id: int, retention_count: int) -> list[str]:
    """Return image_path values for snapshots beyond retention_count for this camera."""
    with get_db() as db:
        rows = db.execute("""
            SELECT id, image_path FROM snapshots
            WHERE camera_id = ? AND image_path IS NOT NULL
            ORDER BY captured_at DESC
            LIMIT -1 OFFSET ?
        """, (camera_id, retention_count)).fetchall()
        ids = [r["id"] for r in rows]
        paths = [r["image_path"] for r in rows if r["image_path"]]
        if ids:
            db.execute(
                f"UPDATE snapshots SET image_path = NULL WHERE id IN ({','.join('?'*len(ids))})",
                ids,
            )
        return paths


def export_csv() -> str:
    """Return full CSV string of snapshots joined with cameras."""
    with get_db() as db:
        rows = db.execute("""
            SELECT
                s.captured_at, c.url AS camera_url, c.address, c.lat, c.lon,
                s.person_count, s.bicycle_count, s.motorcycle_count,
                s.car_count, s.bus_count, s.truck_count, s.total_count
            FROM snapshots s
            JOIN cameras c ON c.id = s.camera_id
            ORDER BY s.captured_at DESC
        """).fetchall()

    header = "timestamp,camera_url,address,lat,lon,person_count,bicycle_count,motorcycle_count,car_count,bus_count,truck_count,total_count\n"
    lines = [
        ",".join(str(v) for v in (
            r["captured_at"], r["camera_url"], f'"{r["address"]}"',
            r["lat"], r["lon"],
            r["person_count"], r["bicycle_count"], r["motorcycle_count"],
            r["car_count"], r["bus_count"], r["truck_count"], r["total_count"],
        ))
        for r in rows
    ]
    return header + "\n".join(lines)
