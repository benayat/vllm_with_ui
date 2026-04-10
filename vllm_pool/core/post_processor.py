from __future__ import annotations

import importlib
import importlib.metadata
import json
import os
import re
import subprocess
import time
import hashlib
from dataclasses import dataclass
from typing import Any, Dict, List, Callable


DependencyCheck = Dict[str, Any]


@dataclass
class PostProcessorError(Exception):
    message: str

    def __str__(self) -> str:
        return self.message


class DependencyInstaller:
    def __init__(self) -> None:
        self.allow_runtime_install = os.getenv("ALLOW_RUNTIME_DEP_INSTALL", "false").lower() == "true"
        self.max_deps = int(os.getenv("POST_PROCESSOR_MAX_DEPS", "20"))
        self.install_timeout_sec = int(os.getenv("POST_PROCESSOR_INSTALL_TIMEOUT_SEC", "120"))

    def ensure(self, requirements: List[str], auto_install: bool) -> List[DependencyCheck]:
        if len(requirements) > self.max_deps:
            raise PostProcessorError(f"Too many dependencies requested ({len(requirements)} > {self.max_deps})")

        checks: List[DependencyCheck] = []
        for req in requirements:
            req = (req or "").strip()
            if not req:
                continue
            package_name = self._extract_package_name(req)
            installed = self._is_installed(package_name)
            if installed:
                checks.append({"requirement": req, "status": "already_present"})
                continue
            if not auto_install:
                raise PostProcessorError(f"Missing dependency '{req}' and auto_install=false")
            if not self.allow_runtime_install:
                raise PostProcessorError(
                    f"Missing dependency '{req}' but runtime installation is disabled "
                    "(set ALLOW_RUNTIME_DEP_INSTALL=true to enable)."
                )
            self._install(req)
            checks.append({"requirement": req, "status": "installed"})
        return checks

    def _extract_package_name(self, req: str) -> str:
        # Requirement spec is expected to start with distribution name.
        match = re.match(r"^([A-Za-z0-9_.\-]+)", req)
        if not match:
            raise PostProcessorError(f"Cannot parse dependency name from '{req}'")
        return match.group(1)

    def _is_installed(self, package_name: str) -> bool:
        try:
            importlib.metadata.version(package_name)
            return True
        except importlib.metadata.PackageNotFoundError:
            return False

    def _install(self, req: str) -> None:
        try:
            subprocess.run(
                ["uv", "pip", "install", req],
                check=True,
                capture_output=True,
                text=True,
                timeout=self.install_timeout_sec,
            )
        except FileNotFoundError as e:
            raise PostProcessorError("'uv' command not found in environment") from e
        except subprocess.TimeoutExpired as e:
            raise PostProcessorError(f"Dependency install timed out for '{req}'") from e
        except subprocess.CalledProcessError as e:
            err = (e.stderr or e.stdout or "").strip()
            raise PostProcessorError(f"Failed installing '{req}': {err}") from e


class PostProcessorManager:
    def __init__(self) -> None:
        self.installer = DependencyInstaller()
        self.max_io_bytes = int(os.getenv("POST_PROCESSOR_MAX_JSON_BYTES", str(2 * 1024 * 1024)))
        self._script_cache: Dict[str, Callable[[Any, Dict[str, Any]], Any]] = {}
        self.registry: Dict[str, Callable[[Any, Dict[str, Any]], Any]] = {
            "identity": self._identity,
            "jsonpath_extract": self._jsonpath_extract,
            "python_script": self._python_script,
        }

    def execute(self, generation_json: Any, spec: Dict[str, Any]) -> Dict[str, Any]:
        started = time.perf_counter()
        name = (spec.get("name") or "").strip()
        config = spec.get("config") or {}
        runtime = spec.get("runtime") or {}
        dependencies = runtime.get("dependencies") or []
        auto_install = bool(runtime.get("auto_install", False))

        if not isinstance(config, dict):
            raise PostProcessorError("post_processor.config must be an object")
        if name not in self.registry:
            raise PostProcessorError(f"Unknown post processor '{name}'. Available: {sorted(self.registry.keys())}")

        self._enforce_json_size(generation_json, "generation result")
        dep_report = self.installer.ensure(dependencies, auto_install=auto_install)

        out = self.registry[name](generation_json, config)
        self._enforce_json_size(out, "post processor output")

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "name": name,
            "status": "ok",
            "timing_ms": elapsed_ms,
            "dependency_report": dep_report,
            "output": out,
        }

    def _enforce_json_size(self, payload: Any, label: str) -> None:
        try:
            raw = json.dumps(payload)
        except TypeError as e:
            raise PostProcessorError(f"{label} is not JSON serializable") from e
        if len(raw.encode("utf-8")) > self.max_io_bytes:
            raise PostProcessorError(f"{label} exceeds max size ({self.max_io_bytes} bytes)")

    def _identity(self, generation_json: Any, _config: Dict[str, Any]) -> Any:
        return generation_json

    def _jsonpath_extract(self, generation_json: Any, config: Dict[str, Any]) -> Dict[str, Any]:
        paths = config.get("paths")
        if not isinstance(paths, list) or not all(isinstance(p, str) and p.strip() for p in paths):
            raise PostProcessorError("jsonpath_extract requires config.paths as non-empty string array")

        try:
            jsonpath_module = importlib.import_module("jsonpath_ng")
        except ImportError as e:
            raise PostProcessorError(
                "jsonpath_extract requires dependency 'jsonpath-ng'"
            ) from e

        parse = getattr(jsonpath_module, "parse", None)
        if parse is None:
            raise PostProcessorError("jsonpath-ng does not expose parse()")

        extracted: Dict[str, Any] = {}
        for path in paths:
            expr = parse(path)
            values = [m.value for m in expr.find(generation_json)]
            extracted[path] = values
        return {"matches": extracted}

    def _python_script(self, generation_json: Any, config: Dict[str, Any]) -> Any:
        code = config.get("code")
        entrypoint = config.get("entrypoint", "process")
        if not isinstance(code, str) or not code.strip():
            raise PostProcessorError("python_script requires config.code as non-empty Python code string")
        if not isinstance(entrypoint, str) or not entrypoint.strip():
            raise PostProcessorError("python_script requires config.entrypoint as string")

        cache_key = hashlib.sha256(f"{entrypoint}\n{code}".encode("utf-8")).hexdigest()
        fn = self._script_cache.get(cache_key)
        if fn is None:
            namespace: Dict[str, Any] = {}
            try:
                exec(code, namespace, namespace)
            except Exception as e:
                raise PostProcessorError(f"python_script compile error: {e}") from e
            raw_fn = namespace.get(entrypoint)
            if not callable(raw_fn):
                raise PostProcessorError(f"python_script entrypoint '{entrypoint}' is missing or not callable")
            fn = raw_fn
            self._script_cache[cache_key] = fn

        try:
            return fn(generation_json, config)
        except Exception as e:
            raise PostProcessorError(f"python_script runtime error: {e}") from e
