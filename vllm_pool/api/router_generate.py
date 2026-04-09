from __future__ import annotations
import uuid
from fastapi import APIRouter, HTTPException, Request
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
                "include_metadata": req.include_metadata,
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
    def generate_offline(req: OfflineJobRequest, request: Request):
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
            cmd = {
                "type": "generate_chat",
                "prompts": normalized,
                "sampling": sampling,
                "output_field": req.output_field,
                "include_metadata": req.include_metadata,
            }

        job = {
            "job_id": job_id,
            "model_name": req.model_name,
            "cmd": cmd,
            "cleanup_model_after_job": req.cleanup_model_after_job,
        }
        try:
            jid = pool.submit_offline(job)
            is_ui_request = request.headers.get("x-ui-request", "").strip() == "1"
            if is_ui_request:
                return JSONResponse({"job_id": jid, "status": "queued_offline"}, status_code=202)
            final = pool.wait_for_job(jid, timeout_sec=None)
            if final.get("status") == "done":
                return JSONResponse({"job_id": jid, "status": "done", "result": final.get("result")}, status_code=200)
            if final.get("status") == "error":
                return JSONResponse(
                    {"job_id": jid, "status": "error", "error": final.get("error", "unknown")},
                    status_code=500,
                )
            return JSONResponse({"job_id": jid, "status": final.get("status")}, status_code=202)
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
