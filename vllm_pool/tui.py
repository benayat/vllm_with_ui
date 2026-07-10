from __future__ import annotations

import curses
import json
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from queue import Empty
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from .core.config import DEFAULT_CFG
from .core.types import LLMResourceConfig, SamplingConfig
from .core.ui_state_store import UIStateStore
from .utils.logging import setup_logging

if TYPE_CHECKING:
    from .core.pool import PoolManager

JsonValue = Any


class FileSelectionCanceled(Exception):
    """Internal control flow for leaving the file browser without an error."""


@dataclass(frozen=True)
class Command:
    key: str
    label: str
    handler: str
    group: str


COMMANDS: List[Command] = [
    Command("m", "Set model", "set_model", "Model"),
    Command("g", "Set GPU", "set_gpu", "Model"),
    Command("c", "Edit vLLM config", "edit_config", "Model"),
    Command("s", "Start worker", "start_model", "Model"),
    Command("x", "Stop worker", "stop_model", "Model"),
    Command("t", "Select live tail", "select_tail", "Observe"),
    Command("u", "Refresh status", "refresh_status", "Observe"),
    Command("j", "Jobs", "job_menu", "Observe"),
    Command("1", "Submit simple job", "submit_simple", "Generate"),
    Command("2", "Submit chat job", "submit_chat", "Generate"),
    Command("o", "Submit offline job", "submit_offline", "Generate"),
    Command("a", "Generation options", "generation_options", "Generate"),
    Command("f", "Load prompts from file", "load_prompts_menu", "Generate"),
    Command("p", "Processors", "processor_menu", "Processors"),
    Command("b", "Prompt/sampling banks", "bank_menu", "Banks"),
    Command("r", "Result", "result_menu", "Result"),
    Command("?", "Help", "show_help", "Help"),
]


class TerminalUI:
    """Curses UI for operating vLLM Pool directly on a compute node."""

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

        self.message = "Ready. Press ? for help or Enter for commands."
        self.last_result: Optional[Dict[str, Any]] = None
        self.tail_key: Optional[str] = None
        self.tail_queue = None
        self.tail_lines: List[str] = []
        self.cached_status: Dict[str, Any] = {}

    def run(self) -> None:
        curses.curs_set(0)
        self.stdscr.nodelay(False)
        self.stdscr.timeout(1000)
        self.stdscr.keypad(True)
        self.refresh_status()
        while True:
            self.draw()
            ch = self.stdscr.getch()
            if ch in (ord("q"), ord("Q")):
                return
            if ch in (10, 13):
                self.command_palette()
                continue
            self.handle_key(ch)

    def draw(self) -> None:
        self._drain_tail()
        self.cached_status = self.pool.status()
        self.stdscr.erase()
        height, width = self.stdscr.getmaxyx()
        left_width = max(36, min(54, width // 3))
        right_x = left_width + 1
        right_w = max(20, width - right_x)
        body_h = max(8, height - 5)

        self._line(0, 0, "vLLM Pool TUI", curses.A_BOLD)
        self._line(0, max(18, width - 42), "Enter: commands | ?: help | q: quit")

        self._box(2, 0, body_h, left_width, "Control")
        self._draw_control_panel(3, 2, left_width - 4)

        top_h = max(9, body_h // 2)
        self._box(2, right_x, top_h, right_w, "Status")
        self._draw_status_panel(3, right_x + 2, right_w - 4, top_h - 2)

        tail_y = 2 + top_h
        tail_h = max(7, body_h - top_h)
        self._box(tail_y, right_x, tail_h, right_w, f"Tail {self.tail_key or '<none>'}")
        self._draw_tail_panel(tail_y + 1, right_x + 2, right_w - 4, tail_h - 2)

        self._line(height - 2, 0, self.message[: width - 1], curses.A_REVERSE)
        self.stdscr.refresh()

    def _draw_control_panel(self, y: int, x: int, width: int) -> None:
        rows = [
            ("Model", self.model_name or "<unset>"),
            ("GPU", self.gpu_id or "<auto>"),
            ("Metadata", "include" if self.include_metadata else "exclude"),
            ("Output field", self.output_field),
            ("Offline cleanup", str(self.cleanup_model_after_job)),
            ("Pre-processor", "set" if self.pre_processor else "none"),
            ("Post-processor", "set" if self.post_processor else "none"),
        ]
        for idx, (label, value) in enumerate(rows):
            self._line(y + idx, x, f"{label}: {value}"[:width])

        y += len(rows) + 2
        groups: Dict[str, List[Command]] = {}
        for command in COMMANDS:
            groups.setdefault(command.group, []).append(command)
        for group, commands in groups.items():
            if y >= curses.LINES - 4:
                break
            self._line(y, x, group, curses.A_BOLD)
            y += 1
            for command in commands:
                if y >= curses.LINES - 4:
                    break
                self._line(y, x + 1, f"{command.key}  {command.label}"[: max(1, width - 1)])
                y += 1

    def _draw_status_panel(self, y: int, x: int, width: int, height: int) -> None:
        status = self.cached_status or {}
        self._line(y, x, f"GPUs: {status.get('gpu_count', '?')}  Max workers: {status.get('max_workers', '?')}"[:width])
        self._line(y + 1, x, f"Queues: {json.dumps(status.get('queues', {}), ensure_ascii=False)}"[:width])
        row = y + 3
        running = status.get("running", {}) or {}
        if not running:
            self._line(row, x, "No running workers."[:width])
            return
        for name, info in list(running.items())[: max(1, height - 3)]:
            text = f"{name} pid={info.get('pid')} alive={info.get('alive')} busy={info.get('busy')}"
            self._line(row, x, text[:width])
            row += 1

    def _draw_tail_panel(self, y: int, x: int, width: int, height: int) -> None:
        if not self.tail_key:
            self._line(y, x, "Select a worker tail with 't'."[:width])
            return
        lines = self.tail_lines[-max(1, height):] or ["Waiting for worker tail updates..."]
        for idx, line in enumerate(lines[:height]):
            self._line(y + idx, x, str(line)[:width])

    def handle_key(self, ch: int) -> None:
        if ch < 0:
            return
        key = chr(ch) if 0 <= ch <= 255 else ""
        command = next((item for item in COMMANDS if item.key == key), None)
        if not command:
            return
        self._run_handler(command.handler)

    def _run_handler(self, handler_name: str) -> None:
        try:
            getattr(self, handler_name)()
        except FileSelectionCanceled:
            self.message = "File selection canceled."
        except Exception as exc:
            self.message = f"Error: {exc}"

    def command_palette(self) -> None:
        labels = [f"{c.key}  {c.group}: {c.label}" for c in COMMANDS]
        choice = self.choose("Command palette", labels)
        if choice is not None:
            self._run_handler(COMMANDS[choice].handler)

    def set_model(self) -> None:
        loaded = self.pool.list_models()
        entered = self.prompt("Model name, blank to choose loaded", self.model_name)
        if entered:
            self.model_name = entered
            self.message = f"Model set to {self.model_name}."
            return
        if loaded:
            choice = self.choose("Loaded models", loaded)
            if choice is not None:
                self.model_name = loaded[choice]
                self.message = f"Model set to {self.model_name}."

    def set_gpu(self) -> None:
        self.gpu_id = self.prompt("GPU id, blank for auto", self.gpu_id)
        self.message = f"GPU set to {self.gpu_id or '<auto>'}."

    def edit_config(self) -> None:
        updated = self.edit_json("vLLM config", self.config)
        if not isinstance(updated, dict):
            raise ValueError("vLLM config must be a JSON object.")
        LLMResourceConfig(**updated)
        self.config = updated
        self.message = "Updated vLLM config."

    def start_model(self) -> None:
        self._ensure_model_name()
        model, gid, pid = self.pool.start(self.model_name, self.config, self._gpu_or_none())
        self.message = f"Started {model} on GPU {gid} (pid {pid})."
        self.refresh_status()

    def stop_model(self) -> None:
        workers = self.pool.list_workers()
        labels = [f"{w['model']} | gpu {w['gpu_id']} | {w['key']}" for w in workers]
        choice = self.choose("Stop worker", labels)
        if choice is None:
            return
        worker = workers[choice]
        status = self.pool.stop(worker["model"], int(worker["gpu_id"]))
        if self.tail_key == worker["key"]:
            self.tail_key = None
            self.tail_queue = None
            self.tail_lines = []
        self.message = f"Stopped {worker['key']}: {status}."
        self.refresh_status()

    def refresh_status(self) -> None:
        self.cached_status = self.pool.status()
        self.message = "Status refreshed."

    def select_tail(self) -> None:
        workers = self.pool.list_workers()
        labels = [w["key"] for w in workers]
        choice = self.choose("Select worker tail", labels)
        if choice is None:
            return
        self.tail_key = labels[choice]
        self.tail_queue = self.pool.subscribe_worker(self.tail_key)
        self.tail_lines = ["Subscribed. Waiting for worker tail updates..."]
        self.message = f"Watching {self.tail_key}."

    def job_menu(self) -> None:
        items = ["List jobs", "Inspect job", "Wait for job", "Cancel queued job"]
        choice = self.choose("Jobs", items)
        if choice == 0:
            self.show_text("Jobs", self._jobs_text())
        elif choice == 1:
            job_id = self.prompt("Job id")
            if job_id:
                self.show_json("Job", self.pool.get_job(job_id))
        elif choice == 2:
            job_id = self.prompt("Job id")
            if job_id:
                self._wait_for_job(job_id)
        elif choice == 3:
            job_id = self.prompt("Job id")
            if job_id:
                self.show_json("Cancel result", self.pool.cancel_job(job_id))

    def _jobs_text(self) -> str:
        lines = []
        for job_id, rec in sorted(self.pool.jobs.items(), key=lambda item: item[0]):
            lines.append(f"{job_id}: {rec.get('status')}")
        return "\n".join(lines) or "No tracked jobs."

    def submit_simple(self) -> None:
        self._ensure_model_name()
        self.simple_prompts = self._get_prompts_for_submit("simple")
        self.sampling = self._edit_sampling()
        jid = self.pool.submit(self._job("generate_simple", self.simple_prompts))
        self.message = f"Simple job queued: {jid}."
        self._wait_for_job(jid)

    def submit_chat(self) -> None:
        self._ensure_model_name()
        self.chat_prompts = self._get_prompts_for_submit("chat")
        self.sampling = self._edit_sampling()
        self.output_field = self.prompt("Output field", self.output_field) or "output"
        jid = self.pool.submit(self._job("generate_chat", self.chat_prompts, output_field=self.output_field))
        self.message = f"Chat job queued: {jid}."
        self._wait_for_job(jid)

    def submit_offline(self) -> None:
        self._ensure_model_name()
        kind = self.prompt("Offline type (generate/chat)", "generate").strip().lower()
        if kind not in {"generate", "chat"}:
            raise ValueError("Offline type must be generate or chat.")
        if kind == "generate":
            prompts = self._get_prompts_for_submit("simple")
            self.simple_prompts = prompts
            job = self._job("generate_simple", prompts)
        else:
            prompts = self._get_prompts_for_submit("chat")
            self.chat_prompts = prompts
            self.output_field = self.prompt("Output field", self.output_field) or "output"
            job = self._job("generate_chat", prompts, output_field=self.output_field)
        self.sampling = self._edit_sampling()
        job["cmd"]["sampling"] = self._sampling_dict()
        job["cleanup_model_after_job"] = self.cleanup_model_after_job
        jid = self.pool.submit_offline(job)
        self.message = f"Offline job queued: {jid}. Start model later if it is not running."

    def generation_options(self) -> None:
        items = [
            f"Toggle include metadata ({self.include_metadata})",
            f"Set output field ({self.output_field})",
            f"Toggle cleanup after offline job ({self.cleanup_model_after_job})",
            "Edit sampling JSON",
            "Edit simple prompt JSON",
            "Edit chat prompt JSON",
            "Load simple prompts from JSON file",
            "Load chat prompts from JSON file",
        ]
        choice = self.choose("Generation options", items)
        if choice == 0:
            self.include_metadata = not self.include_metadata
        elif choice == 1:
            self.output_field = self.prompt("Output field", self.output_field) or "output"
        elif choice == 2:
            self.cleanup_model_after_job = not self.cleanup_model_after_job
        elif choice == 3:
            self.sampling = self._edit_sampling()
        elif choice == 4:
            self.simple_prompts = self._normalize_simple_prompts(self.edit_json("simple prompts", self.simple_prompts))
        elif choice == 5:
            self.chat_prompts = self._normalize_chat_prompts(self.edit_json("chat prompts", self.chat_prompts))
        elif choice == 6:
            self.simple_prompts = self._load_simple_prompts_file()
        elif choice == 7:
            self.chat_prompts = self._load_chat_prompts_file()
        self.message = "Generation options updated."

    def load_prompts_menu(self) -> None:
        items = ["Load simple prompts JSON", "Load chat prompts JSON"]
        choice = self.choose("Load prompts from file", items)
        if choice == 0:
            self.simple_prompts = self._load_simple_prompts_file()
            self.message = f"Loaded {len(self.simple_prompts)} simple prompts."
        elif choice == 1:
            self.chat_prompts = self._load_chat_prompts_file()
            self.message = f"Loaded {len(self.chat_prompts)} chat prompts."

    def _get_prompts_for_submit(self, mode: str) -> List[Dict[str, Any]]:
        current = self.simple_prompts if mode == "simple" else self.chat_prompts
        labels = ["Use current prompts", "Edit prompts in $EDITOR", "Load prompts from JSON file"]
        choice = self.choose("Prompt source", labels)
        if choice == 2:
            return self._load_simple_prompts_file() if mode == "simple" else self._load_chat_prompts_file()
        if choice == 1:
            title = "simple prompts" if mode == "simple" else "chat prompts"
            value = self.edit_json(title, current)
            return self._normalize_simple_prompts(value) if mode == "simple" else self._normalize_chat_prompts(value)
        return current

    def _load_simple_prompts_file(self) -> List[Dict[str, Any]]:
        path = self._prompt_existing_path("Simple prompts JSON path")
        return self._normalize_simple_prompts(self._read_json_file(path))

    def _load_chat_prompts_file(self) -> List[Dict[str, Any]]:
        path = self._prompt_existing_path("Chat prompts JSON path")
        return self._normalize_chat_prompts(self._read_json_file(path))

    def _prompt_existing_path(self, label: str) -> Path:
        path = self.browse_file(label, suffixes=(".json",))
        if path is None:
            raise FileSelectionCanceled
        if not path.exists():
            raise ValueError(f"File does not exist: {path}")
        if not path.is_file():
            raise ValueError(f"Not a file: {path}")
        return path

    def browse_file(self, title: str, suffixes: tuple[str, ...] = ()) -> Optional[Path]:
        """Select a file without requiring the user to type its full path."""
        current = Path.cwd()
        idx = top = 0
        while True:
            try:
                directories = sorted((p for p in current.iterdir() if p.is_dir()), key=lambda p: p.name.lower())
                files = sorted(
                    (p for p in current.iterdir() if p.is_file() and (not suffixes or p.suffix.lower() in suffixes)),
                    key=lambda p: p.name.lower(),
                )
                entries = [current.parent, *directories, *files]
            except OSError as exc:
                self.message = f"Cannot open {current}: {exc}"
                current = current.parent
                continue

            idx = min(idx, len(entries) - 1)
            self.stdscr.erase()
            height, width = self.stdscr.getmaxyx()
            visible_h = max(1, height - 5)
            if idx < top:
                top = idx
            if idx >= top + visible_h:
                top = idx - visible_h + 1
            self._line(0, 0, title, curses.A_BOLD)
            self._line(1, 0, str(current)[: width - 1])
            help_text = "Arrows/j/k: move  Enter: open/select  Backspace: parent  Esc/q: cancel"
            self._line(2, 0, help_text[: width - 1])
            for row, path in enumerate(entries[top : top + visible_h], start=4):
                absolute = top + row - 4
                name = "../" if absolute == 0 else path.name + ("/" if path.is_dir() else "")
                attr = curses.A_REVERSE if absolute == idx else curses.A_NORMAL
                self._line(row, 2, name[: max(1, width - 4)], attr)
            count = f"{idx + 1}/{len(entries)}"
            self._line(height - 1, max(0, width - len(count) - 1), count)
            self.stdscr.refresh()

            ch = self.stdscr.getch()
            if ch in (27, ord("q")):
                return None
            if ch in (curses.KEY_BACKSPACE, 8, 127):
                current, idx, top = current.parent, 0, 0
            elif ch in (curses.KEY_UP, ord("k")):
                idx = max(0, idx - 1)
            elif ch in (curses.KEY_DOWN, ord("j")):
                idx = min(len(entries) - 1, idx + 1)
            elif ch == curses.KEY_PPAGE:
                idx = max(0, idx - visible_h)
            elif ch == curses.KEY_NPAGE:
                idx = min(len(entries) - 1, idx + visible_h)
            elif ch == curses.KEY_HOME:
                idx = 0
            elif ch == curses.KEY_END:
                idx = len(entries) - 1
            elif ch in (10, 13):
                selected = entries[idx]
                if selected.is_dir():
                    current, idx, top = selected.resolve(), 0, 0
                else:
                    return selected

    def _read_json_file(self, path: Path) -> JsonValue:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON in {path}: {exc}") from exc

    def _job(self, cmd_type: str, prompts: List[Dict[str, Any]], **extra: Any) -> Dict[str, Any]:
        cmd = {
            "type": cmd_type,
            "prompts": prompts,
            "sampling": self._sampling_dict(),
            "include_metadata": self.include_metadata,
            "pre_processor": self.pre_processor,
            "post_processor": self.post_processor,
            **extra,
        }
        return {"job_id": None, "model_name": self.model_name, "cmd": cmd}

    def processor_menu(self) -> None:
        items = [
            "Edit pre-processor JSON",
            "Edit post-processor JSON",
            "Clear pre-processor",
            "Clear post-processor",
            "Load processor preset",
            "Save post-processor as preset",
            "Edit raw processor presets",
        ]
        choice = self.choose("Processors", items)
        if choice == 0:
            self.pre_processor = self._optional_object_json("pre-processor", self.pre_processor)
        elif choice == 1:
            self.post_processor = self._optional_object_json("post-processor", self.post_processor)
        elif choice == 2:
            self.pre_processor = None
        elif choice == 3:
            self.post_processor = None
        elif choice == 4:
            self._load_processor_preset()
        elif choice == 5:
            self._save_processor_preset()
        elif choice == 6:
            self._edit_store_section("processor_presets")
        self.message = "Processor settings updated."

    def bank_menu(self) -> None:
        items = [
            "Save current simple prompts",
            "Load simple prompts",
            "Save current chat prompts",
            "Load chat prompts",
            "Save current sampling",
            "Load sampling",
            "Edit raw prompt bank",
            "Edit raw sampling bank",
        ]
        choice = self.choose("Prompt and sampling banks", items)
        if choice == 0:
            self._save_bank_item("prompt_bank", "simple", json.dumps(self.simple_prompts, indent=2))
        elif choice == 1:
            value = self._load_bank_item("prompt_bank", "simple")
            if value is not None:
                self.simple_prompts = self._normalize_simple_prompts(json.loads(value))
        elif choice == 2:
            self._save_bank_item("prompt_bank", "chat", json.dumps(self.chat_prompts, indent=2))
        elif choice == 3:
            value = self._load_bank_item("prompt_bank", "chat")
            if value is not None:
                self.chat_prompts = self._normalize_chat_prompts(json.loads(value))
        elif choice == 4:
            name = self.prompt("sampling preset name")
            if name:
                self._save_bank_item("sampling_bank", "simple", json.dumps(self.sampling, indent=2), name=name)
                self._save_bank_item("sampling_bank", "chat", json.dumps(self.sampling, indent=2), name=name)
        elif choice == 5:
            value = self._load_bank_item("sampling_bank", "simple")
            if value is not None:
                self.sampling = self._validate_sampling(json.loads(value))
        elif choice == 6:
            self._edit_store_section("prompt_bank")
        elif choice == 7:
            self._edit_store_section("sampling_bank")
        self.message = "Bank state updated."

    def result_menu(self) -> None:
        if not self.last_result:
            self.message = "No result yet."
            return
        items = ["View result JSON", "Save result JSON", "Edit result JSON buffer"]
        choice = self.choose("Result", items)
        if choice == 0:
            self.show_json("Result", self.last_result)
        elif choice == 1:
            path = self.prompt("Save path", "result.json")
            if path:
                Path(path).write_text(json.dumps(self.last_result, indent=2, ensure_ascii=False), encoding="utf-8")
                self.message = f"Saved result to {path}."
        elif choice == 2:
            self.last_result = self.edit_json("result", self.last_result)

    def _load_processor_preset(self) -> None:
        presets = self.store.get_all().get("processor_presets", [])
        labels = [item.get("name", "<unnamed>") for item in presets if isinstance(item, dict)]
        choice = self.choose("Load processor preset", labels)
        if choice is None:
            return
        spec = presets[choice].get("spec")
        if not isinstance(spec, dict):
            raise ValueError("Preset spec must be an object.")
        target = self.prompt("Target pre/post", "post").strip().lower()
        if target == "pre":
            self.pre_processor = spec
        else:
            self.post_processor = spec

    def _save_processor_preset(self) -> None:
        if not self.post_processor:
            raise ValueError("Post-processor is not set.")
        name = self.prompt("Preset name")
        if not name:
            return
        state = self.store.get_all()
        presets = [item for item in state.get("processor_presets", []) if item.get("name") != name]
        presets.append({"name": name, "spec": self.post_processor})
        presets.sort(key=lambda item: str(item.get("name", "")))
        self.store.set_section("processor_presets", presets)

    def _save_bank_item(self, section: str, mode: str, value: str, name: Optional[str] = None) -> None:
        preset_name = name or self.prompt(f"{mode} preset name")
        if not preset_name:
            return
        state = self.store.get_all()
        bank = state.get(section, {})
        items = [item for item in bank.get(mode, []) if item.get("name") != preset_name]
        items.append({"name": preset_name, "value": value})
        items.sort(key=lambda item: str(item.get("name", "")))
        bank[mode] = items
        self.store.set_section(section, bank)

    def _load_bank_item(self, section: str, mode: str) -> Optional[str]:
        state = self.store.get_all()
        items = state.get(section, {}).get(mode, [])
        labels = [item.get("name", "<unnamed>") for item in items if isinstance(item, dict)]
        choice = self.choose(f"Load {mode} preset", labels)
        if choice is None:
            return None
        value = items[choice].get("value")
        if not isinstance(value, str):
            raise ValueError("Bank item value must be a string.")
        return value

    def _edit_store_section(self, section: str) -> None:
        state = self.store.get_all()
        self.store.set_section(section, self.edit_json(section, state.get(section)))

    def _ensure_model_name(self) -> None:
        if not self.model_name:
            self.set_model()
        if not self.model_name:
            raise ValueError("Model name is required.")

    def _gpu_or_none(self) -> Optional[int]:
        text = self.gpu_id.strip()
        return None if not text else int(text)

    def _edit_sampling(self) -> Dict[str, Any]:
        return self._validate_sampling(self.edit_json("sampling", self.sampling))

    def _validate_sampling(self, value: JsonValue) -> Dict[str, Any]:
        if not isinstance(value, dict):
            raise ValueError("Sampling must be a JSON object.")
        return SamplingConfig(**value).__dict__.copy()

    def _sampling_dict(self) -> Dict[str, Any]:
        return self._validate_sampling(self.sampling)

    def _optional_object_json(self, title: str, value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        default = {"name": "identity", "config": {}, "runtime": {"dependencies": [], "auto_install": False}, "on_error": "fail"}
        updated = self.edit_json(title, value or default)
        if updated in ({}, None):
            return None
        if not isinstance(updated, dict):
            raise ValueError(f"{title} must be a JSON object.")
        return updated

    def _normalize_simple_prompts(self, value: JsonValue) -> List[Dict[str, Any]]:
        if not isinstance(value, list):
            raise ValueError("Simple prompts must be a JSON array.")
        out: List[Dict[str, Any]] = []
        for item in value:
            if not isinstance(item, dict) or not isinstance(item.get("prompt"), str):
                raise ValueError("Each simple prompt must include string field 'prompt'.")
            out.append({"prompt": item["prompt"], "metadata": item.get("metadata", {})})
        return out

    def _normalize_chat_prompts(self, value: JsonValue) -> List[Dict[str, Any]]:
        if not isinstance(value, list):
            raise ValueError("Chat prompts must be a JSON array.")
        out: List[Dict[str, Any]] = []
        for item in value:
            if not isinstance(item, dict) or not isinstance(item.get("messages"), list):
                raise ValueError("Each chat item must include a messages array.")
            for message in item["messages"]:
                if not isinstance(message, dict) or "role" not in message or "content" not in message:
                    raise ValueError("Each chat message must include role and content.")
            out.append({"messages": item["messages"], "metadata": item.get("metadata", {})})
        return out

    def prompt(self, label: str, default: str = "") -> str:
        curses.echo()
        self.stdscr.nodelay(False)
        height, width = self.stdscr.getmaxyx()
        prompt = f"{label} [{default}]: "
        self._line(height - 1, 0, " " * (width - 1))
        self._line(height - 1, 0, prompt[: width - 1])
        self.stdscr.refresh()
        raw = self.stdscr.getstr(height - 1, min(width - 2, len(prompt)), max(1, width - len(prompt) - 2))
        curses.noecho()
        return raw.decode("utf-8").strip() or default

    def choose(self, title: str, items: List[str]) -> Optional[int]:
        if not items:
            self.message = f"No items for {title}."
            return None
        idx = 0
        top = 0
        while True:
            self.stdscr.erase()
            height, width = self.stdscr.getmaxyx()
            visible_h = max(1, height - 4)
            if idx < top:
                top = idx
            if idx >= top + visible_h:
                top = idx - visible_h + 1
            self._line(0, 0, title, curses.A_BOLD)
            self._line(1, 0, "Arrows/j/k, PgUp/PgDn, Home/End; Enter: choose; Esc/q: cancel")
            for row, item in enumerate(items[top : top + visible_h], start=3):
                absolute = top + row - 3
                attr = curses.A_REVERSE if absolute == idx else curses.A_NORMAL
                self._line(row, 2, item[: width - 4], attr)
            self.stdscr.refresh()
            ch = self.stdscr.getch()
            if ch in (27, ord("q")):
                return None
            if ch in (curses.KEY_UP, ord("k")):
                idx = max(0, idx - 1)
            elif ch in (curses.KEY_DOWN, ord("j")):
                idx = min(len(items) - 1, idx + 1)
            elif ch == curses.KEY_PPAGE:
                idx = max(0, idx - visible_h)
            elif ch == curses.KEY_NPAGE:
                idx = min(len(items) - 1, idx + visible_h)
            elif ch == curses.KEY_HOME:
                idx = 0
            elif ch == curses.KEY_END:
                idx = len(items) - 1
            elif ch in (10, 13):
                return idx

    def edit_json(self, title: str, value: JsonValue) -> JsonValue:
        text = self._edit_text(title, json.dumps(value, indent=2, ensure_ascii=False), suffix=".json")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            self.message = f"Invalid JSON in {title}: {exc}"
            return value

    def _edit_text(self, title: str, value: str, suffix: str = ".txt") -> str:
        editor = os.getenv("EDITOR", "").strip()
        if not editor:
            return self._edit_text_builtin(title, value)
        with tempfile.NamedTemporaryFile("w+", suffix=suffix, delete=False) as tmp:
            tmp.write(value)
            path = tmp.name
        curses.def_prog_mode()
        curses.endwin()
        try:
            subprocess.run([editor, path], check=False)
        finally:
            curses.reset_prog_mode()
            self.stdscr.keypad(True)
        try:
            text = Path(path).read_text(encoding="utf-8")
        finally:
            Path(path).unlink(missing_ok=True)
        self.message = f"Edited {title}."
        return text

    def _edit_text_builtin(self, title: str, value: str) -> str:
        """Small dependency-free editor for JSON and other TUI text buffers."""
        lines = value.splitlines() or [""]
        row = col = top = left = 0
        saved_cursor = False
        try:
            curses.curs_set(1)
            saved_cursor = True
        except curses.error:
            pass
        try:
            while True:
                self.stdscr.erase()
                height, width = self.stdscr.getmaxyx()
                body_h = max(1, height - 3)
                body_w = max(1, width - 1)
                top = min(top, row)
                if row >= top + body_h:
                    top = row - body_h + 1
                left = min(left, col)
                if col >= left + body_w:
                    left = col - body_w + 1

                self._line(0, 0, f"Edit {title}", curses.A_BOLD)
                controls = "Ctrl+S save | Ctrl+Q cancel | arrows move | Enter new line"
                self._line(1, 0, controls[: width - 1], curses.A_REVERSE)
                for screen_row, text in enumerate(lines[top : top + body_h], start=2):
                    self._line(screen_row, 0, text[left : left + body_w])
                position = f"Ln {row + 1}, Col {col + 1}"
                self._line(height - 1, max(0, width - len(position) - 1), position)
                try:
                    self.stdscr.move(2 + row - top, col - left)
                except curses.error:
                    pass
                self.stdscr.refresh()

                ch = self.stdscr.getch()
                if ch < 0:
                    continue
                if ch == 19:  # Ctrl+S
                    self.message = f"Edited {title}."
                    return "\n".join(lines)
                if ch == 17:  # Ctrl+Q
                    self.message = f"Canceled editing {title}."
                    return value
                if ch == curses.KEY_UP:
                    row = max(0, row - 1)
                    col = min(col, len(lines[row]))
                elif ch == curses.KEY_DOWN:
                    row = min(len(lines) - 1, row + 1)
                    col = min(col, len(lines[row]))
                elif ch == curses.KEY_LEFT:
                    if col:
                        col -= 1
                    elif row:
                        row -= 1
                        col = len(lines[row])
                elif ch == curses.KEY_RIGHT:
                    if col < len(lines[row]):
                        col += 1
                    elif row < len(lines) - 1:
                        row += 1
                        col = 0
                elif ch == curses.KEY_HOME:
                    col = 0
                elif ch == curses.KEY_END:
                    col = len(lines[row])
                elif ch in (curses.KEY_BACKSPACE, 8, 127):
                    if col:
                        lines[row] = lines[row][: col - 1] + lines[row][col:]
                        col -= 1
                    elif row:
                        previous_length = len(lines[row - 1])
                        lines[row - 1] += lines.pop(row)
                        row -= 1
                        col = previous_length
                elif ch == curses.KEY_DC:
                    if col < len(lines[row]):
                        lines[row] = lines[row][:col] + lines[row][col + 1 :]
                    elif row < len(lines) - 1:
                        lines[row] += lines.pop(row + 1)
                elif ch in (10, 13):
                    remainder = lines[row][col:]
                    lines[row] = lines[row][:col]
                    lines.insert(row + 1, remainder)
                    row += 1
                    col = 0
                elif ch == 9:
                    lines[row] = lines[row][:col] + "  " + lines[row][col:]
                    col += 2
                elif 32 <= ch <= 255:
                    character = chr(ch)
                    lines[row] = lines[row][:col] + character + lines[row][col:]
                    col += 1
        finally:
            if saved_cursor:
                try:
                    curses.curs_set(0)
                except curses.error:
                    pass

    def show_json(self, title: str, value: JsonValue) -> None:
        self.show_text(title, json.dumps(value, indent=2, ensure_ascii=False))

    def show_text(self, title: str, text: str) -> None:
        lines = text.splitlines() or [""]
        top = 0
        while True:
            self.stdscr.erase()
            height, width = self.stdscr.getmaxyx()
            self._line(0, 0, title, curses.A_BOLD)
            self._line(1, 0, "Up/down or j/k to scroll, q/Esc to return")
            visible = max(1, height - 3)
            for row, line in enumerate(lines[top : top + visible], start=2):
                self._line(row, 0, line[: width - 1])
            self.stdscr.refresh()
            ch = self.stdscr.getch()
            if ch in (27, ord("q")):
                return
            if ch in (curses.KEY_UP, ord("k")):
                top = max(0, top - 1)
            elif ch in (curses.KEY_DOWN, ord("j")):
                top = min(max(0, len(lines) - visible), top + 1)

    def show_help(self) -> None:
        self.show_text("Help", """
Terminal UI capabilities

- Start and stop vLLM workers with editable resource JSON.
- Inspect GPU count, worker PIDs, liveness, busy state, and queue depth.
- Subscribe to per-worker live log/tqdm tails.
- Submit simple, chat, and offline jobs.
- Queue offline jobs before a model is loaded, then start the model later.
- Configure sampling, output field, metadata inclusion, and offline cleanup.
- Configure pre-processors and post-processors, including python_script specs.
- Save/load processor presets, prompt banks, and sampling banks.
- Inspect, wait for, cancel queued jobs, and save result JSON.

JSON editing uses the built-in editor: arrows move, Ctrl+S saves, and Ctrl+Q cancels.
Set $EDITOR to use an external editor such as nano or vi instead.
Prompt files use the same shapes as the browser UI: simple arrays of {prompt, metadata?}; chat arrays of {messages, metadata?}.
""".strip())

    def _wait_for_job(self, jid: str) -> None:
        started = time.monotonic()
        tick = 0
        while True:
            rec = self.pool.get_job(jid)
            status = str(rec.get("status", "unknown"))
            elapsed = time.monotonic() - started
            self._draw_job_progress(jid, status, elapsed, tick)
            if status in {"done", "error", "canceled", "not_found"}:
                self.last_result = rec
                self.message = f"Job {jid}: {status} ({elapsed:.1f}s)"
                return
            tick += 1
            time.sleep(0.5)

    def _draw_job_progress(self, jid: str, status: str, elapsed: float, tick: int) -> None:
        """Draw a prominent status bar for a job without inventing a percentage."""
        self.stdscr.erase()
        height, width = self.stdscr.getmaxyx()
        bar_width = max(10, min(60, width - 12))
        if status == "done":
            bar_text = "=" * bar_width
        elif status == "running":
            span = max(1, bar_width // 5)
            offset = tick % max(1, bar_width - span + 1)
            bar = [" "] * bar_width
            bar[offset : offset + span] = ["="] * span
            bar_text = "".join(bar)
        else:
            fill = max(1, bar_width // 12)
            bar_text = "=" * fill + " " * (bar_width - fill)

        y = max(1, height // 2 - 3)
        heading = f"Job {jid}"
        self._line(y, max(0, (width - len(heading)) // 2), heading, curses.A_BOLD)
        self._line(y + 2, max(0, (width - bar_width - 2) // 2), f"[{bar_text}]")
        detail = f"{status.upper()}  |  elapsed {elapsed:.1f}s"
        self._line(y + 4, max(0, (width - len(detail)) // 2), detail, curses.A_BOLD)
        note = "Animated while running; the backend does not report an exact token percentage."
        self._line(height - 2, 0, note[: width - 1])
        self.stdscr.refresh()

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
