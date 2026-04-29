#!/usr/bin/env bash
set -euo pipefail
export PYTHONUNBUFFERED=1
export ALLOW_RUNTIME_DEP_INSTALL=true
source .venv/bin/activate
uvicorn vllm_pool.main:app --host 0.0.0.0 --port 8001
