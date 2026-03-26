from __future__ import annotations
import uuid
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from .models import GenerateSimpleRequest, GenerateChatRequest, OfflineJobRequest, SamplingConfigModel
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

    @router.post("/generate/offline")
    def generate_offline(req: OfflineJobRequest):
        job_id = str(uuid.uuid4())[:8]
        sampling = (req.sampling or SamplingConfigModel()).model_dump()
        kind = req.type.strip().lower()
        if kind not in {"generate", "chat"}:
            raise HTTPException(status_code=422, detail="type must be 'generate' or 'chat'")

        if kind == "generate":
            if not all(isinstance(p, str) for p in req.prompts):
                raise HTTPException(status_code=422, detail="generate prompts must be an array of strings")
            cmd = {"type": "generate_simple", "prompts": req.prompts, "sampling": sampling}
        else:
            normalized = []
            for item in req.prompts:
                if not isinstance(item, dict) or "messages" not in item:
                    raise HTTPException(status_code=422, detail="chat prompts must be an array of {messages, metadata?}")
                messages = item.get("messages")
                if not isinstance(messages, list):
                    raise HTTPException(status_code=422, detail="chat.messages must be a list")
                for m in messages:
                    if not isinstance(m, dict) or "role" not in m or "content" not in m:
                        raise HTTPException(status_code=422, detail="each chat message must include role and content")
                normalized.append({"messages": messages, "metadata": item.get("metadata", {})})
            cmd = {"type": "generate_chat", "prompts": normalized, "sampling": sampling, "output_field": req.output_field}

        job = {
            "job_id": job_id,
            "model_name": req.model_name,
            "cmd": cmd,
            "cleanup_model_after_job": req.cleanup_model_after_job,
        }
        try:
            jid = pool.submit_offline(job)
            return JSONResponse({"job_id": jid, "status": "queued_offline"}, status_code=202)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to enqueue offline job: {e}")

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
