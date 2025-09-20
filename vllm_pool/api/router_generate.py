from __future__ import annotations
import uuid
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from .models import GenerateSimpleRequest, GenerateChatRequest
from ..core.pool import PoolManager

router = APIRouter()


def bind(pool: PoolManager) -> APIRouter:
    @router.post("/generate/simple")
    def generate_simple(req: GenerateSimpleRequest):
        prompts = req.prompts if isinstance(req.prompts, list) else [req.prompts]
        job_id = str(uuid.uuid4())[:8]
        job = {
            "job_id": job_id,
            "model_name": req.model_name,
            "cmd": {"type": "generate_simple", "prompts": prompts, "sampling": req.sampling.model_dump()},
        }
        try:
            jid = pool.submit(job)
            return JSONResponse({"job_id": jid, "status": "queued"}, status_code=202)
        except RuntimeError as e:
            raise HTTPException(status_code=409, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to enqueue: {e}")

    @router.post("/generate/chat")
    def generate_chat(req: GenerateChatRequest):
        job_id = str(uuid.uuid4())[:8]
        prompts = [
            {"messages": [m.model_dump() for m in it.messages], "metadata": (it.metadata or {})}
            for it in req.prompts
        ]
        job = {
            "job_id": job_id,
            "model_name": req.model_name,
            "cmd": {
                "type": "generate_chat",
                "prompts": prompts,
                "sampling": req.sampling.model_dump(),
                "output_field": req.output_field,
            },
        }
        try:
            jid = pool.submit(job)
            return JSONResponse({"job_id": jid, "status": "queued"}, status_code=202)
        except RuntimeError as e:
            raise HTTPException(status_code=409, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to enqueue: {e}")

    @router.get("/jobs/{job_id}")
    def job_status(job_id: str):
        return pool.get_job(job_id)

    @router.delete("/jobs/{job_id}")
    def cancel_job(job_id: str):
        out = pool.cancel_job(job_id)
        if out.get("status") == "not_found":
            raise HTTPException(status_code=404, detail="job not found")
        return out

    return router
