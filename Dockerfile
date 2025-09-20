# -----------------------------------------------------------------------------
# vLLM Pool Dockerfile
# - CUDA runtime base
# - CUDA-enabled PyTorch (configurable)
# - vLLM + FastAPI app
# - HF_HOME configurable via ARG/ENV
# -----------------------------------------------------------------------------

# ---- Base: NVIDIA CUDA runtime with cuDNN (Ubuntu 22.04) --------------------
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

# ---- Build args (override at build time if needed) --------------------------
ARG DEBIAN_FRONTEND=noninteractive
ARG PYTHON_VERSION=3.10
ARG TORCH_VERSION=2.3.1
ARG CUDA_CHANNEL=cu121            # match base CUDA (cu121)
ARG UVICORN_PORT=8000

# Allow caller to set HF cache dir at build-time; can also override at run-time.
ARG HF_HOME=/root/.cache/huggingface

# ---- System deps ------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip python3-dev \
    build-essential \
    git ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Ensure `python` points to python3
RUN update-alternatives --install /usr/bin/python python /usr/bin/python3 1

# ---- Environment ------------------------------------------------------------
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=${HF_HOME}

# You can also export additional vLLM/runtime envs here if desired:
# ENV VLLM_NO_DEPRECATION_WARNING=1

# ---- Workdir ----------------------------------------------------------------
WORKDIR /app

# ---- Copy dependency metadata first (better caching) ------------------------
COPY pyproject.toml /app/pyproject.toml

# ---- Install CUDA-enabled PyTorch first (explicit wheel index) --------------
# Using the official PyTorch wheel index for the chosen CUDA channel.
RUN pip3 install --upgrade pip && \
    pip3 install --no-cache-dir \
      torch==${TORCH_VERSION}+${CUDA_CHANNEL} \
      --index-url https://download.pytorch.org/whl/${CUDA_CHANNEL}

# ---- Install project deps (includes fastapi, uvicorn, vllm from pyproject) ---
# If you prefer to pin vLLM explicitly, add it in pyproject.toml; otherwise:
# RUN pip3 install "vllm==0.5.3"
RUN pip3 install -e .

# ---- Copy application code ---------------------------------------------------
COPY vllm_pool /app/vllm_pool
COPY scripts /app/scripts
# Optional: keep the README in the image
COPY README.md /app/README.md

# ---- Create a non-root user -------------------------------------------------
# If HF_HOME points to a different path, ensure permissions at runtime.
RUN useradd -m -u 1000 appuser && \
    mkdir -p ${HF_HOME} && chown -R appuser:appuser ${HF_HOME} /app
USER appuser

# ---- Expose & Entrypoint ----------------------------------------------------
EXPOSE ${UVICORN_PORT}

# Default command: start the API server.
# Use NVIDIA runtime: `--gpus all` when running the container.
CMD ["uvicorn", "vllm_pool.main:app", "--host", "0.0.0.0", "--port", "8000"]
