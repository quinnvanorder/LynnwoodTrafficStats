from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from .. import database, scheduler

router = APIRouter(prefix="/api/cameras", tags=["cameras"])


class CameraCreate(BaseModel):
    url: str
    address: str
    lat: float
    lon: float


class CameraUpdate(BaseModel):
    active: bool | None = None
    address: str | None = None


@router.get("")
def list_cameras(active_only: bool = False):
    return database.get_cameras(active_only=active_only)


@router.post("", status_code=201)
def add_camera(body: CameraCreate):
    cam_id = database.upsert_camera(body.url, body.address, body.lat, body.lon, is_custom=1)
    return {"id": cam_id}


@router.patch("/{camera_id}")
def update_camera(camera_id: int, body: CameraUpdate):
    cams = database.get_cameras(active_only=False)
    cam = next((c for c in cams if c["id"] == camera_id), None)
    if not cam:
        raise HTTPException(404, "Camera not found")
    if body.active is not None:
        database.set_camera_active(camera_id, body.active)
    return {"ok": True}


@router.delete("/{camera_id}", status_code=204)
def delete_camera(camera_id: int):
    database.delete_camera(camera_id)


@router.post("/discover")
def trigger_discover(background_tasks: BackgroundTasks):
    background_tasks.add_task(scheduler.trigger_discovery)
    return {"ok": True, "message": "Discovery triggered"}
