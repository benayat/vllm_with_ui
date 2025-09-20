Here’s a clean, OOD-friendly project split. I’ll show the **structure first**, then start implementing the core (server runs end-to-end; UI is included).

---

# Project structure

```
vllm_pool/
├── pyproject.toml
├── README.md
├── .env.example
├── vllm_pool/
│   ├── __init__.py
│   ├── main.py                  # FastAPI app factory + router mount + Uvicorn entry
│   │
│   ├── api/                     # Request/response layer (Pydantic + routers)
│   │   ├── __init__.py
│   │   ├── models.py            # Pydantic schemas (StartRequest, Generate*, etc.)
│   │   ├── router_start.py      # /start, /stop
│   │   ├── router_status.py     # /status, /models, /workers
│   │   ├── router_generate.py   # /generate/simple, /generate/chat
│   │   └── router_events.py     # /events/worker/{key:path}  (per-GPU SSE tails)
│   │
│   ├── core/                    # Domain/services (no FastAPI details)
│   │   ├── __init__.py
│   │   ├── config.py            # DEFAULT_CFG, types
│   │   ├── llm_client.py        # LLMClient interface + vLLM implementation
│   │   ├── worker.py            # WorkerProcess: spawn, tail capture, command loop
│   │   ├── pool.py              # PoolManager: lifecycle, queues, SSE subscriptions
│   │   └── types.py             # Dataclasses for resource/sampling configs (domain)
│   │
│   ├── ui/                      # Presentation (templates + static assets)
│   │   ├── __init__.py
│   │   ├── templates/
│   │   │   └── index.html       # The UI (layout you requested)
│   │   └── static/
│   │       └── app.js           # Fetch calls, SSE subscription, DOM wiring
│   │
│   └── utils/
│       ├── __init__.py
│       └── logging.py           # Basic logging setup
│
└── scripts/
    └── run.sh                   # Convenience launcher (uvicorn)
```

---

# Implementation (initial, working baseline)

## pyproject.toml

```toml
[project]
name = "vllm-pool"
version = "0.1.0"
description = "vLLM pool with per-GPU SSE tails and clean model/generate separation"
requires-python = ">=3.10"
dependencies = [
  "fastapi>=0.111.0",
  "uvicorn[standard]>=0.30.0",
  "pydantic>=2.7.0",
  "torch>=2.1.0",
  "vllm>=0.5.3",
]

[tool.uvicorn]
factory = true
host = "0.0.0.0"
port = 8000
```

## vllm\_pool/utils/logging.py

```python
import logging
import os

def setup_logging(level: str | None = None) -> None:
    lvl = getattr(logging, (level or os.getenv("LOG_LEVEL", "INFO")).upper(), logging.INFO)
    logging.basicConfig(level=lvl, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
```

## vllm\_pool/core/types.py

```python
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional, Dict, Any, List

@dataclass(frozen=True)
class LLMResourceConfig:
    gpu_memory_utilization: float
    max_model_len: int
    max_num_seqs: int
    max_num_batched_tokens: int
    block_size: int
    tensor_parallel_size: int
    dtype: str
    trust_remote_code: bool
    disable_log_stats: bool
    max_parallel_loading_workers: Optional[int] = None

    def to_vllm_kwargs(self) -> Dict[str, Any]:
        return {
            "gpu_memory_utilization": self.gpu_memory_utilization,
            "max_model_len": self.max_model_len,
            "max_num_seqs": self.max_num_seqs,
            "max_num_batched_tokens": self.max_num_batched_tokens,
            "block_size": self.block_size,
            "tensor_parallel_size": self.tensor_parallel_size,
            "dtype": self.dtype,
            "trust_remote_code": self.trust_remote_code,
            "disable_log_stats": self.disable_log_stats,
            "max_parallel_loading_workers": self.max_parallel_loading_workers,
        }

@dataclass(frozen=True)
class SamplingConfig:
    temperature: float = 0.0
    top_p: float = 1.0
    max_tokens: int = 1024
    batch_size: int = 100

@dataclass(frozen=True)
class ChatMessage:
    role: str
    content: str

@dataclass(frozen=True)
class ChatItem:
    messages: List[ChatMessage]
    metadata: Optional[Dict[str, Any]] = None
```

## vllm\_pool/core/config.py

```python
from __future__ import annotations
import json
from .types import LLMResourceConfig

DEFAULT_CFG = LLMResourceConfig(
    gpu_memory_utilization=0.92,
    max_model_len=4096,
    max_num_seqs=32,
    max_num_batched_tokens=8192,
    block_size=16,
    tensor_parallel_size=1,
    dtype="auto",
    trust_remote_code=True,
    disable_log_stats=True,
    max_parallel_loading_workers=2,
)

DEFAULT_CFG_STR = json.dumps(DEFAULT_CFG.to_vllm_kwargs(), indent=2)
```

## vllm\_pool/core/llm\_client.py

```python
from __future__ import annotations
from typing import List, Dict, Any
from vllm import LLM, SamplingParams
from .types import LLMResourceConfig, SamplingConfig

class LLMClient:
    """Thin adapter around vLLM to keep core testable and swappable."""
    def __init__(self, model_name: str, res_cfg: LLMResourceConfig):
        self.model_name = model_name
        self.llm = LLM(model_name, **res_cfg.to_vllm_kwargs())
        self.res_cfg = res_cfg

    def generate_simple(self, prompts: List[str], sc: SamplingConfig) -> List[Dict[str, str]]:
        params = SamplingParams(temperature=sc.temperature, top_p=sc.top_p, max_tokens=sc.max_tokens)
        outs = self.llm.generate(prompts, sampling_params=params, use_tqdm=True)
        return [{prompts[i]: out.outputs[0].text.strip()} for i, out in enumerate(outs)]

    def generate_chat(self, prompts: List[Dict[str, Any]], sc: SamplingConfig, output_field: str = "output") -> List[Dict]:
        params = SamplingParams(temperature=sc.temperature, top_p=sc.top_p, max_tokens=sc.max_tokens)
        outs = self.llm.chat(
            messages=[p["messages"] for p in prompts],
            sampling_params=params,
            chat_template_kwargs={"enable_thinking": False},
            use_tqdm=True,
        )
        return [{**prompts[i].get("metadata", {}), output_field: outs[i].outputs[0].text.strip()} for i in range(len(outs))]

    def close(self) -> None:
        import torch
        del self.llm
        torch.cuda.empty_cache()
```

## vllm\_pool/core/worker.py

```python
from __future__ import annotations
import os, sys, threading, multiprocessing as mp, time
from typing import Dict, Any, List
from .types import LLMResourceConfig, SamplingConfig
from .llm_client import LLMClient

class TailCapture:
    """Capture CR/newline output (tqdm, logs). Keep a rolling tail."""
    def __init__(self, max_keep: int = 200):
        from collections import deque
        self.lock = threading.Lock()
        self.buf = ""
        self.lines = deque(maxlen=max_keep)

    def write(self, data: str):
        data = data.replace("\r\n", "\n")
        with self.lock:
            for chunk in data.split("\r"):
                if "\n" in chunk:
                    parts = chunk.split("\n")
                    self._replace_current(parts[0])
                    for mid in parts[1:-1]:
                        self.lines.append(mid)
                    self.buf = parts[-1]
                else:
                    self._replace_current(chunk)

    def _replace_current(self, text: str):
        if self.buf:
            if len(self.lines) and self.lines[-1] == self.buf:
                self.lines.pop()
        self.buf = text
        if text:
            self.lines.append(text)

    def flush(self): pass

    def tail(self, n: int = 5) -> List[str]:
        with self.lock:
            take = list(self.lines)[-n:]
        return [s.strip() for s in take if s.strip()]

def worker_loop(cmd_q: mp.Queue, res_q: mp.Queue, model_name: str, cfg_dict: Dict[str, Any], gpu_id: int):
    os.environ["CUDA_VISIBLE_DEVICES"] = str(gpu_id)

    tap = TailCapture()
    orig_out, orig_err = sys.stdout, sys.stderr
    sys.stdout = tap
    sys.stderr = tap

    try:
        res_cfg = LLMResourceConfig(**cfg_dict)
        client = LLMClient(model_name, res_cfg)
        res_q.put({"type": "ready", "pid": os.getpid()})
    except Exception as e:
        res_q.put({"type": "error", "error": f"Failed to initialize LLM: {e}"})
        sys.stdout, sys.stderr = orig_out, orig_err
        return

    stop_logs = threading.Event()

    def push_tail_forever():
        while not stop_logs.is_set():
            try:
                res_q.put({"type": "tail", "lines": tap.tail(5)})
            except Exception:
                pass
            stop_logs.wait(2.0)

    threading.Thread(target=push_tail_forever, daemon=True).start()

    try:
        while True:
            msg = cmd_q.get()
            if not msg:
                continue
            kind = msg.get("type")

            if kind == "stop":
                stop_logs.set()
                res_q.put({"type": "stopped"})
                break

            if kind == "generate_simple":
                try:
                    sc = SamplingConfig(**msg["sampling"])
                    out = client.generate_simple(msg["prompts"], sc)
                    res_q.put({"type": "result", "job_id": msg["job_id"], "result": out})
                except Exception as e:
                    res_q.put({"type": "error", "job_id": msg["job_id"], "error": str(e)})
                continue

            if kind == "generate_chat":
                try:
                    sc = SamplingConfig(**msg["sampling"])
                    out = client.generate_chat(msg["prompts"], sc, output_field=msg.get("output_field", "output"))
                    res_q.put({"type": "result", "job_id": msg["job_id"], "result": out})
                except Exception as e:
                    res_q.put({"type": "error", "job_id": msg["job_id"], "error": str(e)})
                continue

            res_q.put({"type": "error", "error": f"Unknown command {kind}"})
    finally:
        sys.stdout, sys.stderr = orig_out, orig_err
        try: client.close()
        except Exception: pass
```

## vllm\_pool/core/pool.py

```python
from __future__ import annotations
import time, threading, uuid, multiprocessing as mp
from typing import Dict, Any, Tuple, Optional, List
import torch
from .worker import worker_loop

class PoolManager:
    """Owns worker processes and per-worker SSE tails. No web dependencies here."""
    def __init__(self, max_workers: int = 4):
        self.max_workers = max_workers
        self.gpu_count = torch.cuda.device_count()
        self.ctx = mp.get_context("spawn")
        self.lock = threading.Lock()

        self.workers: Dict[Tuple[str, int], Dict[str, Any]] = {}
        self.queues: Dict[str, list] = {}  # model -> list of job dicts (simple FIFO)
        self.busy: Dict[Tuple[str, int], bool] = {}
        self.jobs: Dict[str, Dict[str, Any]] = {}

        self.worker_subs: Dict[str, List[mp.Queue]] = {}  # key -> subscribers
        self._start_reader_threads: Dict[Tuple[str,int], threading.Thread] = {}

    @staticmethod
    def key(model: str, gpu: int) -> str:
        return f"{model}|{gpu}"

    # ---- subscribers for SSE tails
    def subscribe_worker(self, key: str) -> mp.Queue:
        q: mp.Queue = self.ctx.Queue()
        with self.lock:
            self.worker_subs.setdefault(key, []).append(q)
        return q

    def _broadcast_tail(self, key: str, lines: List[str]):
        for q in list(self.worker_subs.get(key, [])):
            try: q.put({"lines": lines}, block=False)
            except Exception: pass

    # ---- lifecycle
    def _gpu_in_use(self, gpu_id: int) -> bool:
        return any(gpu_id == g for (_, g) in self.workers.keys())

    def _free_gpu(self) -> Optional[int]:
        for gid in range(self.gpu_count):
            if not self._gpu_in_use(gid):
                return gid
        return None

    def _ensure_queue(self, model: str) -> None:
        self.queues.setdefault(model, [])

    def _active_workers(self) -> int:
        return sum(1 for info in self.workers.values() if info["proc"].is_alive())

    def list_models(self) -> List[str]:
        return sorted({m for (m, _) in self.workers.keys()})

    def list_workers(self) -> List[Dict[str, Any]]:
        return [{"key": self.key(m, g), "model": m, "gpu_id": g} for (m, g) in sorted(self.workers.keys())]

    def _spawn_worker(self, model: str, cfg: Dict[str, Any], gpu_id: int) -> Dict[str, Any]:
        if self._active_workers() >= self.max_workers:
            raise RuntimeError(f"Pool limit reached ({self.max_workers}).")
        if gpu_id < 0 or gpu_id >= self.gpu_count:
            raise RuntimeError(f"Invalid gpu_id {gpu_id}.")
        if self._gpu_in_use(gpu_id) and (model, gpu_id) not in self.workers:
            raise RuntimeError(f"GPU {gpu_id} is not empty.")

        cmd_q: mp.Queue = self.ctx.Queue()
        res_q: mp.Queue = self.ctx.Queue()
        proc = self.ctx.Process(target=worker_loop, args=(cmd_q, res_q, model, cfg, gpu_id))
        proc.daemon = False
        proc.start()

        # wait ready
        deadline = time.time() + 180
        pid, err = None, None
        while time.time() < deadline:
            try:
                msg = res_q.get(timeout=0.5)
            except Exception:
                if not proc.is_alive(): break
                continue
            if msg.get("type") == "ready":
                pid = msg.get("pid", proc.pid)
                break
            if msg.get("type") == "error":
                err = msg.get("error")
                break

        if not pid:
            proc.terminate(); proc.join(timeout=1.0)
            raise RuntimeError(err or "Worker failed to become ready.")

        info = {"model": model, "gpu_id": gpu_id, "proc": proc, "cmd_q": cmd_q, "res_q": res_q, "pid": pid}
        self.workers[(model, gpu_id)] = info
        self.busy[(model, gpu_id)] = False
        self._ensure_queue(model)

        # reader thread: forward tails; resolve jobs
        t = threading.Thread(target=self._reader_loop, args=(model, gpu_id), daemon=True)
        t.start()
        self._start_reader_threads[(model, gpu_id)] = t
        return info

    def _reader_loop(self, model: str, gpu_id: int):
        key = self.key(model, gpu_id)
        info = self.workers[(model, gpu_id)]
        q = info["res_q"]
        while True:
            try:
                msg = q.get()
            except Exception:
                break
            typ = msg.get("type")
            if typ == "tail":
                self._broadcast_tail(key, msg.get("lines", []))
            elif typ == "result":
                job_id = msg.get("job_id")
                rec = self.jobs.get(job_id)
                if rec:
                    rec["status"] = "done"; rec["result"] = msg.get("result"); rec["event"].set()
                self.busy[(model, gpu_id)] = False
                self._dispatch_next(model)
            elif typ == "error":
                job_id = msg.get("job_id")
                rec = self.jobs.get(job_id)
                if rec:
                    rec["status"] = "error"; rec["error"] = msg.get("error", "unknown"); rec["event"].set()
                self.busy[(model, gpu_id)] = False
                self._dispatch_next(model)
            elif typ == "stopped":
                self._broadcast_tail(key, ["[worker stopped]"])
                break

    def start(self, model: str, cfg: Dict[str, Any], gpu_id: Optional[int]) -> tuple[str, int, int]:
        with self.lock:
            if self.gpu_count == 0:
                raise RuntimeError("No GPUs detected on server.")
            gid = gpu_id if gpu_id is not None else self._free_gpu()
            if gid is None:
                raise RuntimeError("All GPUs are currently in use.")
            if self._gpu_in_use(gid) and (model, gid) not in self.workers:
                raise RuntimeError(f"GPU {gid} is not empty.")
            existing = self.workers.get((model, gid))
            if existing:
                return model, gid, existing["pid"]
            info = self._spawn_worker(model, cfg, gid)
            return model, gid, info["pid"]

    def stop(self, model: str, gpu_id: int) -> str:
        with self.lock:
            info = self.workers.get((model, gpu_id))
            if not info: raise KeyError("No such worker")
            if self.busy.get((model, gpu_id), False):
                raise RuntimeError("Worker is busy; wait until it completes.")
            info["cmd_q"].put({"type": "stop"})
            if info["proc"].is_alive():
                info["proc"].join(timeout=2.0)
            del self.workers[(model, gpu_id)]
            del self.busy[(model, gpu_id)]
            if all(m != model for (m, _) in self.workers.keys()):
                self.queues.pop(model, None)
            return "stopped"

    # ---- jobs
    def _dispatch_next(self, model: str) -> None:
        queue = self.queues.get(model) or []
        if not queue: return
        idle = next(((m,g) for (m,g),busy in self.busy.items() if m==model and not busy), None)
        if not idle: return
        _, gpu = idle
        job = queue.pop(0)
        self._send(job, gpu)

    def _send(self, job: Dict[str, Any], gpu_id: int):
        info = self.workers[(job["model_name"], gpu_id)]
        self.busy[(job["model_name"], gpu_id)] = True
        cmd = job["cmd"]; cmd["job_id"] = job["job_id"]
        info["cmd_q"].put(cmd)

    def submit_and_wait(self, job: Dict[str, Any], timeout_sec: Optional[int] = None) -> Dict[str, Any]:
        model = job["model_name"]
        with self.lock:
            if all(m != model for (m, _) in self.workers.keys()):
                raise RuntimeError("Model not loaded.")
            import threading
            ev = threading.Event()
            self.jobs[job["job_id"]] = {"status": "queued", "result": None, "error": None, "event": ev}
            self._ensure_queue(model)
            self.queues[model].append(job)
            # try dispatch immediately
            self._dispatch_next(model)

        ev.wait(timeout=timeout_sec)
        rec = self.jobs[job["job_id"]]
        return {"status": rec["status"], "result": rec.get("result"), "error": rec.get("error")}

    # ---- inspection
    def status(self) -> Dict[str, Any]:
        running = {}
        for (m,g), info in self.workers.items():
            running[f"{m}@gpu{g}"] = {"model": m, "gpu_id": g, "pid": info["pid"],
                                      "alive": info["proc"].is_alive(),
                                      "busy": self.busy.get((m,g), False)}
        queues = {m: len(q) for m, q in self.queues.items()}
        return {"gpu_count": self.gpu_count, "max_workers": self.max_workers, "running": running, "queues": queues}
```

## vllm\_pool/api/models.py

```python
from __future__ import annotations
from typing import Optional, List, Dict, Any, Union
from pydantic import BaseModel, Field

class StartRequest(BaseModel):
    model_name: str
    config: Dict[str, Any]
    gpu_id: Optional[int] = None

class StartResponse(BaseModel):
    model_name: str
    gpu_id: int
    pid: int
    status: str

class SamplingConfigModel(BaseModel):
    temperature: float = 0.0
    top_p: float = 1.0
    max_tokens: int = 1024
    batch_size: int = 100

class GenerateSimpleRequest(BaseModel):
    model_name: str
    prompts: List[str] | str
    sampling: SamplingConfigModel

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatItem(BaseModel):
    messages: List[ChatMessage]
    metadata: Optional[Dict[str, Any]] = None

class GenerateChatRequest(BaseModel):
    model_name: str
    prompts: List[ChatItem]
    sampling: SamplingConfigModel
    output_field: str = "output"
```

## vllm\_pool/api/router\_start.py

```python
from __future__ import annotations
from fastapi import APIRouter, HTTPException, Form
from .models import StartRequest, StartResponse
from ..core.pool import PoolManager
from ..core.config import DEFAULT_CFG

router = APIRouter()

def bind(pool: PoolManager) -> APIRouter:
    @router.post("/start", response_model=StartResponse)
    def start_worker(req: StartRequest):
        cfg = req.config or DEFAULT_CFG.to_vllm_kwargs()
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
```

## vllm\_pool/api/router\_status.py

```python
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
```

## vllm\_pool/api/router\_generate.py

```python
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
        # tolerate single string
        prompts = req.prompts if isinstance(req.prompts, list) else [req.prompts]
        job_id = str(uuid.uuid4())[:8]
        job = {
            "job_id": job_id,
            "model_name": req.model_name,
            "cmd": {"type": "generate_simple", "prompts": prompts, "sampling": req.sampling.model_dump()},
        }
        try:
            result = pool.submit_and_wait(job)
            if result["status"] == "done":
                return JSONResponse({"job_id": job_id, "result": result["result"]})
            raise HTTPException(status_code=500, detail=result.get("error", "Unknown error"))
        except RuntimeError as e:
            raise HTTPException(status_code=409, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to generate: {e}")

    @router.post("/generate/chat")
    def generate_chat(req: GenerateChatRequest):
        job_id = str(uuid.uuid4())[:8]
        prompts = [{"messages": [m.model_dump() for m in it.messages], "metadata": (it.metadata or {})} for it in req.prompts]
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
            result = pool.submit_and_wait(job)
            if result["status"] == "done":
                return JSONResponse({"job_id": job_id, "result": result["result"]})
            raise HTTPException(status_code=500, detail=result.get("error", "Unknown error"))
        except RuntimeError as e:
            raise HTTPException(status_code=409, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to generate: {e}")

    return router
```

## vllm\_pool/api/router\_events.py

```python
from __future__ import annotations
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
                    ev = q.get(timeout=1.0)
                    payload = (ev or {"lines": []})
                    yield f"event: tail\ndata: {payload!s}\n\n".encode("utf-8")  # payload is dict; __str__ -> validish
                except Exception:
                    yield b": keep-alive\n\n"
            yield b"event: bye\ndata: {}\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    return router
```

> Note: if you prefer strict JSON in SSE data, swap `payload = json.dumps(ev)` and encode.

## vllm\_pool/ui/templates/index.html

(HTML is your current layout with per-worker tail dropdown; reusing what we built. For brevity, it references `static/app.js`.)

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>vLLM Manager</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <style>
    :root { --pad:16px; }
    body { font-family: ui-sans-serif, system-ui; margin:20px; }
    .grid { display:grid; grid-template-columns:1fr 1fr; grid-template-rows:auto auto auto; gap:16px; }
    .card { border:1px solid #ddd; border-radius:12px; padding:var(--pad); box-shadow:0 2px 8px rgba(0,0,0,0.05); }
    input, select, textarea, button { padding:8px; border-radius:8px; border:1px solid #bbb; }
    #generate, #results { grid-column:1 / span 2; }
    .row { display:flex; gap:12px; align-items:flex-start; flex-wrap:wrap; }
    .stack > * { display:block; margin-top:8px; }
    .fieldset { border:1px dashed #ccc; border-radius:8px; padding:10px; }
    #progressBox { height:160px; overflow:auto; white-space:pre; background:#0b1020; color:#d6f0ff; padding:10px; border-radius:8px; border:1px solid #223; }
    #status { white-space:pre-wrap; background:#fafafa; padding:10px; border-radius:8px; border:1px solid #eee; max-height:220px; overflow:auto; }
    #resultBox { height:420px; overflow:auto; white-space:pre-wrap; background:#fafafa; padding:10px; border-radius:8px; border:1px solid #eee; }
    .tabbar { display:flex; gap:8px; border-bottom:1px solid #eee; margin-bottom:12px; }
    .tab-active { background:#111; color:#fff; }
  </style>
</head>
<body>
  <h1>vLLM Manager</h1>
  <div class="grid">
    <div class="card">
      <h3>Start model</h3>
      <div class="stack">
        <div><label>Model name</label><br><input id="mname" size="48" placeholder="Qwen/Qwen2.5-7B-Instruct"/></div>
        <div><label>GPU (optional)</label><br><input id="gpu" type="number" min="0" style="width:90px;" placeholder="e.g. 0"/></div>
        <div><label>vLLM config JSON</label><br><textarea id="cfg" rows="10" cols="62" class="mono">__DEFAULT_CFG__</textarea></div>
        <div class="row">
          <button onclick="startModel()">Start</button>
          <form onsubmit="stopWorker(event)">
            <input id="s_model" placeholder="model to stop" size="28"/>
            <input id="s_gpu" type="number" min="0" style="width:90px;" placeholder="gpu"/>
            <button type="submit">Stop</button>
          </form>
          <span id="start_msg" class="muted"></span>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Status & Live GPU tail</h3>
      <div class="row">
        <button onclick="refresh()">Refresh</button>
        <select id="workerSel" onchange="switchWorker()"></select>
      </div>
      <pre id="status"></pre>
      <div style="margin-top:8px;">
        <label class="muted">Live tail (last ~5 lines for selected worker)</label>
        <pre id="progressBox" class="mono"></pre>
      </div>
    </div>

    <div class="card" id="generate">
      <div class="tabbar">
        <button id="tabSimple" class="tab-active" onclick="switchTab('simple')">Generate: Simple</button>
        <button id="tabChat" onclick="switchTab('chat')">Generate: Chat</button>
      </div>

      <!-- Simple -->
      <div id="panelSimple">
        <div class="row">
          <div class="stack" style="min-width:360px;">
            <div class="fieldset">
              <label><b>Model</b></label><br><select id="g_model" style="min-width:340px;"></select>
            </div>
            <div class="fieldset">
              <label><b>Sampling params</b></label><br>
              <textarea id="g_sampling" rows="6" cols="40" class="mono">{ "temperature": 0.0, "top_p": 1.0, "max_tokens": 256, "batch_size": 1 }</textarea>
            </div>
          </div>
          <div class="stack" style="flex:1; min-width:420px;">
            <div class="fieldset">
              <label><b>Prompts JSON (array of strings)</b></label><br>
              <textarea id="g_prompt" rows="10" class="mono" placeholder='["Your prompt..."]'></textarea>
            </div>
            <div class="fieldset">
              <label><b>OR Upload prompts JSON</b></label><br>
              <input id="g_file" type="file" accept=".json"/>
              <div style="margin-top:8px;"><button onclick="submitSimple()">Generate</button> <span id="g_msg" class="muted"></span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Chat -->
      <div id="panelChat" style="display:none;">
        <div class="row">
          <div class="stack" style="min-width:360px;">
            <div class="fieldset">
              <label><b>Model</b></label><br><select id="c_model" style="min-width:340px;"></select>
            </div>
            <div class="fieldset">
              <label><b>Sampling params</b></label><br>
              <textarea id="c_sampling" rows="6" cols="40" class="mono">{ "temperature": 0.0, "top_p": 1.0, "max_tokens": 256, "batch_size": 1 }</textarea>
            </div>
          </div>
          <div class="stack" style="flex:1; min-width:460px;">
            <div class="fieldset">
              <label><b>Messages JSON (array of chat items)</b></label><br>
              <textarea id="c_msgs" rows="10" class="mono" placeholder='[{"messages":[{"role":"user","content":"Hi"}],"metadata":{"id":"1"}}]'></textarea>
            </div>
            <div class="fieldset">
              <label><b>OR Upload chat JSON file</b></label><br>
              <input id="c_file" type="file" accept=".json"/>
              <div style="margin-top:8px;"><button onclick="submitChat()">Generate</button> <span id="c_msg" class="muted"></span></div>
            </div>
          </div>
          <div class="stack" style="min-width:260px;">
            <div class="fieldset">
              <label><b>Output field</b></label><br>
              <input id="c_outfield" size="20" value="output"/>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" id="results">
      <h3>Response</h3>
      <div class="row">
        <button onclick="saveJSON()">Save as JSON</button>
        <button onclick="clearResults()">Clear</button>
      </div>
      <pre id="resultBox" class="mono"></pre>
    </div>
  </div>

  <script src="/static/app.js"></script>
</body>
</html>
```

## vllm\_pool/ui/static/app.js

```javascript
let lastResult = null;
let evtSource = null;

function switchTab(which) {
  const sBtn = document.getElementById('tabSimple');
  const cBtn = document.getElementById('tabChat');
  const sPanel = document.getElementById('panelSimple');
  const cPanel = document.getElementById('panelChat');
  if (which === 'simple') { sBtn.classList.add('tab-active'); cBtn.classList.remove('tab-active'); sPanel.style.display=''; cPanel.style.display='none'; }
  else { cBtn.classList.add('tab-active'); sBtn.classList.remove('tab-active'); cPanel.style.display=''; sPanel.style.display='none'; }
}

function showResult(obj){ lastResult = obj; document.getElementById('resultBox').textContent = JSON.stringify(obj,null,2); }
function clearResults(){ lastResult=null; document.getElementById('resultBox').textContent=''; }
function saveJSON(){
  if (!lastResult) { alert("No result to save yet."); return; }
  const blob = new Blob([JSON.stringify(lastResult, null, 2)], {type: "application/json"});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  const id = ('job_id' in lastResult) ? lastResult.job_id : 'result'; a.download = `${id}.json`;
  document.body.appendChild(a); a.click(); a.remove();
}

async function refreshModels() {
  const res = await fetch('/models'); const j = await res.json();
  for (const id of ['g_model','c_model']) {
    const sel = document.getElementById(id); sel.innerHTML='';
    const arr = j.models || [];
    if (!arr.length) { const o=document.createElement('option'); o.value=''; o.textContent='— no models loaded —'; sel.appendChild(o); continue; }
    for (const m of arr) { const o=document.createElement('option'); o.value=m; o.textContent=m; sel.appendChild(o); }
  }
}

async function refreshWorkers() {
  const res = await fetch('/workers'); const j = await res.json();
  const sel = document.getElementById('workerSel'); sel.innerHTML='';
  const arr = j.workers || [];
  if (!arr.length) { const o=document.createElement('option'); o.value=''; o.textContent='— no workers —'; sel.appendChild(o); closeSSE(); document.getElementById('progressBox').textContent=''; return; }
  for (const w of arr) {
    const o=document.createElement('option');
    o.value = w.key; o.textContent = `gpu ${w.gpu_id} — ${w.model}`; sel.appendChild(o);
  }
  switchWorker();
}

async function refresh() {
  const el = document.getElementById('status'); el.textContent='...';
  try { const res = await fetch('/status'); el.textContent = JSON.stringify(await res.json(), null, 2); } catch(e){ el.textContent=e.message; }
  refreshModels(); refreshWorkers();
}

function closeSSE(){ if (evtSource){ try{ evtSource.close(); }catch(_){} evtSource=null; } }
function switchWorker(){
  const key = document.getElementById('workerSel').value;
  if (!key) { closeSSE(); document.getElementById('progressBox').textContent=''; return; }
  openSSE(`/events/worker/${encodeURIComponent(key)}`);
}
function openSSE(url) {
  closeSSE();
  evtSource = new EventSource(url);
  evtSource.addEventListener('tail', (ev) => {
    try { const obj = JSON.parse(ev.data); const lines = (obj.lines||[]).slice(-5);
          document.getElementById('progressBox').textContent = lines.join("\n"); }
    catch { /* ignore */ }
  });
}

function parseJSONSafe(text, fallback) { if (!text || !text.trim()) return fallback; try { return JSON.parse(text); } catch { return fallback; } }

async function readFileAsJSON(inputEl) { const f = inputEl.files && inputEl.files[0]; if (!f) return null; return JSON.parse(await f.text()); }

async function startModel() {
  const m = document.getElementById('mname').value.trim();
  const gtxt = document.getElementById('gpu').value.trim();
  const gpu = gtxt === "" ? null : Number(gtxt);
  const cfgTxt = document.getElementById('cfg').value;
  const msg = document.getElementById('start_msg'); msg.textContent='...';
  try {
    const body = { model_name: m, config: parseJSONSafe(cfgTxt, {}), gpu_id: gpu };
    const res = await fetch('/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const j = await res.json(); if (!res.ok) throw new Error(j.detail || JSON.stringify(j));
    msg.innerHTML = `<span class="ok">started ${j.model_name} on gpu ${j.gpu_id} (pid ${j.pid})</span>`;
    refresh();
  } catch (e) { msg.innerHTML = `<span class="err">${e.message}</span>`; }
}

async function stopWorker(e) {
  e.preventDefault();
  const m = document.getElementById('s_model').value.trim();
  const g = document.getElementById('s_gpu').value.trim();
  if (!m || g === "") return;
  const form = new FormData(); form.append('model_name', m); form.append('gpu_id', Number(g));
  try { const res = await fetch('/stop', { method:'POST', body: form }); const j = await res.json();
        if (!res.ok) throw new Error(j.detail || JSON.stringify(j)); document.getElementById('start_msg').innerHTML = `<span class="ok">${j.status}</span>`; refresh();
  } catch (e2) { document.getElementById('start_msg').innerHTML = `<span class="err">${e2.message}</span>`; }
}

async function submitSimple() {
  const m = document.getElementById('g_model').value.trim();
  const sampling = parseJSONSafe(document.getElementById('g_sampling').value, {temperature:0.0, top_p:1.0, max_tokens:256, batch_size:1});
  const fileEl = document.getElementById('g_file');
  let prompts = parseJSONSafe(document.getElementById('g_prompt').value, []);
  const fromFile = await readFileAsJSON(fileEl); if (fromFile) prompts = fromFile;
  if (!Array.isArray(prompts)) { document.getElementById('g_msg').innerHTML = '<span class="err">Prompts must be an array of strings.</span>'; return; }
  const res = await fetch('/generate/simple', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ model_name:m, prompts, sampling }) });
  const j = await res.json(); if (!res.ok) { document.getElementById('g_msg').innerHTML = `<span class="err">${j.detail || 'error'}</span>`; return; }
  document.getElementById('g_msg').innerHTML = `<span class="ok">done (job ${j.job_id})</span>`; showResult(j);
}

async function submitChat() {
  const m = document.getElementById('c_model').value.trim();
  const sampling = parseJSONSafe(document.getElementById('c_sampling').value, {temperature:0.0, top_p:1.0, max_tokens:256, batch_size:1});
  const outField = document.getElementById('c_outfield').value || "output";
  const fileEl = document.getElementById('c_file');
  let prompts = parseJSONSafe(document.getElementById('c_msgs').value, []);
  const fromFile = await readFileAsJSON(fileEl); if (fromFile) prompts = fromFile;
  if (!Array.isArray(prompts)) { document.getElementById('c_msg').innerHTML = '<span class="err">Chat must be an array of items.</span>'; return; }
  const res = await fetch('/generate/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ model_name:m, prompts, sampling, output_field: outField }) });
  const j = await res.json(); if (!res.ok) { document.getElementById('c_msg').innerHTML = `<span class="err">${j.detail || 'error'}</span>`; return; }
  document.getElementById('c_msg').innerHTML = `<span class="ok">done (job ${j.job_id})</span>`; showResult(j);
}

refresh();
```

## vllm\_pool/main.py

```python
from __future__ import annotations
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from .utils.logging import setup_logging
from .core.pool import PoolManager
from .core.config import DEFAULT_CFG_STR
from .api import router_start, router_status, router_generate, router_events

def create_app() -> FastAPI:
    setup_logging()
    app = FastAPI(title="vLLM Pool", version="0.7.0")

    pool = PoolManager(max_workers=4)
    app.state.pool = pool

    app.include_router(router_start.bind(pool))
    app.include_router(router_status.bind(pool))
    app.include_router(router_generate.bind(pool))
    app.include_router(router_events.bind(pool))

    app.mount("/static", StaticFiles(directory=str(__file__).replace("main.py", "ui/static")), name="static")

    @app.get("/", response_class=HTMLResponse)
    def index():
        # load template and inject DEFAULT_CFG
        import pathlib
        tpl = pathlib.Path(__file__).with_name("ui").joinpath("templates/index.html").read_text()
        return HTMLResponse(tpl.replace("__DEFAULT_CFG__", DEFAULT_CFG_STR))

    return app

app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("vllm_pool.main:app", host="0.0.0.0", port=8000, reload=False)
```

## scripts/run.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
export PYTHONUNBUFFERED=1
uvicorn vllm_pool.main:app --host 0.0.0.0 --port 8000
```

---

### Notes

* OOD: core domain (types, llm client, worker, pool) is isolated from web/UI. API routers bind to a `PoolManager` instance (dependency inversion via `bind`).
* SSE is per-worker using `/events/worker/{key:path}`. The UI picks an active worker from a dropdown.
* Generate panel uses only **loaded models** and **no GPU picker** (as requested).
* Start panel solely manages lifecycle and vLLM config.

If you want unit tests next, I’ll add tests for `TailCapture`, job queueing in `PoolManager`, and router happy-paths with FastAPI’s TestClient.
