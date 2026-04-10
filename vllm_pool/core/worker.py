from __future__ import annotations
import os, sys, threading, multiprocessing as mp, time
from typing import Dict, Any, List
from .types import LLMResourceConfig, SamplingConfig
from .llm_client import LLMClient
from .post_processor import PostProcessorManager, PostProcessorError

class TailCapture:
    """Capture CR/newline output (tqdm, logs). Keep a rolling tail."""
    def __init__(self, max_keep: int = 200):
        from collections import deque
        self.lock = threading.Lock()
        self.buf = ""
        self.lines = deque(maxlen=max_keep)
        self._fallback_stream = sys.__stdout__

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

def worker_loop(cmd_q: mp.Queue, res_q: mp.Queue, model_name: str, cfg_dict: Dict[str, Any], gpu_id: int):
    os.environ["CUDA_VISIBLE_DEVICES"] = str(gpu_id)

    tap = TailCapture()
    orig_out, orig_err = sys.stdout, sys.stderr
    sys.stdout = tap
    sys.stderr = tap

    try:
        res_cfg = LLMResourceConfig(**cfg_dict)
        client = LLMClient(model_name, res_cfg)
        post_processor = PostProcessorManager()
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
                    generation_out = client.generate_simple(
                        msg["prompts"],
                        sc,
                        include_metadata=msg.get("include_metadata", True),
                    )
                    result_payload: Any = generation_out
                    pp_spec = msg.get("post_processor")
                    if pp_spec:
                        try:
                            pp_out = post_processor.execute(generation_out, pp_spec)
                            result_payload = {"generation": generation_out, "post_processing": pp_out}
                        except PostProcessorError as e:
                            if pp_spec.get("on_error", "fail") == "continue":
                                result_payload = {
                                    "generation": generation_out,
                                    "post_processing": {"status": "error", "name": pp_spec.get("name"), "error": str(e)},
                                }
                            else:
                                raise
                    res_q.put({"type": "result", "job_id": msg["job_id"], "result": result_payload})
                except Exception as e:
                    res_q.put({"type": "error", "job_id": msg["job_id"], "error": str(e)})
                continue

            if kind == "generate_chat":
                try:
                    sc = SamplingConfig(**msg["sampling"])
                    generation_out = client.generate_chat(
                        msg["prompts"],
                        sc,
                        output_field=msg.get("output_field", "output"),
                        include_metadata=msg.get("include_metadata", True),
                    )
                    result_payload: Any = generation_out
                    pp_spec = msg.get("post_processor")
                    if pp_spec:
                        try:
                            pp_out = post_processor.execute(generation_out, pp_spec)
                            result_payload = {"generation": generation_out, "post_processing": pp_out}
                        except PostProcessorError as e:
                            if pp_spec.get("on_error", "fail") == "continue":
                                result_payload = {
                                    "generation": generation_out,
                                    "post_processing": {"status": "error", "name": pp_spec.get("name"), "error": str(e)},
                                }
                            else:
                                raise
                    res_q.put({"type": "result", "job_id": msg["job_id"], "result": result_payload})
                except Exception as e:
                    res_q.put({"type": "error", "job_id": msg["job_id"], "error": str(e)})
                continue

            res_q.put({"type": "error", "error": f"Unknown command {kind}"})
    finally:
        sys.stdout, sys.stderr = orig_out, orig_err
        try: client.close()
        except Exception: pass
