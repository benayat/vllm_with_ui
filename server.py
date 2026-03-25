#!/usr/bin/env python3
from __future__ import annotations

import os
import time
import uuid
import json
import logging
import threading
import multiprocessing as mp
from collections import deque
from dataclasses import dataclass
from typing import List, Dict, Any, Optional, Tuple, Generator

# ---------- 'spawn' & non-daemon ----------
if mp.get_start_method(allow_none=True) != "spawn":
    mp.set_start_method("spawn", force=True)
ctx = mp.get_context("spawn")

import torch
from fastapi import FastAPI, HTTPException, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

# ---------------- vLLM interface ----------------
from vllm import SamplingParams, LLM
import torch.cuda

# ---------------- Data classes ----------------
@dataclass
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

    def to_vllm_config(self) -> Dict[str, Any]:
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

@dataclass
class SamplingConfig:
    temperature: float = 0.0
    top_p: float = 1.0
    max_tokens: int = 1024
    batch_size: int = 100

class LLMClient:
    def __init__(self, model_name: str, config: LLMResourceConfig):
        self.model_name = model_name
        self.llm = LLM(self.model_name, **config.to_vllm_config())
        self.config = config

    def run_batch_simple(self, prompts: List[str], s: SamplingConfig) -> List[Dict[str, str]]:
        params = SamplingParams(temperature=s.temperature, top_p=s.top_p, max_tokens=s.max_tokens)
        outputs = self.llm.generate(prompts, sampling_params=params, use_tqdm=True)
        return [{prompts[i]: output.outputs[0].text.strip()} for i, output in enumerate(outputs)]

    def run_batch(self, prompts: List[Dict], s: SamplingConfig, output_field: str = "output") -> List[Dict]:
        params = SamplingParams(temperature=s.temperature, top_p=s.top_p, max_tokens=s.max_tokens)
        outputs = self.llm.chat(
            messages=[p["messages"] for p in prompts],
            sampling_params=params,
            chat_template_kwargs={"enable_thinking": False},
            use_tqdm=True,
        )
        return [{**prompts[i].get("metadata", {}), output_field: output.outputs[0].text.strip()}
                for i, output in enumerate(outputs)]

# ---------------- API models ----------------
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
    prompts: List[str]
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

# ---------------- Worker loop with per-worker log tail ----------------
class _TailCapture:
    """Capture CR/\\n prints (tqdm etc.), keep a rolling deque of lines; snapshot last N."""
    def __init__(self, max_keep: int = 200):
        self.lock = threading.Lock()
        self.buf = ""
        self.lines = deque(maxlen=max_keep)
        self._fallback_stream = sys.__stdout__

    def write(self, data: str):
        data = data.replace("\r\n", "\n")
        with self.lock:
            # handle CR: keep only last segment on the line
            for chunk in data.split("\r"):
                if "\n" in chunk:
                    parts = chunk.split("\n")
                    # first segment replaces current line
                    self._replace_current(parts[0])
                    for mid in parts[1:-1]:
                        self.lines.append(mid)
                    # last part becomes new current buffer
                    self.buf = parts[-1]
                else:
                    # no newline; just replace current line content
                    self._replace_current(chunk)

    def _replace_current(self, text: str):
        # Replace current (possibly partial) line
        if self.buf:
            # discard old current line, replace with new content
            if len(self.lines) and self.lines[-1] == self.buf:
                self.lines.pop()
        self.buf = text
        if text:
            self.lines.append(text)

    def flush(self):  # compatibility
        pass

    def fileno(self) -> int:
        if self._fallback_stream is None:
            raise OSError("No fallback stdout stream available")
        return self._fallback_stream.fileno()

    def isatty(self) -> bool:
        return bool(self._fallback_stream and self._fallback_stream.isatty())

    def tail(self, n: int = 5) -> List[str]:
        with self.lock:
            take = list(self.lines)[-n:]
        return [s.strip() for s in take if s.strip()]

def _worker_loop(cmd_q: mp.Queue, res_q: mp.Queue, model_name: str, cfg_dict: Dict[str, Any], gpu_id: int):
    os.environ["CUDA_VISIBLE_DEVICES"] = str(gpu_id)
    import sys
    tap = _TailCapture()
    orig_out, orig_err = sys.stdout, sys.stderr
    sys.stdout = tap
    sys.stderr = tap

    try:
        llm_cfg = LLMResourceConfig(**cfg_dict)
        client = LLMClient(model_name, llm_cfg)
        res_q.put({"type": "ready", "pid": os.getpid()})
    except Exception as e:
        res_q.put({"type": "error", "error": f"Failed to initialize LLM: {e}"})
        sys.stdout, sys.stderr = orig_out, orig_err
        return

    stop_logs = threading.Event()

    def push_tail_forever():
        # Send the last 5 lines every ~2 seconds (even idle)
        while not stop_logs.is_set():
            try:
                tail = tap.tail(5)
                res_q.put({"type": "tail", "lines": tail})
            except Exception:
                pass
            stop_logs.wait(2.0)

    log_thread = threading.Thread(target=push_tail_forever, daemon=True)
    log_thread.start()

    try:
        while True:
            msg = cmd_q.get()
            if not msg:
                continue
            t = msg.get("type")

            if t == "stop":
                stop_logs.set()
                res_q.put({"type": "stopped"})
                break

            elif t == "generate_simple":
                prompts = msg["prompts"]
                s = SamplingConfig(**msg["sampling"])
                try:
                    out = client.run_batch_simple(prompts, s)
                    res_q.put({"type": "result", "job_id": msg["job_id"], "result": out})
                except Exception as e:
                    res_q.put({"type": "error", "job_id": msg["job_id"], "error": str(e)})

            elif t == "generate_chat":
                items = msg["prompts"]
                prompts = [{"messages": [m for m in it["messages"]], "metadata": it.get("metadata", {})} for it in items]
                s = SamplingConfig(**msg["sampling"])
                of = msg.get("output_field", "output")
                try:
                    out = client.run_batch(prompts, s, output_field=of)
                    res_q.put({"type": "result", "job_id": msg["job_id"], "result": out})
                except Exception as e:
                    res_q.put({"type": "error", "job_id": msg["job_id"], "error": str(e)})
            else:
                res_q.put({"type": "error", "error": f"Unknown command {t}"})
    finally:
        sys.stdout, sys.stderr = orig_out, orig_err

# ---------------- Pool (strict separation + per-worker SSE tails) ----------------
class PoolManager:
    def __init__(self, max_workers: int = 4):
        self.max_workers = max_workers
        self.gpu_count = torch.cuda.device_count()
        self.lock = threading.Lock()

        self.workers: Dict[Tuple[str, int], Dict[str, Any]] = {}
        self.model_queues: Dict[str, deque] = {}
        self.worker_busy: Dict[Tuple[str, int], bool] = {}
        self.jobs: Dict[str, Dict[str, Any]] = {}
        # subscribers to worker tails: key -> list of queues
        self.worker_subs: Dict[str, List[mp.Queue]] = {}
        logging.info(f"Pool ready. GPUs detected: {self.gpu_count}")

    @staticmethod
    def key(model: str, gpu: int) -> str:
        return f"{model}|{gpu}"

    def _gpu_in_use(self, gpu_id: int) -> bool:
        return any(gpu_id == g for (_, g) in self.workers.keys())

    def _free_gpu(self) -> Optional[int]:
        for gid in range(self.gpu_count):
            if not self._gpu_in_use(gid):
                return gid
        return None

    def _ensure_model_queue(self, model: str):
        if model not in self.model_queues:
            self.model_queues[model] = deque()

    def _get_idle_worker_for_model(self, model: str) -> Optional[Tuple[str, int]]:
        for (m, g), info in self.workers.items():
            if m == model and not self.worker_busy.get((m, g), False) and info["proc"].is_alive():
                return (m, g)
        return None

    def _active_workers(self) -> int:
        return sum(1 for info in self.workers.values() if info["proc"].is_alive())

    def list_models(self) -> List[str]:
        return sorted({m for (m, _) in self.workers.keys()})

    def list_workers(self) -> List[Dict[str, Any]]:
        return [{"key": self.key(m, g), "model": m, "gpu_id": g} for (m, g) in sorted(self.workers.keys())]

    # subscriber mgmt
    def subscribe_worker(self, key: str) -> mp.Queue:
        q: mp.Queue = ctx.Queue()
        with self.lock:
            self.worker_subs.setdefault(key, []).append(q)
        return q

    def _broadcast_tail(self, key: str, lines: List[str]):
        subs = self.worker_subs.get(key, [])
        for q in list(subs):
            try:
                q.put({"lines": lines}, block=False)
            except Exception:
                pass

    # worker lifecycle
    def _spawn_worker(self, model: str, cfg: Dict[str, Any], gpu_id: int) -> Dict[str, Any]:
        if self._active_workers() >= self.max_workers:
            raise RuntimeError(f"Pool limit reached ({self.max_workers}).")
        if gpu_id < 0 or gpu_id >= self.gpu_count:
            raise RuntimeError(f"Invalid gpu_id {gpu_id}.")
        if self._gpu_in_use(gpu_id) and (model, gpu_id) not in self.workers:
            raise RuntimeError(f"GPU {gpu_id} is not empty.")

        cmd_q: mp.Queue = ctx.Queue()
        res_q: mp.Queue = ctx.Queue()
        proc = ctx.Process(target=_worker_loop, args=(cmd_q, res_q, model, cfg, gpu_id))
        proc.daemon = False
        proc.start()

        # wait ready
        deadline = time.time() + 180
        ready, pid, err = False, None, None
        while time.time() < deadline:
            try:
                msg = res_q.get(timeout=0.5)
            except Exception:
                if not proc.is_alive():
                    break
                continue
            if msg.get("type") == "ready":
                ready = True
                pid = msg.get("pid", proc.pid)
                break
            if msg.get("type") == "error":
                err = msg.get("error")
                break
        if not ready:
            proc.terminate(); proc.join(timeout=1.0)
            raise RuntimeError(err or "Worker failed to become ready.")

        info = {"model": model, "gpu_id": gpu_id, "proc": proc, "cmd_q": cmd_q, "res_q": res_q, "pid": pid}
        self.workers[(model, gpu_id)] = info
        self.worker_busy[(model, gpu_id)] = False
        self._ensure_model_queue(model)
        # start a single reader thread per worker to forward tails and resolve jobs
        threading.Thread(target=self._worker_reader, args=(model, gpu_id), daemon=True).start()
        return info

    def _worker_reader(self, model: str, gpu_id: int):
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
                continue
            if typ == "result":
                job_id = msg.get("job_id")
                rec = self.jobs.get(job_id)
                if rec:
                    rec["status"] = "done"
                    rec["result"] = msg.get("result")
                    rec["event"].set()
                continue
            if typ == "error":
                job_id = msg.get("job_id")
                if job_id and job_id in self.jobs:
                    rec = self.jobs[job_id]
                    rec["status"] = "error"
                    rec["error"] = msg.get("error", "unknown error")
                    rec["event"].set()
                continue
            if typ == "stopped":
                self._broadcast_tail(key, ["[worker stopped]"])
                break

    def stop_worker(self, model: str, gpu_id: int) -> str:
        with self.lock:
            info = self.workers.get((model, gpu_id))
            if not info:
                raise KeyError("No such worker")
            if self.worker_busy.get((model, gpu_id), False):
                raise RuntimeError("Worker is busy; wait until it completes.")
            info["cmd_q"].put({"type": "stop"})
            # reader thread will notice 'stopped'
            proc = info["proc"]
            if proc.is_alive():
                proc.join(timeout=2.0)
            del self.workers[(model, gpu_id)]
            del self.worker_busy[(model, gpu_id)]
            if all(m != model for (m, _) in self.workers.keys()):
                self.model_queues.pop(model, None)
            return "stopped"

    def start(self, model: str, cfg: Dict[str, Any], gpu_id: Optional[int]) -> Tuple[str, int, int]:
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

    # job submission (no auto-start)
    def _dispatch_next(self, model: str):
        q = self.model_queues.get(model)
        if not q:
            return
        idle = self._get_idle_worker_for_model(model)
        if not idle:
            return
        (_, gpu_id) = idle
        job = q.popleft()
        self._send_job_to_worker(job, gpu_id)

    def _send_job_to_worker(self, job: Dict[str, Any], gpu_id: int):
        info = self.workers[(job["model_name"], gpu_id)]
        self.worker_busy[(job["model_name"], gpu_id)] = True
        cmd = job["cmd"]; cmd["job_id"] = job["job_id"]
        info["cmd_q"].put(cmd)

    def submit_and_wait(self, job: Dict[str, Any], timeout_sec: Optional[int] = None) -> Dict[str, Any]:
        model = job["model_name"]
        with self.lock:
            if all(m != model for (m, _) in self.workers.keys()):
                raise RuntimeError("Model not loaded.")
            ev = threading.Event()
            self.jobs[job["job_id"]] = {"status": "queued", "result": None, "error": None, "event": ev}
            self._ensure_model_queue(model)
            self.model_queues[model].append(job)
            idle = self._get_idle_worker_for_model(model)
            if idle:
                (_, idle_gpu) = idle
                dq = self.model_queues[model]
                for i, it in enumerate(dq):
                    if it["job_id"] == job["job_id"]:
                        dq.rotate(-i); break
                self._send_job_to_worker(job, idle_gpu)
                dq.popleft()

        ev.wait(timeout=None if timeout_sec is None else timeout_sec)
        rec = self.jobs[job["job_id"]]
        # mark worker idle again (safe pass)
        for (m,g) in list(self.worker_busy.keys()):
            if m == model:
                self.worker_busy[(m,g)] = False
        self._dispatch_next(model)
        return {"status": rec["status"], "result": rec.get("result"), "error": rec.get("error")}

    def status(self) -> Dict[str, Any]:
        with self.lock:
            running = {}
            for (m, g), info in self.workers.items():
                running[f"{m}@gpu{g}"] = {"model": m, "gpu_id": g, "pid": info["pid"],
                                          "alive": info["proc"].is_alive(),
                                          "busy": self.worker_busy.get((m, g), False)}
            queues = {m: len(q) for m, q in self.model_queues.items()}
            return {"gpu_count": self.gpu_count, "max_workers": self.max_workers,
                    "running": running, "queues": queues}

# ---------------- FastAPI app ----------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
app = FastAPI(title="vLLM Pool (per-GPU SSE tails)", version="0.7.0")
POOL = PoolManager(max_workers=4)

DEFAULT_CFG = {
    "gpu_memory_utilization": 0.92,
    "max_model_len": 1024,
    "max_num_seqs": 512,
    "max_num_batched_tokens": 8192,
    "block_size": 16,
    "tensor_parallel_size": 1,
    "dtype": "auto",
    "trust_remote_code": True,
    "disable_log_stats": True,
    "max_parallel_loading_workers": 2,
}
DEFAULT_CFG_STR = json.dumps(DEFAULT_CFG, indent=2)

@app.post("/start", response_model=StartResponse)
def start_worker(req: StartRequest):
    cfg = req.config or DEFAULT_CFG
    try:
        model, gpu, pid = POOL.start(req.model_name, cfg, req.gpu_id)
        return StartResponse(model_name=model, gpu_id=gpu, pid=pid, status="ready")
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start: {e}")

@app.post("/stop")
def stop(model_name: str = Form(...), gpu_id: int = Form(...)):
    try:
        st = POOL.stop_worker(model_name, gpu_id)
        return {"model_name": model_name, "gpu_id": gpu_id, "status": st}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))

@app.get("/status")
def status():
    return POOL.status()

@app.get("/models")
def models():
    return {"models": POOL.list_models()}

@app.get("/workers")
def workers():
    return {"workers": POOL.list_workers()}

@app.post("/generate/simple")
def generate_simple(req: GenerateSimpleRequest):
    job_id = str(uuid.uuid4())[:8]
    job = {"job_id": job_id, "model_name": req.model_name,
           "cmd": {"type": "generate_simple", "prompts": req.prompts, "sampling": req.sampling.dict()}}
    try:
        result = POOL.submit_and_wait(job)
        if result["status"] == "done":
            return JSONResponse({"job_id": job_id, "result": result["result"]})
        raise HTTPException(status_code=500, detail=result.get("error", "Unknown error"))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate: {e}")

@app.post("/generate/chat")
def generate_chat(req: GenerateChatRequest):
    job_id = str(uuid.uuid4())[:8]
    prompts = [{"messages": [m.dict() for m in item.messages], "metadata": (item.metadata or {})} for item in req.prompts]
    job = {"job_id": job_id, "model_name": req.model_name,
           "cmd": {"type": "generate_chat", "prompts": prompts,
                   "sampling": req.sampling.dict(), "output_field": req.output_field}}
    try:
        result = POOL.submit_and_wait(job)
        if result["status"] == "done":
            return JSONResponse({"job_id": job_id, "result": result["result"]})
        raise HTTPException(status_code=500, detail=result.get("error", "Unknown error"))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate: {e}")

# ---- SSE: per-worker tails ----
@app.get("/events/worker/{key:path}")
def sse_worker(key: str, request: Request):
    q = POOL.subscribe_worker(key)
    def gen() -> Generator[bytes, None, None]:
        yield b"event: hello\ndata: {}\n\n"
        while True:
            if request.client is None:
                break
            try:
                ev = q.get(timeout=1.0)
                payload = json.dumps(ev)
                # replace panel with the last 4-5 lines the worker sent
                yield f"event: tail\ndata: {payload}\n\n".encode("utf-8")
            except Exception:
                yield b": keep-alive\n\n"
        yield b"event: bye\ndata: {}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")

# ------------------- UI -------------------
INDEX_HTML = r"""
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>vLLM Manager</title>
  <style>
    :root { --pad:16px; }
    body { font-family: ui-sans-serif, system-ui; margin:20px; }
    h1 { margin: 0 0 8px 0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto auto auto; gap: 16px; }
    .card { border:1px solid #ddd; border-radius:12px; padding:var(--pad); box-shadow:0 2px 8px rgba(0,0,0,0.05); }
    .muted { color:#666; }
    .mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
    input, select, textarea, button { padding:8px; border-radius:8px; border:1px solid #bbb; }
    button { cursor:pointer; }
    #generate, #results { grid-column: 1 / span 2; }
    .row { display:flex; gap:12px; align-items:flex-start; flex-wrap:wrap; }
    .stack > * { display:block; margin-top:8px; }
    .fieldset { border:1px dashed #ccc; border-radius:8px; padding:10px; }
    #resultBox { height: 420px; overflow:auto; white-space:pre-wrap; background:#fafafa; padding:10px; border-radius:8px; border:1px solid #eee; }
    #progressBox { height: 160px; overflow:auto; white-space:pre; background:#0b1020; color:#d6f0ff; padding:10px; border-radius:8px; border:1px solid #223; }
    .tabbar { display:flex; gap:8px; border-bottom:1px solid #eee; margin-bottom:12px; }
    .tabbar button { border-bottom-left-radius:0; border-bottom-right-radius:0; }
    .tab-active { background:#111; color:#fff; }
    .ok { color:#0a7; } .err{ color:#c22; }
  </style>
</head>
<body>
  <h1>vLLM Manager</h1>
  <p class="muted">Start/stop models above. Generate uses loaded models. Right panel shows <b>per-GPU live tail</b> (tqdm every ~2s).</p>

  <div class="grid">
    <!-- Start Model -->
    <div class="card" id="start">
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

    <!-- Status / Live GPU tails -->
    <div class="card" id="stat">
      <h3>Status & Live GPU log</h3>
      <div class="row">
        <button onclick="refresh()">Refresh</button>
        <select id="workerSel" onchange="switchWorker()"></select>
      </div>
      <pre id="status" class="mono" style="white-space:pre-wrap; background:#fafafa; padding:10px; border-radius:8px; border:1px solid #eee; max-height:220px; overflow:auto;"></pre>
      <div style="margin-top:8px;">
        <label class="muted">Live tail (last ~5 lines for selected worker)</label>
        <pre id="progressBox" class="mono"></pre>
      </div>
    </div>

    <!-- Generate -->
    <div class="card" id="generate">
      <div class="tabbar">
        <button id="tabSimple" class="tab-active" onclick="switchTab('simple')">Generate: Simple</button>
        <button id="tabChat" onclick="switchTab('chat')">Generate: Chat</button>
      </div>

      <!-- SIMPLE (2 columns of vertical couples) -->
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
              <label><b>OR Upload prompts JSON</b> (array of strings)</label><br>
              <input id="g_file" type="file" accept=".json"/>
              <div style="margin-top:8px;"><button onclick="submitSimple()">Generate</button> <span id="g_msg" class="muted"></span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- CHAT (3 columns of vertical couples) -->
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
              <label><b>OR Upload chat JSON file</b> (array of chat items)</label><br>
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

    <!-- Results -->
    <div class="card" id="results">
      <h3>Response</h3>
      <div class="row">
        <button onclick="saveJSON()">Save as JSON</button>
        <button onclick="clearResults()">Clear</button>
        <span class="muted">Large outputs will appear below and can be saved.</span>
      </div>
      <pre id="resultBox" class="mono"></pre>
    </div>
  </div>

<script>
let lastResult = null;
let evtSource = null;

function parseJSONSafe(text, fallback) {
  if (!text || !text.trim()) return fallback;
  try { return JSON.parse(text); } catch(e) { throw new Error("Invalid JSON: " + e.message); }
}

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

function setWorkerOptions(workers) {
  const sel = document.getElementById('workerSel');
  sel.innerHTML = "";
  if (!workers.length) { const o = document.createElement('option'); o.value=""; o.textContent="— no workers —"; sel.appendChild(o); return; }
  for (const w of workers) {
    const o = document.createElement('option');
    o.value = w.key;
    o.textContent = `gpu ${w.gpu_id} — ${w.model}`;
    sel.appendChild(o);
  }
  // auto-connect to first worker
  switchWorker();
}

function switchWorker() {
  const sel = document.getElementById('workerSel');
  const key = sel.value;
  if (!key) { closeSSE(); document.getElementById('progressBox').textContent = ''; return; }
  openSSE(`/events/worker/${encodeURIComponent(key)}`);
}

function closeSSE(){ if (evtSource){ try{ evtSource.close(); }catch(_){} evtSource=null; } }
function openSSE(url) {
  closeSSE();
  evtSource = new EventSource(url);
  evtSource.addEventListener('tail', (ev) => {
    try {
      const obj = JSON.parse(ev.data);
      const lines = (obj.lines || []).slice(-5);
      document.getElementById('progressBox').textContent = lines.join("\\n");
    } catch { /* ignore */ }
  });
  evtSource.addEventListener('bye', () => {});
  evtSource.onerror = () => {};
}

async function refreshModelsDropdowns() {
  try {
    const res = await fetch('/models'); const j = await res.json();
    const fill = (id) => {
      const sel = document.getElementById(id); sel.innerHTML = "";
      const arr = j.models || [];
      if (!arr.length) { const o=document.createElement('option'); o.value=""; o.textContent="— no models loaded —"; sel.appendChild(o); return; }
      for (const m of arr) { const o=document.createElement('option'); o.value=m; o.textContent=m; sel.appendChild(o); }
    };
    fill('g_model'); fill('c_model');
  } catch(e){}
}

async function refreshWorkersDropdown() {
  try {
    const res = await fetch('/workers'); const j = await res.json();
    setWorkerOptions(j.workers || []);
  } catch(e){}
}

async function refresh() {
  const el = document.getElementById('status'); el.textContent = '...';
  try { const res = await fetch('/status'); el.textContent = JSON.stringify(await res.json(), null, 2); }
  catch (e) { el.textContent = e.message; }
  refreshModelsDropdowns();
  refreshWorkersDropdown();
}

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
  try {
    const res = await fetch('/stop', { method:'POST', body: form });
    const j = await res.json(); if (!res.ok) throw new Error(j.detail || JSON.stringify(j));
    document.getElementById('start_msg').innerHTML = `<span class="ok">${j.status}</span>`;
    refresh();
  } catch (e2) {
    document.getElementById('start_msg').innerHTML = `<span class="err">${e2.message}</span>`;
  }
}

async function readFileAsJSON(inputEl) { const f = inputEl.files && inputEl.files[0]; if (!f) return null; return JSON.parse(await f.text()); }

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

refresh();  // loads status, models, workers, and connects SSE to first worker if any
</script>
</body>
</html>
"""

@app.get("/", response_class=HTMLResponse)
def index():
    return HTMLResponse(INDEX_HTML.replace("__DEFAULT_CFG__", DEFAULT_CFG_STR))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
