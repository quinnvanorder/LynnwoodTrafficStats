import asyncio
import json
import logging
from typing import AsyncGenerator

logger = logging.getLogger(__name__)

_subscribers: list[asyncio.Queue] = []
_loop: asyncio.AbstractEventLoop | None = None


def set_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Called once at startup to capture the event loop for thread-safe broadcast."""
    global _loop
    _loop = loop


def broadcast(event_type: str, data: dict) -> None:
    """Called from sync scheduler threads — safely pushes to the event loop."""
    if not _subscribers or _loop is None:
        return
    payload = json.dumps({"type": event_type, "data": data})

    def _put():
        for q in list(_subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    _loop.call_soon_threadsafe(_put)


async def event_stream() -> AsyncGenerator[str, None]:
    q: asyncio.Queue = asyncio.Queue(maxsize=50)
    _subscribers.append(q)
    try:
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=30)
                yield f"data: {msg}\n\n"
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
    finally:
        if q in _subscribers:
            _subscribers.remove(q)
