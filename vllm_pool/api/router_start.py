from __future__ import annotations
from fastapi import APIRouter, HTTPException, Form
from .models import StartRequest, StartResponse, LLMResourceConfigModel
from ..core.pool import PoolManager
from ..core.config import DEFAULT_CFG

router = APIRouter()

def bind(pool: PoolManager) -> APIRouter:
    @router.post("/start", response_model=StartResponse)
    def start_worker(req: StartRequest):
        cfg_model = req.config or LLMResourceConfigModel.model_validate(DEFAULT_CFG.to_vllm_kwargs())
        cfg = cfg_model.model_dump(exclude_none=True)
        try:
            model, gpu, pid = pool.start(req.model_name, cfg, req.gpu_id)
            return StartResponse(model_name=model, gpu_id=gpu, pid=pid, status="ready")
        except RuntimeError as e:
            raise HTTPException(status_code=409, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to start: {e}")

    @router.post("/stop")
    def stop(model_name: str = Form(...), gpu_id: int = Form(...)):
        try:
            st = pool.stop(model_name, gpu_id)
            return {"model_name": model_name, "gpu_id": gpu_id, "status": st}
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except RuntimeError as e:
            raise HTTPException(status_code=409, detail=str(e))

    return router
