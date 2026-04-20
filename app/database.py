import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(os.environ.get("DATA_DIR", "/data")) / "traffic.db"

ALL_MODEL_NAMES = [
    "yolov8n.pt", "yolov8s.pt", "yolov8m.pt", "yolov8l.pt",
    "yolo11n.pt", "yolo11s.pt", "yolo11m.pt", "yolo11l.pt",
    "rtdetr-l.pt", "rtdetr-x.pt",
]


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
                annotated_path    TEXT,
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

            CREATE TABLE IF NOT EXISTS model_configs (
                model_name          TEXT PRIMARY KEY,
                is_active           INTEGER NOT NULL DEFAULT 0,
                is_default          INTEGER NOT NULL DEFAULT 0,
                downloaded_at       TEXT,
                ultralytics_version TEXT
            );

            CREATE TABLE IF NOT EXISTS model_counts (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id       INTEGER NOT NULL REFERENCES snapshots(id),
                model_name        TEXT    NOT NULL,
                annotated_path    TEXT,
                person_count      INTEGER NOT NULL DEFAULT 0,
                bicycle_count     INTEGER NOT NULL DEFAULT 0,
                motorcycle_count  INTEGER NOT NULL DEFAULT 0,
                car_count         INTEGER NOT NULL DEFAULT 0,
                bus_count         INTEGER NOT NULL DEFAULT 0,
                truck_count       INTEGER NOT NULL DEFAULT 0,
                total_count       INTEGER NOT NULL DEFAULT 0,
                processed_at      TEXT    NOT NULL DEFAULT (datetime('now')),
                UNIQUE(snapshot_id, model_name)
            );

            CREATE INDEX IF NOT EXISTS idx_model_counts_snap
                ON model_counts (snapshot_id, model_name);
        """)

        # Schema migrations
        for stmt in [
            "ALTER TABLE snapshots ADD COLUMN annotated_path TEXT",
            "ALTER TABLE cameras ADD COLUMN exclusion_zones TEXT",
        ]:
            try:
                db.execute(stmt)
            except Exception:
                pass

        # Populate model_configs with all known models (no-op if already present)
        for name in ALL_MODEL_NAMES:
            db.execute(
                "INSERT OR IGNORE INTO model_configs (model_name) VALUES (?)", (name,)
            )


# ── model_configs ─────────────────────────────────────────────────────────────

def get_model_configs() -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM model_configs ORDER BY model_name"
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_model_config(model_name: str, **kwargs) -> None:
    """Update one or more fields in model_configs for the given model."""
    if not kwargs:
        return
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values()) + [model_name]
    with get_db() as db:
        db.execute(f"UPDATE model_configs SET {sets} WHERE model_name = ?", vals)


def set_model_active(model_name: str, active: bool) -> None:
    with get_db() as db:
        db.execute(
            "UPDATE model_configs SET is_active = ? WHERE model_name = ?",
            (int(active), model_name),
        )


def set_default_model(model_name: str) -> None:
    """Set exactly one model as default; clear others."""
    with get_db() as db:
        db.execute("UPDATE model_configs SET is_default = 0")
        db.execute(
            "UPDATE model_configs SET is_default = 1, is_active = 1 WHERE model_name = ?",
            (model_name,),
        )


def get_active_models() -> list[str]:
    with get_db() as db:
        rows = db.execute(
            "SELECT model_name FROM model_configs WHERE is_active = 1 ORDER BY model_name"
        ).fetchall()
        return [r["model_name"] for r in rows]


def get_default_model() -> str | None:
    with get_db() as db:
        row = db.execute(
            "SELECT model_name FROM model_configs WHERE is_default = 1 LIMIT 1"
        ).fetchone()
        return row["model_name"] if row else None


# ── model_counts ──────────────────────────────────────────────────────────────

def insert_model_count(
    snapshot_id: int,
    model_name: str,
    counts: dict,
    annotated_path: str | None = None,
) -> None:
    total = sum(counts.get(k, 0) for k in
                ("person_count", "bicycle_count", "motorcycle_count",
                 "car_count", "bus_count", "truck_count"))
    with get_db() as db:
        db.execute("""
            INSERT OR IGNORE INTO model_counts
                (snapshot_id, model_name, annotated_path,
                 person_count, bicycle_count, motorcycle_count,
                 car_count, bus_count, truck_count, total_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            snapshot_id, model_name, annotated_path,
            counts.get("person_count", 0), counts.get("bicycle_count", 0),
            counts.get("motorcycle_count", 0), counts.get("car_count", 0),
            counts.get("bus_count", 0), counts.get("truck_count", 0),
            total,
        ))


def get_snapshots_without_model(model_name: str) -> list[dict]:
    """Snapshots with an image_path that haven't been processed by model_name yet."""
    with get_db() as db:
        rows = db.execute("""
            SELECT s.id, s.camera_id, s.image_path, s.captured_at
            FROM snapshots s
            WHERE s.image_path IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM model_counts mc
                  WHERE mc.snapshot_id = s.id AND mc.model_name = ?
              )
            ORDER BY s.captured_at
        """, (model_name,)).fetchall()
        return [dict(r) for r in rows]


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


def get_camera_zones(camera_id: int) -> list:
    import json
    with get_db() as db:
        row = db.execute("SELECT exclusion_zones FROM cameras WHERE id = ?", (camera_id,)).fetchone()
        if row and row["exclusion_zones"]:
            return json.loads(row["exclusion_zones"])
        return []


def set_camera_zones(camera_id: int, zones: list) -> None:
    import json
    with get_db() as db:
        db.execute("UPDATE cameras SET exclusion_zones = ? WHERE id = ?",
                   (json.dumps(zones), camera_id))


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
    annotated_path: str | None = None,
) -> int:
    total = sum(counts.get(k, 0) for k in
                ("person_count", "bicycle_count", "motorcycle_count",
                 "car_count", "bus_count", "truck_count"))
    with get_db() as db:
        cur = db.execute("""
            INSERT INTO snapshots
                (camera_id, captured_at, image_path, annotated_path,
                 person_count, bicycle_count, motorcycle_count,
                 car_count, bus_count, truck_count, total_count)
            VALUES (?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            camera_id, captured_at, image_path, annotated_path,
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


def get_stats(start: str | None = None, end: str | None = None,
              model_name: str | None = None) -> list[dict]:
    """Aggregate counts per camera for the given time window.

    Uses model_counts for the specified model if available, falling back
    to snapshots columns for rows not yet processed by that model.
    """
    if model_name is None:
        model_name = get_default_model()

    join_cond = "s.camera_id = c.id"
    params: list = []
    if start:
        join_cond += " AND s.captured_at >= ?"
        params.append(start)
    if end:
        join_cond += " AND s.captured_at <= ?"
        params.append(end)

    # If we have a default model, use model_counts with fallback to snapshot columns.
    # COALESCE(mc.col, s.col) means: use model_counts if the row exists, else snapshots.
    if model_name:
        params.append(model_name)
        count_cols = """
            COALESCE(SUM(COALESCE(mc.person_count,     s.person_count)),     0) AS person_count,
            COALESCE(SUM(COALESCE(mc.bicycle_count,    s.bicycle_count)),    0) AS bicycle_count,
            COALESCE(SUM(COALESCE(mc.motorcycle_count, s.motorcycle_count)), 0) AS motorcycle_count,
            COALESCE(SUM(COALESCE(mc.car_count,        s.car_count)),        0) AS car_count,
            COALESCE(SUM(COALESCE(mc.bus_count,        s.bus_count)),        0) AS bus_count,
            COALESCE(SUM(COALESCE(mc.truck_count,      s.truck_count)),      0) AS truck_count,
            COALESCE(SUM(COALESCE(mc.total_count,      s.total_count)),      0) AS total_count,
            COUNT(s.id) AS snapshot_count
        """
        model_join = "LEFT JOIN model_counts mc ON mc.snapshot_id = s.id AND mc.model_name = ?"
    else:
        count_cols = """
            COALESCE(SUM(s.person_count),     0) AS person_count,
            COALESCE(SUM(s.bicycle_count),    0) AS bicycle_count,
            COALESCE(SUM(s.motorcycle_count), 0) AS motorcycle_count,
            COALESCE(SUM(s.car_count),        0) AS car_count,
            COALESCE(SUM(s.bus_count),        0) AS bus_count,
            COALESCE(SUM(s.truck_count),      0) AS truck_count,
            COALESCE(SUM(s.total_count),      0) AS total_count,
            COUNT(s.id) AS snapshot_count
        """
        model_join = ""

    with get_db() as db:
        rows = db.execute(f"""
            SELECT c.id, c.address, c.lat, c.lon, c.url,
                   {count_cols}
            FROM cameras c
            LEFT JOIN snapshots s ON {join_cond}
            {model_join}
            GROUP BY c.id
            ORDER BY c.address
        """, params).fetchall()
        return [dict(r) for r in rows]


def get_hourly_aggregates(start: str | None = None, end: str | None = None,
                          model_name: str | None = None) -> list[dict]:
    """Hourly bucket aggregates for static site export."""
    if model_name is None:
        model_name = get_default_model()

    conditions, params = [], []
    if start:
        conditions.append("s.captured_at >= ?")
        params.append(start)
    if end:
        conditions.append("s.captured_at <= ?")
        params.append(end)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    if model_name:
        params.append(model_name)
        model_join = "LEFT JOIN model_counts mc ON mc.snapshot_id = s.id AND mc.model_name = ?"
        count_cols = """
            SUM(COALESCE(mc.person_count,     s.person_count))     AS person_count,
            SUM(COALESCE(mc.bicycle_count,    s.bicycle_count))    AS bicycle_count,
            SUM(COALESCE(mc.motorcycle_count, s.motorcycle_count)) AS motorcycle_count,
            SUM(COALESCE(mc.car_count,        s.car_count))        AS car_count,
            SUM(COALESCE(mc.bus_count,        s.bus_count))        AS bus_count,
            SUM(COALESCE(mc.truck_count,      s.truck_count))      AS truck_count,
            SUM(COALESCE(mc.total_count,      s.total_count))      AS total_count
        """
    else:
        model_join = ""
        count_cols = """
            SUM(s.person_count)     AS person_count,
            SUM(s.bicycle_count)    AS bicycle_count,
            SUM(s.motorcycle_count) AS motorcycle_count,
            SUM(s.car_count)        AS car_count,
            SUM(s.bus_count)        AS bus_count,
            SUM(s.truck_count)      AS truck_count,
            SUM(s.total_count)      AS total_count
        """

    with get_db() as db:
        rows = db.execute(f"""
            SELECT
                s.camera_id,
                strftime('%Y-%m-%dT%H:00:00', s.captured_at) AS hour,
                {count_cols}
            FROM snapshots s
            {model_join}
            {where}
            GROUP BY s.camera_id, hour
            ORDER BY hour
        """, params).fetchall()
        return [dict(r) for r in rows]


def prune_images(camera_id: int, retention_count: int) -> list[str]:
    """Return all image/annotated paths for snapshots beyond retention_count for this camera."""
    with get_db() as db:
        rows = db.execute("""
            SELECT id, image_path, annotated_path FROM snapshots
            WHERE camera_id = ? AND image_path IS NOT NULL
            ORDER BY captured_at DESC
            LIMIT -1 OFFSET ?
        """, (camera_id, retention_count)).fetchall()
        ids = [r["id"] for r in rows]
        paths = []
        for r in rows:
            if r["image_path"]:
                paths.append(r["image_path"])
            if r["annotated_path"]:
                paths.append(r["annotated_path"])

        if ids:
            # Also collect model_counts annotated paths for these snapshots
            ph = ",".join("?" * len(ids))
            mc_rows = db.execute(
                f"SELECT annotated_path FROM model_counts WHERE snapshot_id IN ({ph}) AND annotated_path IS NOT NULL",
                ids,
            ).fetchall()
            paths.extend(r["annotated_path"] for r in mc_rows)
            db.execute(f"DELETE FROM model_counts WHERE snapshot_id IN ({ph})", ids)
            db.execute(
                f"UPDATE snapshots SET image_path = NULL, annotated_path = NULL"
                f" WHERE id IN ({ph})",
                ids,
            )
        return paths


def get_snapshots_for_backfill(camera_id: int | None = None) -> list[dict]:
    """All snapshots with an image_path, for backfill reprocessing."""
    conditions = ["image_path IS NOT NULL"]
    params: list = []
    if camera_id is not None:
        conditions.append("camera_id = ?")
        params.append(camera_id)
    where = "WHERE " + " AND ".join(conditions)
    with get_db() as db:
        rows = db.execute(
            f"SELECT id, camera_id, image_path, captured_at FROM snapshots {where} ORDER BY captured_at",
            params,
        ).fetchall()
        return [dict(r) for r in rows]


def update_snapshot_analysis(snap_id: int, counts: dict, annotated_path: str | None) -> None:
    total = sum(counts.get(k, 0) for k in
                ("person_count", "bicycle_count", "motorcycle_count",
                 "car_count", "bus_count", "truck_count"))
    with get_db() as db:
        db.execute("""
            UPDATE snapshots SET
                annotated_path   = ?,
                person_count     = ?,
                bicycle_count    = ?,
                motorcycle_count = ?,
                car_count        = ?,
                bus_count        = ?,
                truck_count      = ?,
                total_count      = ?
            WHERE id = ?
        """, (
            annotated_path,
            counts.get("person_count", 0), counts.get("bicycle_count", 0),
            counts.get("motorcycle_count", 0), counts.get("car_count", 0),
            counts.get("bus_count", 0), counts.get("truck_count", 0),
            total, snap_id,
        ))


def clear_annotated_paths() -> list[str]:
    """Null all annotated_path values and return paths for file deletion."""
    with get_db() as db:
        rows = db.execute(
            "SELECT annotated_path FROM snapshots WHERE annotated_path IS NOT NULL"
        ).fetchall()
        mc_rows = db.execute(
            "SELECT annotated_path FROM model_counts WHERE annotated_path IS NOT NULL"
        ).fetchall()
        paths = [r["annotated_path"] for r in rows] + [r["annotated_path"] for r in mc_rows]
        db.execute("UPDATE snapshots SET annotated_path = NULL")
        db.execute("UPDATE model_counts SET annotated_path = NULL")
        return paths


def export_csv() -> str:
    """Return full CSV string of snapshots joined with cameras, using default model counts."""
    default = get_default_model()
    if default:
        with get_db() as db:
            rows = db.execute("""
                SELECT
                    s.captured_at, c.url AS camera_url, c.address, c.lat, c.lon,
                    COALESCE(mc.person_count,     s.person_count)     AS person_count,
                    COALESCE(mc.bicycle_count,    s.bicycle_count)    AS bicycle_count,
                    COALESCE(mc.motorcycle_count, s.motorcycle_count) AS motorcycle_count,
                    COALESCE(mc.car_count,        s.car_count)        AS car_count,
                    COALESCE(mc.bus_count,        s.bus_count)        AS bus_count,
                    COALESCE(mc.truck_count,      s.truck_count)      AS truck_count,
                    COALESCE(mc.total_count,      s.total_count)      AS total_count
                FROM snapshots s
                JOIN cameras c ON c.id = s.camera_id
                LEFT JOIN model_counts mc ON mc.snapshot_id = s.id AND mc.model_name = ?
                ORDER BY s.captured_at DESC
            """, (default,)).fetchall()
    else:
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
