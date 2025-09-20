# vLLM Pool — Multi-GPU Process Manager with Per-GPU Live Tails

A FastAPI service and minimal UI to manage up to N independent **vLLM** workers (one process per GPU) with a clear separation of concerns:

* **Start Model Panel**: lifecycle & vLLM resource config (per worker / GPU).
* **Generate Panel**: send prompts to **already-running** models only.
* **Per-GPU Live Tail**: SSE streams the **last 5 log/tqdm lines** from each worker; pick the active GPU tail from a dropdown.

Object-oriented core (Python) split into domain types, worker, pool, and an adapter for vLLM.

---

## Features

* ✅ One worker process per GPU with `spawn` start method (safe with PyTorch/vLLM).
* ✅ Load the **same model on multiple GPUs** or different models per GPU.
* ✅ Strict separation: **only** Start panel controls lifecycle; Generate only prompts.
* ✅ **Per-GPU** SSE endpoint streaming log tail every \~2s (tqdm included).
* ✅ Batch generation:

    * **Simple**: array of strings.
    * **Chat**: array of chat items `{messages:[{role, content}], metadata?}`.
* ✅ Editable **vLLM resource config** JSON (defaults shown in UI).
* ✅ JSON responses + “Save as JSON” in the UI.
* ✅ Clean OOD design; core logic independent of the web layer.

---

## Project Structure

```
vllm_pool/
├── pyproject.toml
├── README.md
├── .env.example
├── vllm_pool/
│   ├── __init__.py
│   ├── main.py                  # FastAPI app factory + mounts + entry
│   ├── api/
│   │   ├── __init__.py
│   │   ├── models.py            # Pydantic schemas
│   │   ├── router_start.py      # /start, /stop
│   │   ├── router_status.py     # /status, /models, /workers
│   │   ├── router_generate.py   # /generate/simple, /generate/chat
│   │   └── router_events.py     # /events/worker/{key:path} (SSE per worker)
│   ├── core/
│   │   ├── __init__.py
│   │   ├── config.py            # default vLLM config
│   │   ├── types.py             # dataclasses: resource & sampling, chat
│   │   ├── llm_client.py        # vLLM adapter
│   │   ├── worker.py            # worker loop + log tail capture
│   │   └── pool.py              # PoolManager: lifecycle, queueing, SSE subs
│   ├── ui/
│   │   ├── __init__.py
│   │   ├── templates/
│   │   │   └── index.html       # Start/Status/Generate UI
│   │   └── static/
│   │       └── app.js           # UI logic + fetch + SSE
│   └── utils/
│       ├── __init__.py
│       └── logging.py
└── scripts/
    └── run.sh
```

---

## Requirements

* Python **3.10+**
* CUDA-capable GPUs with compatible NVIDIA drivers
* PyTorch `>=2.1.0` and vLLM `>=0.5.3`
* Linux recommended (tested with `spawn` start method)

---

## Installation

```bash
# clone your repo
pip install -e .  # uses pyproject.toml; installs fastapi, uvicorn, vllm, torch
```

> If you manage CUDA/PyTorch separately, install the matching `torch` build before `pip install -e .`.

---

## Running

```bash
uvicorn vllm_pool.main:app --host 0.0.0.0 --port 8000
# or
./scripts/run.sh
```

Open the UI at `http://localhost:8000`.

---

## UI Workflow

1. **Start model (left)**

    * Enter **Model name** (e.g., `meta-llama/Llama-3.2-1B-Instruct`).
    * Optionally set **GPU id** (0-based). If empty, first free GPU is used.
    * Edit the **vLLM config JSON** (defaults provided).
    * Click **Start**.
    * You can **Stop** a worker by model + GPU id.

2. **Status & Live GPU tail (right)**

    * **Refresh** to view running workers & queues.
    * Select a worker from the dropdown to watch its **live 5-line tail** (tqdm/logs).

3. **Generate (full width)**
   Tabs:

    * **Simple**:

        * Choose **Model** (dropdown of loaded models).
        * Set **Sampling params** JSON.
        * Paste **Prompts JSON** (array of strings) or **Upload** a JSON file.
    * **Chat**:

        * Choose **Model**.
        * Set **Sampling params**.
        * Provide **Messages JSON** (array of chat items) or **Upload**.
        * **Output field** name (e.g., `"output"`).
    * Results appear below; click **Save as JSON**.

> The Generate panel **never** starts models. If the model isn’t running: API returns **409**.

---

## REST API

### Start a worker

```
POST /start
Content-Type: application/json
```

```json
{
  "model_name": "meta-llama/Llama-3.2-1B-Instruct",
  "config": {
    "gpu_memory_utilization": 0.92,
    "max_model_len": 4096,
    "max_num_seqs": 32,
    "max_num_batched_tokens": 8192,
    "block_size": 16,
    "tensor_parallel_size": 1,
    "dtype": "auto",
    "trust_remote_code": true,
    "disable_log_stats": true,
    "max_parallel_loading_workers": 2
  },
  "gpu_id": 0
}
```

Response:

```json
{ "model_name":"...", "gpu_id":0, "pid":12345, "status":"ready" }
```

### Stop a worker

```
POST /stop
Content-Type: multipart/form-data
```

Form fields: `model_name`, `gpu_id`

### Status / models / workers

* `GET /status` – GPUs, running workers, queues
* `GET /models` – unique set of loaded models
* `GET /workers` – `[{ key: "<model>|<gpu>", model, gpu_id }]`

### Generate (Simple)

```
POST /generate/simple
Content-Type: application/json
```

```json
{
  "model_name": "meta-llama/Llama-3.2-1B-Instruct",
  "prompts": ["Hello", "Explain transformers in 3 bullets"],
  "sampling": { "temperature": 0.0, "top_p": 1.0, "max_tokens": 256, "batch_size": 1 }
}
```

Response:

```json
{ "job_id": "a1b2c3d4", "result": [ {"Hello": "..."}, {"Explain transformers...": "..."} ] }
```

### Generate (Chat)

```
POST /generate/chat
Content-Type: application/json
```

```json
{
  "model_name": "meta-llama/Llama-3.2-1B-Instruct",
  "prompts": [
    {
      "messages": [
        {"role": "user", "content": "Summarize attention."}
      ],
      "metadata": {"id": "1"}
    }
  ],
  "sampling": { "temperature": 0.0, "top_p": 1.0, "max_tokens": 256, "batch_size": 1 },
  "output_field": "output"
}
```

Response:

```json
{ "job_id": "f00dbabe", "result": [ {"id":"1", "output":"..."} ] }
```

### Per-worker SSE tail

```
GET /events/worker/{key}
# key format: {model}|{gpu_id}, slashes in model preserved via {key:path}
# Example (URL-encoded): /events/worker/meta-llama/Llama-3.2-1B-Instruct%7C0
```

Events:

* `event: tail` `data: {"lines": ["…up to 5 lines…"]}`

> The server sends a snapshot every \~2 seconds, even when idle.

---

## JSON Shapes

* **Sampling params** (both Simple & Chat):

  ```json
  { "temperature": 0.0, "top_p": 1.0, "max_tokens": 256, "batch_size": 1 }
  ```
* **Chat item**:

  ```json
  {
    "messages": [ {"role":"user","content":"Hi"}, {"role":"assistant","content":"..."} ],
    "metadata": { "id":"123" }
  }
  ```

---

## Configuration

Default vLLM config (editable in UI):

```json
{
  "gpu_memory_utilization": 0.92,
  "max_model_len": 4096,
  "max_num_seqs": 32,
  "max_num_batched_tokens": 8192,
  "block_size": 16,
  "tensor_parallel_size": 1,
  "dtype": "auto",
  "trust_remote_code": true,
  "disable_log_stats": true,
  "max_parallel_loading_workers": 2
}
```

Tips:

* For large models or tight VRAM, reduce `max_model_len`, `max_num_batched_tokens`, or `max_num_seqs`.
* Keep `tensor_parallel_size=1` unless you explicitly shard a single model across multiple GPUs (this code runs one model per worker/GPU).

---

## Design Notes (OOD)

* **core/** is framework-free:

    * `types.py` – immutable dataclasses for resource & sampling configs.
    * `llm_client.py` – adapter around `vllm.LLM` (swap or mock in tests).
    * `worker.py` – single-responsibility worker loop; **TailCapture** encapsulates tqdm/log capture.
    * `pool.py` – orchestration (start/stop/queueing/SSE broadcast). UI/HTTP unaware.
* **api/** binds a `PoolManager` instance to FastAPI routers (dependency inversion via `bind()`).
* **ui/** is minimal static HTML + JS; no build step.

---

## Troubleshooting

* **404 on SSE path with model names containing slashes**
  Ensure the route uses `{key:path}`:

  ```python
  @app.get("/events/worker/{key:path}")
  ```
* **“daemonic processes are not allowed to have children”**
  We force `spawn` and set `proc.daemon = False`. Don’t wrap app inside another daemonized process manager.
* **No GPUs detected**
  Check `nvidia-smi`. Make sure the container/host exposes GPUs and CUDA libraries.
* **Out of memory while loading**
  Lower `gpu_memory_utilization` or reduce `max_model_len`/`max_num_batched_tokens`/`max_num_seqs`.
* **SSE shows nothing**
  Worker might be idle; tail snapshots still arrive but could be empty. Start a job or watch model load logs.

---

## Development

Run app in dev:

```bash
uvicorn vllm_pool.main:app --reload --host 0.0.0.0 --port 8000
```

Suggested tests (pytest):

* `TailCapture` CR/newline behavior.
* Worker happy-path simple/chat.
* Pool queueing: multiple jobs, single model, single GPU.
* Routers with FastAPI `TestClient`.

---

## License

MIT (or your choice). Add your license text here.
