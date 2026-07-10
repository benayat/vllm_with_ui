from __future__ import annotations

import curses
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from queue import Empty
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

from .core.config import DEFAULT_CFG
from .core.types import LLMResourceConfig, SamplingConfig
from .core.ui_state_store import UIStateStore
from .utils.logging import setup_logging

if TYPE_CHECKING:
    from .core.pool import PoolManager


JsonValue = Any


class TerminalUI:
    """Curses UI for running vLLM Pool directly on a compute node."""

    def __init__(self, stdscr: curses.window, pool: Optional["PoolManager"] = None, store: Optional[UIStateStore] = None):
        from .core.pool import PoolManager

        self.stdscr = stdscr
        self.pool = pool or PoolManager(max_workers=int(os.getenv("VLLM_POOL_MAX_WORKERS", "4")))
        self.store = store or UIStateStore()
        self.model_name = os.getenv("VLLM_TUI_MODEL", "")
        self.gpu_id = os.getenv("VLLM_TUI_GPU", "")
        self.config: Dict[str, Any] = DEFAULT_CFG.to_vllm_kwargs()
        self.sampling: Dict[str, Any] = SamplingConfig().__dict__.copy()
        self.simple_prompts: List[Dict[str, Any]] = [{"prompt": "Hello", "metadata": {"id": "1"}}]
        self.chat_prompts: List[Dict[str, Any]] = [
            {"messages": [{"role": "user", "content": "Hello"}], "metadata": {"id": "1"}}
        ]
        self.pre_processor: Optional[Dict[str, Any]] = None
        self.post_processor: Optional[Dict[str, Any]] = None
        self.include_metadata = True
        self.output_field = "output"
        self.cleanup_model_after_job = False
        self.message = "Ready. Press ? for help."
        self.last_result: Optional[Dict[str, Any]] = None
        self.tail_key: Optional[str] = None
        self.tail_queue = None
        self.tail_lines: List[str] = []

    def run(self) -> None:
        curses.curs_set(0)
        self.stdscr.nodelay(False)
        self.stdscr.timeout(1000)
        self.stdscr.keypad(True)
        while True:
            self.draw()
            ch = self.stdscr.getch()
            if ch in (ord("q"), ord("Q")):
                return
            self.handle_key(ch)

    def draw(self) -> None:
        self._drain_tail()
        self.stdscr.erase()
        height, width = self.stdscr.getmaxyx()
        self._line(0, 0, "vLLM Pool Terminal UI", curses.A_BOLD)
        self._line(1, 0, "Start/stop models, inspect status, submit simple/chat/offline jobs, manage presets, and watch tails.")
        status = self.pool.status()
        left_width = max(38, width // 2 - 1)
        self._box(3, 0, min(height - 7, 12), left_width, "Model")
        self._line(4, 2, f"Model: {self.model_name or '<unset>'}")
        self._line(5, 2, f"GPU: {self.gpu_id or '<auto>'}")
        self._line(6, 2, f"Include metadata: {self.include_metadata}")
        self._line(7, 2, f"Output field: {self.output_field}")
        self._line(8, 2, f"Cleanup after offline job: {self.cleanup_model_after_job}")
        self._line(9, 2, f"Pre-processor: {'set' if self.pre_processor else 'none'}")
        self._line(10, 2, f"Post-processor: {'set' if self.post_processor else 'none'}")

        self._box(3, left_width + 1, min(height - 7, 12), width - left_width - 1, "Status")
        self._line(4, left_width + 3, f"GPUs: {status.get('gpu_count')}  Max workers: {status.get('max_workers')}")
        row = 5
        for name, info in list(status.get("running", {}).items())[:5]:
            self._line(row, left_width + 3, f"{name} pid={info['pid']} alive={info['alive']} busy={info['busy']}")
            row += 1
        self._line(row, left_width + 3, f"Queues: {status.get('queues')}")

        tail_top = 16
        self._box(tail_top, 0, max(5, height - tail_top - 4), width, f"Tail {self.tail_key or '<none selected>'}")
        for idx, line in enumerate(self.tail_lines[-max(1, height - tail_top - 6):]):
            self._line(tail_top + 1 + idx, 2, line[: width - 4])

        help_text = "Keys: m model | g gpu | c config | s start | x stop | y tail | 1 simple | 2 chat | o offline | p processors | b banks | r result | ? help | q quit"
        self._line(height - 3, 0, help_text[: width - 1], curses.A_REVERSE)
        self._line(height - 2, 0, self.message[: width - 1])
        self.stdscr.refresh()

    def handle_key(self, ch: int) -> None:
        actions: Dict[int, Callable[[], None]] = {
            ord("?"): self.show_help,
            ord("m"): self.set_model,
            ord("g"): self.set_gpu,
            ord("c"): self.edit_config,
            ord("s"): self.start_model,
            ord("x"): self.stop_model,
            ord("y"): self.select_tail,
            ord("1"): self.submit_simple,
            ord("2"): self.submit_chat,
            ord("o"): self.submit_offline,
            ord("p"): self.processor_menu,
            ord("b"): self.bank_menu,
            ord("r"): self.result_menu,
        }
        action = actions.get(ch)
        if action:
            try:
                action()
            except Exception as exc:
                self.message = f"Error: {exc}"

    def prompt(self, label: str, default: str = "") -> str:
        curses.echo()
        self.stdscr.nodelay(False)
        height, width = self.stdscr.getmaxyx()
        self._line(height - 1, 0, " " * (width - 1))
        self._line(height - 1, 0, f"{label} [{default}]: ")
        self.stdscr.refresh()
        raw = self.stdscr.getstr(height - 1, min(width - 2, len(label) + len(default) + 5), max(1, width - 30))
        curses.noecho()
        value = raw.decode("utf-8").strip()
        return value or default

    def edit_json(self, title: str, value: JsonValue) -> JsonValue:
        initial = json.dumps(value, indent=2, ensure_ascii=False)
        return self._edit_text(title, initial, parse_json=True)

    def _edit_text(self, title: str, value: str, parse_json: bool = False) -> JsonValue:
        editor = os.getenv("EDITOR", "nano")
        with tempfile.NamedTemporaryFile("w+", suffix=".json" if parse_json else ".txt", delete=False) as tmp:
            tmp.write(value)
            path = tmp.name
        curses.def_prog_mode()
        curses.endwin()
        try:
            subprocess.run([editor, path], check=False)
        finally:
            curses.reset_prog_mode()
            self.stdscr.keypad(True)
        text = Path(path).read_text(encoding="utf-8")
        Path(path).unlink(missing_ok=True)
        if parse_json:
            try:
                return json.loads(text)
            except json.JSONDecodeError as exc:
                self.message = f"Invalid JSON in {title}: {exc}"
                return value
        return text

    def choose(self, title: str, items: List[str]) -> Optional[int]:
        if not items:
            self.message = f"No items for {title}."
            return None
        idx = 0
        while True:
            self.stdscr.erase()
            self._line(0, 0, title, curses.A_BOLD)
            for row, item in enumerate(items[: curses.LINES - 3], start=2):
                attr = curses.A_REVERSE if row - 2 == idx else curses.A_NORMAL
                self._line(row, 2, item, attr)
            ch = self.stdscr.getch()
            if ch in (27, ord("q")):
                return None
            if ch in (curses.KEY_UP, ord("k")):
                idx = max(0, idx - 1)
            elif ch in (curses.KEY_DOWN, ord("j")):
                idx = min(len(items) - 1, idx + 1)
            elif ch in (10, 13):
                return idx

    def set_model(self) -> None:
        models = self.pool.list_models()
        entered = self.prompt("Model name", self.model_name)
        self.model_name = entered
        if not entered and models:
            choice = self.choose("Loaded models", models)
            if choice is not None:
                self.model_name = models[choice]

    def set_gpu(self) -> None:
        self.gpu_id = self.prompt("GPU id (blank for auto)", self.gpu_id)

    def edit_config(self) -> None:
        updated = self.edit_json("vLLM config", self.config)
        LLMResourceConfig(**updated)
        self.config = updated
        self.message = "Updated vLLM config."

    def start_model(self) -> None:
        if not self.model_name:
            self.set_model()
        gpu = int(self.gpu_id) if self.gpu_id.strip() else None
        model, gid, pid = self.pool.start(self.model_name, self.config, gpu)
        self.message = f"Started {model} on GPU {gid} (pid {pid})."

    def stop_model(self) -> None:
        if not self.model_name:
            self.set_model()
        gpu = int(self.prompt("GPU id to stop", self.gpu_id or "0"))
        status = self.pool.stop(self.model_name, gpu)
        self.message = f"Stopped {self.model_name} on GPU {gpu}: {status}."

    def select_tail(self) -> None:
        workers = self.pool.list_workers()
        labels = [w["key"] for w in workers]
        choice = self.choose("Select worker tail", labels)
        if choice is None:
            return
        self.tail_key = labels[choice]
        self.tail_queue = self.pool.subscribe_worker(self.tail_key)
        self.tail_lines = ["Subscribed. Waiting for worker tail updates..."]

    def submit_simple(self) -> None:
        self.simple_prompts = self.edit_json("simple prompts", self.simple_prompts)
        self.sampling = self.edit_json("sampling", self.sampling)
        self._validate_model_selected()
        job = {
            "job_id": None,
            "model_name": self.model_name,
            "cmd": {
                "type": "generate_simple",
                "prompts": self.simple_prompts,
                "sampling": self._sampling_dict(),
                "include_metadata": self.include_metadata,
                "pre_processor": self.pre_processor,
                "post_processor": self.post_processor,
            },
        }
        jid = self.pool.submit(job)
        self._wait_for_job(jid)

    def submit_chat(self) -> None:
        self.chat_prompts = self.edit_json("chat prompts", self.chat_prompts)
        self.sampling = self.edit_json("sampling", self.sampling)
        self.output_field = self.prompt("Output field", self.output_field)
        self._validate_model_selected()
        job = {
            "job_id": None,
            "model_name": self.model_name,
            "cmd": {
                "type": "generate_chat",
                "prompts": self.chat_prompts,
                "sampling": self._sampling_dict(),
                "output_field": self.output_field,
                "include_metadata": self.include_metadata,
                "pre_processor": self.pre_processor,
                "post_processor": self.post_processor,
            },
        }
        jid = self.pool.submit(job)
        self._wait_for_job(jid)

    def submit_offline(self) -> None:
        kind = self.prompt("Offline type (generate/chat)", "generate")
        prompts = self.simple_prompts if kind == "generate" else self.chat_prompts
        prompts = self.edit_json("offline prompts", prompts)
        self.sampling = self.edit_json("sampling", self.sampling)
        self._validate_model_selected()
        cmd_type = "generate_simple" if kind == "generate" else "generate_chat"
        cmd = {
            "type": cmd_type,
            "prompts": prompts,
            "sampling": self._sampling_dict(),
            "include_metadata": self.include_metadata,
            "pre_processor": self.pre_processor,
            "post_processor": self.post_processor,
        }
        if kind == "chat":
            cmd["output_field"] = self.output_field
        jid = self.pool.submit_offline({
            "job_id": None,
            "model_name": self.model_name,
            "cmd": cmd,
            "cleanup_model_after_job": self.cleanup_model_after_job,
        })
        self.message = f"Offline job queued: {jid}."

    def processor_menu(self) -> None:
        items = ["Edit pre-processor", "Edit post-processor", "Clear pre-processor", "Clear post-processor", "Toggle include metadata", "Toggle cleanup after offline job"]
        choice = self.choose("Processors and options", items)
        if choice == 0:
            self.pre_processor = self.edit_json("pre-processor", self.pre_processor or {"name": "python_script", "config": {}})
        elif choice == 1:
            self.post_processor = self.edit_json("post-processor", self.post_processor or {"name": "python_script", "config": {}})
        elif choice == 2:
            self.pre_processor = None
        elif choice == 3:
            self.post_processor = None
        elif choice == 4:
            self.include_metadata = not self.include_metadata
        elif choice == 5:
            self.cleanup_model_after_job = not self.cleanup_model_after_job

    def bank_menu(self) -> None:
        state = self.store.get_all()
        choice = self.choose("State banks", ["Edit processor presets", "Edit simple prompt bank", "Edit chat prompt bank", "Edit simple sampling bank", "Edit chat sampling bank"])
        mapping = [
            ("processor_presets", None),
            ("prompt_bank", "simple"),
            ("prompt_bank", "chat"),
            ("sampling_bank", "simple"),
            ("sampling_bank", "chat"),
        ]
        if choice is None:
            return
        section, key = mapping[choice]
        value = state[section] if key is None else state[section].get(key, [])
        updated = self.edit_json("bank", value)
        if key is None:
            self.store.set_section(section, updated)
        else:
            bank = state[section]
            bank[key] = updated
            self.store.set_section(section, bank)
        self.message = "Saved bank state."

    def result_menu(self) -> None:
        if not self.last_result:
            self.message = "No result yet."
            return
        choice = self.choose("Result", ["View/edit result JSON", "Save result JSON"])
        if choice == 0:
            self.edit_json("result", self.last_result)
        elif choice == 1:
            path = self.prompt("Save path", "result.json")
            Path(path).write_text(json.dumps(self.last_result, indent=2, ensure_ascii=False), encoding="utf-8")
            self.message = f"Saved result to {path}."

    def show_help(self) -> None:
        text = [
            "Terminal UI capabilities:",
            "- Start and stop vLLM workers with editable resource JSON.",
            "- Inspect GPU, worker, busy, queue, and job status.",
            "- Subscribe to per-worker live tails.",
            "- Submit simple, chat, and offline generation jobs.",
            "- Configure sampling, output field, metadata, cleanup, pre/post-processors.",
            "- Edit server-side processor, prompt, and sampling banks.",
            "- Save final result JSON.",
            "",
            "JSON fields open in $EDITOR (defaults to nano). Press any key to return.",
        ]
        self.stdscr.erase()
        for row, line in enumerate(text):
            self._line(row, 0, line)
        self.stdscr.getch()

    def _wait_for_job(self, jid: str) -> None:
        while True:
            rec = self.pool.get_job(jid)
            self.message = f"Job {jid}: {rec.get('status')}"
            self.draw()
            if rec.get("status") in {"done", "error", "not_found"}:
                self.last_result = rec
                return
            time.sleep(0.5)

    def _validate_model_selected(self) -> None:
        if not self.model_name:
            raise ValueError("Model name is required.")

    def _sampling_dict(self) -> Dict[str, Any]:
        sampling = SamplingConfig(**self.sampling)
        return sampling.__dict__.copy()

    def _drain_tail(self) -> None:
        if self.tail_queue is None:
            return
        while True:
            try:
                msg = self.tail_queue.get_nowait()
            except Empty:
                break
            except Exception:
                break
            self.tail_lines = msg.get("lines", self.tail_lines)

    def _line(self, y: int, x: int, text: str, attr: int = curses.A_NORMAL) -> None:
        try:
            self.stdscr.addstr(y, x, text, attr)
        except curses.error:
            pass

    def _box(self, y: int, x: int, h: int, w: int, title: str) -> None:
        try:
            win = self.stdscr.derwin(h, w, y, x)
            win.box()
            win.addstr(0, 2, f" {title} ", curses.A_BOLD)
        except curses.error:
            pass


def main() -> None:
    setup_logging()
    curses.wrapper(lambda stdscr: TerminalUI(stdscr).run())


if __name__ == "__main__":
    main()
