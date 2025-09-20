from __future__ import annotations
import json
from typing import Generator
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from ..core.pool import PoolManager

router = APIRouter()

def bind(pool: PoolManager) -> APIRouter:
    @router.get("/events/worker/{key:path}")
    def sse_worker(key: str, request: Request):
        q = pool.subscribe_worker(key)

        def gen() -> Generator[bytes, None, None]:
            yield b"event: hello\ndata: {}\n\n"
            while True:
                if request.client is None:
                    break
                try:
                    ev = q.get(timeout=1.0) or {"lines": []}
                    payload = json.dumps(ev, ensure_ascii=False)
                    yield f"event: tail\ndata: {payload}\n\n".encode("utf-8")
                except Exception:
                    # comment line to keep the connection alive
                    yield b": keep-alive\n\n"
            yield b"event: bye\ndata: {}\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    return router
