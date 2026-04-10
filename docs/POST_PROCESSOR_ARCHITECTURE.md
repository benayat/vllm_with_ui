# Post-Processor Pipeline Architecture (Design Proposal)

## Goal
Add an optional **post-processor stage** for LLM generation outputs in both:
- `/generate/simple`
- `/generate/chat`
- `/generate/offline` (for `type=generate` and `type=chat`)

The post-processor should:
1. Receive the **generation result JSON** as input.
2. Perform arbitrary transformation / enrichment logic.
3. Return a **new JSON** object that is attached to the job output.

Additionally, backend must support installing missing Python dependencies via:
- `uv pip install <dependency>`

---

## High-level design

Introduce a new backend component:
- `PostProcessorManager` (new module under `vllm_pool/core/`)

And a request-contract extension:
- Optional `post_processor` object added to generation request models.

The generation flow becomes:
1. Validate request.
2. Generate LLM output (existing behavior).
3. If `post_processor` provided:
   - Ensure dependencies are available (install if allowed/needed).
   - Execute processor.
   - Persist processor output + metadata.
4. Return combined result JSON.

---

## API contract proposal

### 1) New request object: `post_processor`

```json
{
  "name": "jsonpath_filter",
  "config": {"paths": ["$.items[*].score"]},
  "runtime": {
    "dependencies": ["jsonpath-ng==1.6.1"],
    "auto_install": true
  }
}
```

### 2) Add to request models
- `GenerateSimpleRequest.post_processor: Optional[PostProcessorSpec]`
- `GenerateChatRequest.post_processor: Optional[PostProcessorSpec]`
- `OfflineJobRequest.post_processor: Optional[PostProcessorSpec]`

### 3) Result contract

Current result payload remains unchanged when no post-processor is specified.

When post-processing is requested:
```json
{
  "job_id": "abcd1234",
  "status": "done",
  "result": {
    "generation": { /* current raw generation JSON */ },
    "post_processing": {
      "name": "jsonpath_filter",
      "status": "ok",
      "output": { /* transformed JSON */ },
      "timing_ms": 12
    }
  }
}
```

If post-processor fails and `on_error=fail`:
- Job status becomes `error`.

If post-processor fails and `on_error=continue`:
- Job status stays `done`, and include error metadata in `post_processing`.

---

## Post-processor architecture

## A) Registry-based processor execution

Create a processor registry:
- `vllm_pool/core/post_processors/registry.py`
- Built-in processors implement a stable interface:

```python
class BasePostProcessor(Protocol):
    name: str
    def run(self, generation_json: dict, config: dict) -> dict: ...
```

Benefits:
- Deterministic, auditable built-ins.
- Easy to expand (new processors added by registration).
- Avoids executing arbitrary unsafe code in requests.

## B) Dependency installer service

Create `DependencyInstaller` in `vllm_pool/core/dependency_installer.py`:
- Accept list of pinned requirements.
- Validate requirement syntax and deny dangerous tokens.
- Install each package via subprocess:
  - `uv pip install <requirement>`
- Cache installed set in-memory + optional persisted marker file.
- Return install report:
  - installed / already_present / failed.

Configuration toggles:
- `ALLOW_RUNTIME_DEP_INSTALL=true|false` (default false for safety).
- `POST_PROCESSOR_MAX_DEPS` integer limit.
- `POST_PROCESSOR_INSTALL_TIMEOUT_SEC`.

## C) Orchestrator

`PostProcessorManager.execute(spec, generation_json)`:
1. Validate processor name exists.
2. Resolve runtime dependency plan.
3. Optionally install missing deps.
4. Import/instantiate processor.
5. Execute processor with timeout.
6. Return structured execution report.

---

## Integration points in existing code

## 1) API models
File: `vllm_pool/api/models.py`
- Add pydantic models:
  - `PostProcessorRuntimeModel`
  - `PostProcessorSpecModel`
- Add `post_processor` optional field to simple/chat/offline request models.

## 2) Router layer
File: `vllm_pool/api/router_generate.py`
- Pass `post_processor` into queued command payload for:
  - `/generate/simple`
  - `/generate/chat`
  - `/generate/offline`

## 3) Worker execution
File: `vllm_pool/core/worker.py`
- After generation success, call `PostProcessorManager` if spec exists.
- Emit `result` with both `generation` and `post_processing` sections.

## 4) UI integration (both simple + chat modes)
Files:
- `vllm_pool/ui/templates/index.html`
- `vllm_pool/ui/static/app.js`

Add a new JSON input box in each mode:
- "Post-processor spec (optional JSON)"

Pass through to API payload.

---

## Error handling policy

Request-level options (inside `post_processor`):
- `on_error`: `"fail" | "continue"` (default `fail`)

Rules:
- Validation error of post-processor spec => HTTP 422.
- Dependency install failure:
  - `fail`: job error.
  - `continue`: include error in `post_processing`, return generation.
- Runtime exception in processor:
  - same behavior controlled by `on_error`.

---

## Security and safety

1. **No arbitrary code upload** in request body.
2. Only allow processors from explicit registry.
3. Require pinned dependency versions in runtime install mode.
4. Add allowlist/blocklist support for dependencies.
5. Impose timeouts for install and run.
6. Add size limits for input/output JSON.
7. Redact sensitive fields in logs.

---

## Observability

For each post-processing run, capture:
- processor name
- dependency install actions
- timing
- success/failure
- error message (sanitized)

Expose concise status in existing `/jobs/{job_id}` result.

---

## Backward compatibility

- If `post_processor` omitted, behavior is unchanged.
- Existing clients remain valid.
- New fields are additive.

---

## Suggested implementation plan (phased)

### Phase 1 (safe MVP)
- Add request models and command plumb-through.
- Add built-in post-processor registry with one sample processor (`identity`, `jq_like_extract`).
- Add manager execution without runtime dependency installation.
- Add UI inputs for simple/chat.

### Phase 2
- Add `DependencyInstaller` with `uv pip install` integration.
- Add env-based toggle and limits.
- Add strict validation for dependency strings.

### Phase 3
- Add more built-in processors.
- Add richer telemetry and audit logs.
- Add optional persistence for install cache across restarts.

---

## Acceptance criteria for implementation

1. User can submit `post_processor` in simple mode and receive transformed JSON.
2. User can submit `post_processor` in chat mode and receive transformed JSON.
3. Offline endpoint supports same post-processing contract.
4. If dependency missing and auto-install enabled, backend runs `uv pip install <dependency>` and succeeds.
5. If install fails, behavior follows `on_error` policy.
6. Existing requests (without post-processor) remain unchanged.

---

## Open questions for approval

1. Should post-processing run per item (each prompt result) or once on the full result payload? (Recommended: full payload first, add per-item mode later.)
2. Default `on_error`: `fail` (strict) or `continue` (lenient)? (Recommended: `fail`.)
3. Should dependency auto-install be enabled by default in non-production only? (Recommended: disabled by default.)
4. Do we want only built-in processors initially, or include plugin loading from a safe local path?

