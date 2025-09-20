from __future__ import annotations
from fastapi import APIRouter
from ..core.pool import PoolManager

router = APIRouter()

def bind(pool: PoolManager) -> APIRouter:
    @router.get("/status")
    def status():
        return pool.status()

    @router.get("/models")
    def models():
        return {"models": pool.list_models()}

    @router.get("/workers")
    def workers():
        return {"workers": pool.list_workers()}

    return router
