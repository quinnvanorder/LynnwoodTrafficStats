from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from .. import sse

router = APIRouter(prefix="/api", tags=["events"])


@router.get("/events")
async def stream_events():
    return StreamingResponse(
        sse.event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
