#!/usr/bin/env bash
set -euo pipefail
export PYTHONUNBUFFERED=1
uvicorn vllm_pool.main:app --host 0.0.0.0 --port 8000
