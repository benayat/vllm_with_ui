from __future__ import annotations
import logging
from typing import List, Dict, Any

import torch
from tqdm.auto import tqdm
from transformers import AutoTokenizer
from vllm import LLM, SamplingParams, TokensPrompt

from .types import LLMResourceConfig, SamplingConfig


class LLMClient:
    """vLLM client with robust chat handling via HF chat templates + pre-tokenization."""

    def __init__(self, model_name: str, res_cfg: LLMResourceConfig):
        self.model_name = model_name
        self.res_cfg = res_cfg
        self.disable_thinking = (
            ("qwen3" in model_name.lower() or "deepseek" in model_name.lower())
            and "instruct" not in model_name.lower()
        )
        self.is_deepseek = "deepseek" in model_name.lower()
        self.llm = LLM(model_name, **res_cfg.to_vllm_kwargs())
        self.tokenizer = AutoTokenizer.from_pretrained(
            model_name,
            use_fast=True,
            trust_remote_code=self.res_cfg.trust_remote_code,
        )

        logging.info("LLMClient initialized for model=%s", self.model_name)

    def _post_process_output(self, text: str) -> str:
        """Extract assistant-visible text for model families that emit thoughts."""
        if not self.is_deepseek:
            return text

        think_end = "</think>\n\n"
        if think_end in text:
            return text[text.find(think_end) + len(think_end):].strip()
        return text

    def _messages_to_text(self, messages: List[Dict[str, str]]) -> str:
        return self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=not self.disable_thinking,
        )

    def _batch_tokenize_messages(self, prompts: List[Dict[str, Any]]) -> List[TokensPrompt]:
        messages_list = [p["messages"] for p in prompts]
        texts = [self._messages_to_text(msgs) for msgs in tqdm(messages_list, desc="Building chat texts")]
        enc = self.tokenizer(
            texts,
            padding=False,
            truncation=False,
            add_special_tokens=False,
            return_attention_mask=False,
        )
        return [TokensPrompt(prompt_token_ids=ids) for ids in enc["input_ids"]]

    def generate_simple(self, prompts: List[str], sc: SamplingConfig) -> List[Dict[str, str]]:
        params = SamplingParams(
            temperature=sc.temperature,
            top_p=sc.top_p,
            max_tokens=sc.max_tokens,
            n=sc.n,
            seed=sc.seed,
        )
        outs = self.llm.generate(prompts, sampling_params=params, use_tqdm=True)
        return [{prompts[i]: out.outputs[0].text.strip()} for i, out in enumerate(outs)]

    def generate_chat(self, prompts: List[Dict[str, Any]], sc: SamplingConfig, output_field: str = "output") -> List[Dict]:
        params = SamplingParams(
            temperature=sc.temperature,
            top_p=sc.top_p,
            max_tokens=sc.max_tokens,
            n=sc.n,
            seed=sc.seed,
        )

        try:
            tokenized_prompts = self._batch_tokenize_messages(prompts)
            outs = self.llm.generate(
                prompts=tokenized_prompts,
                sampling_params=params,
                use_tqdm=True,
            )
            return [
                {
                    **prompts[i].get("metadata", {}),
                    output_field: self._post_process_output(outs[i].outputs[0].text.strip()),
                }
                for i in range(len(outs))
            ]
        except Exception as e:
            logging.exception("Error in generate_chat")
            return [
                {
                    **prompts[i].get("metadata", {}),
                    output_field: f"[ERROR] {str(e)}",
                }
                for i in range(len(prompts))
            ]

    def close(self) -> None:
        del self.llm
        torch.cuda.empty_cache()
