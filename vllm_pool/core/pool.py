from __future__ import annotations
import time, threading, uuid, multiprocessing as mp
from typing import Dict, Any, Tuple, Optional, List
import torch
from .worker import worker_loop

# NEW
from collections import deque
from time import monotonic

JOB_TTL_SEC = 3600          # keep finished jobs for 1 hour
JOB_MAX_KEEP = 2000         # cap total tracked jobs


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

        # NEW: cleanup helpers and options
        self._job_order = deque()     # job_ids in creation order
        self.auto_respawn = False     # scaffold; no config stash yet

        self.worker_subs: Dict[str, List[mp.Queue]] = {}  # key -> subscribers
        self._start_reader_threads: Dict[Tuple[str,int], threading.Thread] = {}

        # NEW: watchdog monitors worker liveness
        threading.Thread(target=self._watchdog_loop, daemon=True).start()

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
            try:
                q.put({"lines": lines}, block=False)
            except Exception:
                pass

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
                if not proc.is_alive():
                    break
                continue
            if msg.get("type") == "ready":
                pid = msg.get("pid", proc.pid)
                break
            if msg.get("type") == "error":
                err = msg.get("error")
                break

        if not pid:
            proc.terminate()
            proc.join(timeout=1.0)
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
                    rec["status"] = "done"
                    rec["result"] = msg.get("result")
                    rec["done_at"] = monotonic()
                    rec["event"].set()
                self.busy[(model, gpu_id)] = False
                self._dispatch_next(model)
                self._maybe_cleanup_jobs()
            elif typ == "error":
                job_id = msg.get("job_id")
                rec = self.jobs.get(job_id)
                if rec:
                    rec["status"] = "error"
                    rec["error"] = msg.get("error", "unknown")
                    rec["done_at"] = monotonic()
                    rec["event"].set()
                self.busy[(model, gpu_id)] = False
                self._dispatch_next(model)
                self._maybe_cleanup_jobs()
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
                self._dispatch_next(model)
                return model, gid, existing["pid"]
            info = self._spawn_worker(model, cfg, gid)
            self._dispatch_next(model)
            return model, gid, info["pid"]

    def stop(self, model: str, gpu_id: int) -> str:
        with self.lock:
            info = self.workers.get((model, gpu_id))
            if not info:
                raise KeyError("No such worker")
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
        if not queue:
            return
        idle = next(((m, g) for (m, g), busy in self.busy.items() if m == model and not busy), None)
        if not idle:
            return
        _, gpu = idle
        job = queue.pop(0)
        self._send(job, gpu)

    def _send(self, job: Dict[str, Any], gpu_id: int):
        info = self.workers[(job["model_name"], gpu_id)]
        self.busy[(job["model_name"], gpu_id)] = True
        rec = self.jobs.get(job["job_id"])
        if rec:
            rec["status"] = "running"
        cmd = job["cmd"]
        cmd["job_id"] = job["job_id"]
        info["cmd_q"].put(cmd)

    # Non-blocking submit
    def submit(self, job: Dict[str, Any]) -> str:
        model = job["model_name"]
        with self.lock:
            if all(m != model for (m, _) in self.workers.keys()):
                raise RuntimeError("Model not loaded.")
            ev = threading.Event()
            job_id = job.get("job_id") or str(uuid.uuid4())[:8]
            job["job_id"] = job_id
            rec = {"status": "queued", "result": None, "error": None, "event": ev, "created_at": monotonic()}
            self.jobs[job_id] = rec
            self._job_order.append(job_id)
            self._ensure_queue(model)
            self.queues[model].append(job)
            # try dispatch immediately
            self._dispatch_next(model)
            self._maybe_cleanup_jobs()
            return job_id

    def submit_offline(self, job: Dict[str, Any]) -> str:
        model = job["model_name"]
        with self.lock:
            ev = threading.Event()
            job_id = job.get("job_id") or str(uuid.uuid4())[:8]
            job["job_id"] = job_id
            rec = {
                "status": "queued_offline",
                "result": None,
                "error": None,
                "event": ev,
                "created_at": monotonic(),
            }
            self.jobs[job_id] = rec
            self._job_order.append(job_id)
            self._ensure_queue(model)
            self.queues[model].append(job)
            self._dispatch_next(model)
            self._maybe_cleanup_jobs()
            return job_id

    # Blocking submit (kept for compatibility; unused by API)
    def submit_and_wait(self, job: Dict[str, Any], timeout_sec: Optional[int] = None) -> Dict[str, Any]:
        model = job["model_name"]
        with self.lock:
            if all(m != model for (m, _) in self.workers.keys()):
                raise RuntimeError("Model not loaded.")
            ev = threading.Event()
            job_id = job.get("job_id") or str(uuid.uuid4())[:8]
            job["job_id"] = job_id
            self.jobs[job_id] = {"status": "queued", "result": None, "error": None, "event": ev, "created_at": monotonic()}
            self._job_order.append(job_id)
            self._ensure_queue(model)
            self.queues[model].append(job)
            self._dispatch_next(model)

        ev.wait(timeout=timeout_sec)
        rec = self.jobs[job_id]
        return {"status": rec["status"], "result": rec.get("result"), "error": rec.get("error")}

    def get_job(self, job_id: str) -> Dict[str, Any]:
        rec = self.jobs.get(job_id)
        if not rec:
            return {"job_id": job_id, "status": "not_found"}
        view = {"job_id": job_id, "status": rec["status"]}
        if rec["status"] == "done":
            view["result"] = rec["result"]
        if rec["status"] == "error":
            view["error"] = rec["error"]
        return view

    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        with self.lock:
            rec = self.jobs.get(job_id)
            if not rec:
                return {"job_id": job_id, "status": "not_found"}
            if rec["status"] != "queued":
                return {"job_id": job_id, "status": rec["status"], "detail": "cannot-cancel-inflight"}
            # Remove from its model queue
            for model, queue in self.queues.items():
                idx = next((i for i, j in enumerate(queue) if j.get("job_id") == job_id), None)
                if idx is not None:
                    queue.pop(idx)
                    break
            rec["status"] = "canceled"
            rec["done_at"] = monotonic()
            self._maybe_cleanup_jobs()
            return {"job_id": job_id, "status": "canceled"}

    # ---- inspection
    def status(self) -> Dict[str, Any]:
        running = {}
        for (m, g), info in self.workers.items():
            running[f"{m}@gpu{g}"] = {
                "model": m,
                "gpu_id": g,
                "pid": info["pid"],
                "alive": info["proc"].is_alive(),
                "busy": self.busy.get((m, g), False),
            }
        queues = {m: len(q) for m, q in self.queues.items()}
        return {"gpu_count": self.gpu_count, "max_workers": self.max_workers, "running": running, "queues": queues}

    # ---- job cleanup helpers
    def _maybe_cleanup_jobs(self):
        now = monotonic()
        # TTL / size-based eviction
        while self._job_order:
            jid = self._job_order[0]
            rec = self.jobs.get(jid)
            if not rec:
                self._job_order.popleft()
                continue
            done_at = rec.get("done_at")
            if done_at is None:
                break
            if (now - done_at < JOB_TTL_SEC) and (len(self._job_order) <= JOB_MAX_KEEP):
                break
            self._job_order.popleft()
            self.jobs.pop(jid, None)

    # ---- worker watchdog
    def _watchdog_loop(self):
        while True:
            time.sleep(2.0)
            with self.lock:
                dead: List[Tuple[str, int]] = []
                for (m, g), info in list(self.workers.items()):
                    if not info["proc"].is_alive():
                        dead.append((m, g))
                for (m, g) in dead:
                    key = self.key(m, g)
                    self._broadcast_tail(key, ["[watchdog] worker died; cleaning up"])
                    self.busy.pop((m, g), None)
                    self.workers.pop((m, g), None)
                    # Leave queues so jobs remain; optional auto-respawn could go here
                    if self.auto_respawn:
                        # No stored cfg to respawn with in this minimal version.
                        # Hook for future enhancement.
                        pass
