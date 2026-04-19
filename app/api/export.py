from fastapi import APIRouter, BackgroundTasks
from fastapi.responses import Response

from .. import database, scheduler

router = APIRouter(prefix="/api/export", tags=["export"])


@router.get("/csv")
def download_csv():
    csv_data = database.export_csv()
    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=lynnwood_traffic.csv"},
    )


@router.post("/static")
def trigger_static_export(background_tasks: BackgroundTasks):
    background_tasks.add_task(scheduler.trigger_export)
    return {"ok": True, "message": "Static export triggered"}
