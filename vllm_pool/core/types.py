from __future__ import annotations
from dataclasses import dataclass
from typing import Optional, Dict, Any, List, Literal


@dataclass
class LLMResourceConfig:
    gpu_memory_utilization: float
    max_model_len: int
    max_num_seqs: int
    max_num_batched_tokens: int
    block_size: int
    tensor_parallel_size: int
    dtype: str
    trust_remote_code: bool
    disable_log_stats: bool
    max_parallel_loading_workers: Optional[int] = None
    enable_prefix_caching: bool = True
    enforce_eager: bool = False
    enable_chunked_prefill: bool = False
    model_impl: Literal["vllm", "transformers"] = "vllm"

    def __post_init__(self) -> None:
        if self.model_impl not in {"vllm", "transformers"}:
            raise ValueError("model_impl must be either 'vllm' or 'transformers'.")

    def scale_for_model_size(self, model_size_b: float) -> None:
        """Scale selected config knobs for a given model size in billions."""
        if model_size_b <= 0:
            raise ValueError("Model size must be positive.")

        scale_factor = 1 / model_size_b
        self.gpu_memory_utilization = 0.9
        self.max_num_seqs = int(128 * scale_factor)
        self.max_num_batched_tokens = int(65536 * scale_factor)

    def to_vllm_kwargs(self) -> Dict[str, Any]:
        return {
            "gpu_memory_utilization": self.gpu_memory_utilization,
            "max_model_len": self.max_model_len,
            "max_num_seqs": self.max_num_seqs,
            "max_num_batched_tokens": self.max_num_batched_tokens,
            "block_size": self.block_size,
            "tensor_parallel_size": self.tensor_parallel_size,
            "dtype": self.dtype,
            "trust_remote_code": self.trust_remote_code,
            "disable_log_stats": self.disable_log_stats,
            "max_parallel_loading_workers": self.max_parallel_loading_workers,
            "enable_prefix_caching": self.enable_prefix_caching,
            "enforce_eager": self.enforce_eager,
            "model_impl": self.model_impl,
            "enable_chunked_prefill": self.enable_chunked_prefill,
        }


@dataclass(frozen=True)
class SamplingConfig:
    temperature: float = 0.0
    top_p: float = 1.0
    max_tokens: int = 1024
    n: int = 1
    seed: int = 12345


@dataclass(frozen=True)
class ChatMessage:
    role: str
    content: str


@dataclass(frozen=True)
class ChatItem:
    messages: List[ChatMessage]
    metadata: Optional[Dict[str, Any]] = None
