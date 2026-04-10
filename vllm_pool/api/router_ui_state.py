from __future__ import annotations

from typing import Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core.ui_state_store import UIStateStore

router = APIRouter()


class UpdateSectionRequest(BaseModel):
    value: Any


def bind(store: UIStateStore) -> APIRouter:
    @router.get("/ui/state")
    def get_state():
        return store.get_all()

    @router.put("/ui/state/{section}")
    def set_state_section(section: str, req: UpdateSectionRequest):
        if section not in {"processor_presets", "prompt_bank", "sampling_bank"}:
            raise HTTPException(status_code=404, detail="unknown section")
        updated = store.set_section(section, req.value)
        return {"status": "ok", "state": updated}

    return router
