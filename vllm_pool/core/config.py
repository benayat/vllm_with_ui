from __future__ import annotations
import json
from .types import LLMResourceConfig

DEFAULT_CFG = LLMResourceConfig(
    gpu_memory_utilization=0.92,
    max_model_len=4096,
    max_num_seqs=32,
    max_num_batched_tokens=8192,
    block_size=16,
    tensor_parallel_size=1,
    dtype="auto",
    trust_remote_code=True,
    disable_log_stats=True,
    max_parallel_loading_workers=2,
)

DEFAULT_CFG_STR = json.dumps(DEFAULT_CFG.to_vllm_kwargs(), indent=2)
