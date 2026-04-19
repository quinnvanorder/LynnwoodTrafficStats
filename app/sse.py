import asyncio
import json
from typing import AsyncGenerator

_subscribers: list[asyncio.Queue] = []


def broadcast(event_type: str, data: dict) -> None:
    """Called from sync scheduler threads — push to all SSE subscribers."""
    payload = json.dumps({"type": event_type, "data": data})
    for q in list(_subscribers):
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            pass


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
        _subscribers.remove(q)
