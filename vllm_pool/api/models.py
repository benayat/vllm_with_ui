from __future__ import annotations
from typing import Optional, List, Dict, Any
from pydantic import BaseModel

class StartRequest(BaseModel):
    model_name: str
    config: Dict[str, Any]
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
    prompts: List[str] | str
    sampling: SamplingConfigModel

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
