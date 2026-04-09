from __future__ import annotations
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, ConfigDict


class LLMResourceConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

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


class StartRequest(BaseModel):
    model_name: str
    config: Optional[LLMResourceConfigModel] = None
    gpu_id: Optional[int] = None


class StartResponse(BaseModel):
    model_name: str
    gpu_id: int
    pid: int
    status: str


class SamplingConfigModel(BaseModel):
    temperature: float = 0.0
    top_p: float = 1.0
    max_tokens: int = 1024
    n: int = 1
    seed: int = 12345


class GenerateSimpleRequest(BaseModel):
    model_name: str
    prompts: List[Dict[str, Any]]
    sampling: SamplingConfigModel
    include_metadata: bool = True


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatItem(BaseModel):
    messages: List[ChatMessage]
    metadata: Optional[Dict[str, Any]] = None


class GenerateChatRequest(BaseModel):
    model_name: str
    prompts: List[ChatItem]
    sampling: SamplingConfigModel
    output_field: str = "output"
    include_metadata: bool = True


class OfflineJobRequest(BaseModel):
    model_name: str
    type: str  # generate | chat
    prompts: List[Any]
    sampling: Optional[SamplingConfigModel] = None
    output_field: str = "output"
    include_metadata: bool = True
    cleanup_model_after_job: bool = False
