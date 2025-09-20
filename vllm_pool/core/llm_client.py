from __future__ import annotations
from typing import List, Dict, Any
from vllm import LLM, SamplingParams
from .types import LLMResourceConfig, SamplingConfig

class LLMClient:
    """Thin adapter around vLLM to keep core testable and swappable."""
    def __init__(self, model_name: str, res_cfg: LLMResourceConfig):
        self.model_name = model_name
        self.llm = LLM(model_name, **res_cfg.to_vllm_kwargs())
        self.res_cfg = res_cfg

    def generate_simple(self, prompts: List[str], sc: SamplingConfig) -> List[Dict[str, str]]:
        params = SamplingParams(temperature=sc.temperature, top_p=sc.top_p, max_tokens=sc.max_tokens)
        outs = self.llm.generate(prompts, sampling_params=params, use_tqdm=True)
        return [{prompts[i]: out.outputs[0].text.strip()} for i, out in enumerate(outs)]

    def generate_chat(self, prompts: List[Dict[str, Any]], sc: SamplingConfig, output_field: str = "output") -> List[Dict]:
        params = SamplingParams(temperature=sc.temperature, top_p=sc.top_p, max_tokens=sc.max_tokens)
        outs = self.llm.chat(
            messages=[p["messages"] for p in prompts],
            sampling_params=params,
            chat_template_kwargs={"enable_thinking": False},
            use_tqdm=True,
        )
        return [{**prompts[i].get("metadata", {}), output_field: outs[i].outputs[0].text.strip()} for i in range(len(outs))]

    def close(self) -> None:
        import torch
        del self.llm
        torch.cuda.empty_cache()
