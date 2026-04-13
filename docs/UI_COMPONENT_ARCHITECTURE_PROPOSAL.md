# vLLM Pool UI Component Architecture Proposal

## Why this change

The current UI implementation is powerful but concentrated in a single large script (`app.js`) that owns API calls, validation, state, DOM rendering, and event wiring in one place. This makes feature delivery, testing, and backend contract changes slower than they need to be.

This proposal defines a component-based frontend architecture that keeps the current functionality, but reorganizes responsibilities into clear modules and reusable UI components.

---

## 1) Architecture goals

1. **Scale safely**: add features without touching unrelated parts of the UI.
2. **Backend-aligned contracts**: isolate API contract handling from UI widgets.
3. **Predictable state flow**: single source of truth per domain.
4. **Incremental migration**: refactor without a full rewrite.
5. **Testability**: unit-testable modules for validators, adapters, and store transitions.

---

## 2) Target architecture (layered)

## 2.1 Presentation layer (components)

UI is split into small, focused components. Components only render and emit events.

- `AppShell`
  - Header, global health indicator, route/tab shell
- `ModelControlPanel`
  - Start model, stop worker, model/worker selectors
- `GenerateWorkspace`
  - Simple / Chat mode container
- `PromptEditor`
  - Prompt / message input and prompt bank interactions
- `SamplingEditor`
  - Temperature/top_p/max_tokens controls and sampling presets
- `ProcessorConfigPanel`
  - Pre/post processor list, presets, script builder entrypoint
- `JobQueuePanel`
  - Job status cards, retry/cancel actions
- `ResultInspector`
  - Summary cards, table preview, raw JSON view, copy/save actions
- `ActivityFeed`
  - Toasts and event timeline

Each component has:
- `render(state, props)`
- `bindEvents(emit)`
- optional `validate()` and `serialize()` hooks for form components.

## 2.2 Application layer (feature controllers)

Controllers orchestrate use-cases and translate component events into state transitions.

- `modelController`
  - start/stop model, refresh workers/models, auto-start policy
- `generationController`
  - submit simple/chat jobs, queue/poll/SSE behavior
- `stateController`
  - load/save UI state (`/ui_state`), synchronize banks/presets
- `validationController`
  - centralized validation rules for JSON/text/file inputs

Controllers do **not** manipulate DOM directly; they only dispatch actions and call services.

## 2.3 Domain/state layer (stores)

A small store per domain with immutable updates:

- `appStore`
  - app health, active tab, toasts, busy flags
- `modelStore`
  - workers, models, selected model/worker, lifecycle state
- `generateStore`
  - simple/chat form drafts, sampling settings, processor config
- `jobStore`
  - active jobs, statuses, poll metadata, last results
- `uiStateStore`
  - persisted banks/presets and recovery metadata

Recommended API:

```js
store.getState();
store.dispatch({ type, payload });
store.subscribe(listener);
```

This can be implemented using a lightweight custom store (no framework required).

## 2.4 Infrastructure layer (services/adapters)

All backend integration is isolated here.

- `apiClient`
  - `getStatus`, `getModels`, `startModel`, `stopWorker`, `submitSimple`, `submitChat`, `getJob`, `getUiState`, `setUiState`
- `sseClient`
  - open/close subscriptions and normalize event payloads
- `jobPollingService`
  - retry/backoff, dedupe, completion detection
- `storageService`
  - localStorage/sessionStorage wrappers and schema versioning
- `loggerService`
  - structured frontend logs for debugging and telemetry

## 2.5 Contract layer (DTO mappers)

Add request/response adapters between UI models and backend payloads:

- `toStartModelRequest(uiModel)`
- `toGenerateSimpleRequest(uiModel)`
- `toGenerateChatRequest(uiModel)`
- `fromStatusResponse(apiStatus)`
- `fromJobResponse(apiJob)`

This avoids leaking backend schema details into presentation components.

---

## 3) Proposed file/folder structure

```text
vllm_pool/ui/static/
  app/
    main.js                     # bootstrap
    shell/
      AppShell.js
      RouterTabs.js
    components/
      model/
        ModelControlPanel.js
        WorkerSelector.js
      generate/
        GenerateWorkspace.js
        PromptEditor.js
        SamplingEditor.js
        ProcessorConfigPanel.js
      jobs/
        JobQueuePanel.js
        JobCard.js
      result/
        ResultInspector.js
        ResultSummary.js
        ResultJsonView.js
      feedback/
        ToastHost.js
        ActivityFeed.js
    controllers/
      modelController.js
      generationController.js
      stateController.js
      validationController.js
    stores/
      createStore.js
      appStore.js
      modelStore.js
      generateStore.js
      jobStore.js
      uiStateStore.js
    services/
      apiClient.js
      sseClient.js
      jobPollingService.js
      storageService.js
      loggerService.js
    adapters/
      requests.js
      responses.js
    validators/
      jsonValidators.js
      formValidators.js
    styles/
      tokens.css
      base.css
      components.css
      utilities.css
```

---

## 4) Component interaction model

### Event flow

1. User interacts with a component (`PromptEditor`).
2. Component emits event (`PROMPT_UPDATED`).
3. Controller handles event and dispatches store update.
4. Store notifies subscribers.
5. Bound components re-render from updated state.

### Async flow example (Run generation)

1. `GenerateWorkspace` emits `SUBMIT_SIMPLE_REQUESTED`.
2. `generationController` validates via `validationController`.
3. Request adapter transforms UI draft to API payload.
4. `apiClient.submitSimple` sends request.
5. `jobStore` receives `JOB_CREATED`.
6. `jobPollingService` or `sseClient` updates job status.
7. `ResultInspector` updates automatically from `jobStore`.

---

## 5) Backend integration strategy (smooth and future-proof)

## 5.1 Stable boundary contracts

Define explicit contract modules for each endpoint used by the UI:

- `/status`
- `/models`
- `/start`
- `/stop`
- `/generate`
- `/generate_chat`
- `/jobs/{id}`
- `/ui_state`
- SSE events stream

Each contract includes:
- request shape (required/optional fields)
- response shape
- error model normalization
- version notes

## 5.2 Error normalization

Create one function for all API errors:

```js
normalizeApiError(error) => {
  code,
  userMessage,
  retryable,
  details,
}
```

This gives consistent messaging in toasts, inline field states, and activity feed.

## 5.3 Compatibility adapters

When backend payloads evolve, update adapters first instead of component code. This minimizes UI churn.

---

## 6) State model (high level)

```js
{
  app: {
    activeTab,
    health,
    isBusy,
    toasts,
  },
  model: {
    models,
    workers,
    selectedModel,
    selectedWorker,
    startConfig,
  },
  generate: {
    simpleDraft,
    chatDraft,
    simpleValidation,
    chatValidation,
    presets,
    promptBank,
    samplingBank,
  },
  jobs: {
    byId,
    activeIds,
    latestResultId,
  },
  persisted: {
    lastLoadedAt,
    schemaVersion,
  }
}
```

---

## 7) Migration plan (incremental, low-risk)

## Phase 1: foundation scaffolding
- Introduce `app/main.js`, `services/apiClient.js`, and `stores/createStore.js`.
- Keep existing HTML and CSS mostly intact.
- Route existing fetch calls through `apiClient`.

## Phase 2: extract feature islands
- Extract `ResultInspector` and `ActivityFeed` first (lowest coupling).
- Extract `ModelControlPanel` next.
- Preserve old functions as wrappers until replacement is complete.

## Phase 3: generation workspace modularization
- Split simple/chat editors into `GenerateWorkspace` children.
- Move validators to `validators/` and adapters to `adapters/`.

## Phase 4: remove legacy monolith wiring
- Delete replaced logic from old `app.js`.
- Keep a small compatibility layer for event bootstrapping.

## Phase 5: hardening
- Add unit tests for validators/adapters/stores.
- Add integration smoke tests for start → generate → result flow.

---

## 8) Testing strategy

1. **Unit tests**
   - validators: JSON structure checks, file-based input checks
   - adapters: request/response mapping snapshots
   - stores: reducer/action transitions

2. **Integration tests**
   - model start/stop flow
   - simple/chat generation flow
   - ui_state load/save flow
   - polling/SSE fallback behavior

3. **UI behavior checks**
   - disabled states while requests are in flight
   - consistent toast + inline errors
   - responsive layout checks across breakpoints

---

## 9) Definition of done for the architecture initiative

- No direct `fetch` calls inside presentational components.
- No component directly mutates another component's DOM.
- Validation logic is centralized and reusable.
- API schema changes are handled in adapters/services only.
- New feature (e.g., additional generation mode) can be added by composing existing building blocks.

---

## 10) First slice recommendation (what to do first)

If we start implementation immediately, the best first vertical slice is:

1. Add `apiClient` + `normalizeApiError`.
2. Add `appStore` + `jobStore`.
3. Extract `ResultInspector` and `ActivityFeed`.
4. Keep everything else in existing file temporarily.

This gives immediate gains (clear boundaries + better backend integration) with minimal disruption.

---

## 11) Discussion prompts

To align before implementation, we should confirm:

1. **Framework direction**: stay vanilla JS + modules, or adopt a framework (React/Vue/Svelte).
2. **State strategy**: custom store vs lightweight library.
3. **SSE vs polling preference**: primary channel and failover policy.
4. **Testing depth**: minimum required coverage for merge gates.
5. **Migration tolerance**: parallel legacy/new code duration.

