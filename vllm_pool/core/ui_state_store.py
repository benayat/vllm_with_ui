from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Dict


class UIStateStore:
    def __init__(self) -> None:
        default_path = Path.cwd() / "data" / "ui_state.json"
        self.path = Path(os.getenv("VLLM_UI_STATE_PATH", str(default_path)))
        self.lock = threading.Lock()
        self._ensure_file()

    def _ensure_file(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._write({
                "processor_presets": [],
                "prompt_bank": {"simple": [], "chat": []},
                "sampling_bank": {"simple": [], "chat": []},
            })

    def _read(self) -> Dict[str, Any]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {
                "processor_presets": [],
                "prompt_bank": {"simple": [], "chat": []},
                "sampling_bank": {"simple": [], "chat": []},
            }

    def _write(self, obj: Dict[str, Any]) -> None:
        self.path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_all(self) -> Dict[str, Any]:
        with self.lock:
            data = self._read()
            if "processor_presets" not in data:
                data["processor_presets"] = []
            if "prompt_bank" not in data:
                data["prompt_bank"] = {"simple": [], "chat": []}
            if "sampling_bank" not in data:
                data["sampling_bank"] = {"simple": [], "chat": []}
            return data

    def set_section(self, section: str, value: Any) -> Dict[str, Any]:
        with self.lock:
            data = self._read()
            data[section] = value
            self._write(data)
            return data
