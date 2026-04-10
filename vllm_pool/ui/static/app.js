let lastResult = null;
let evtSource = null;

const samplingDefault = { temperature: 0.0, top_p: 1.0, max_tokens: 256 };
const UI_STATE_DEFAULT = {
    processor_presets: [],
    prompt_bank: { simple: [], chat: [] },
    sampling_bank: { simple: [], chat: [] },
};
let uiState = JSON.parse(JSON.stringify(UI_STATE_DEFAULT));

function switchTab(which) {
    const sBtn = document.getElementById('tabSimple');
    const cBtn = document.getElementById('tabChat');
    const sPanel = document.getElementById('panelSimple');
    const cPanel = document.getElementById('panelChat');
    if (which === 'simple') { sBtn.classList.add('tab-active'); cBtn.classList.remove('tab-active'); sPanel.style.display=''; cPanel.style.display='none'; }
    else { cBtn.classList.add('tab-active'); sBtn.classList.remove('tab-active'); cPanel.style.display=''; sPanel.style.display='none'; }
}

function showResult(obj){ lastResult = obj; document.getElementById('resultBox').textContent = JSON.stringify(obj,null,2); }
function clearResults(){ lastResult=null; document.getElementById('resultBox').textContent=''; }
function saveJSON(){
    if (!lastResult) { alert("No result to save yet."); return; }
    const blob = new Blob([JSON.stringify(lastResult, null, 2)], {type: "application/json"});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    const id = ('job_id' in lastResult) ? lastResult.job_id : 'result'; a.download = `${id}.json`;
    document.body.appendChild(a); a.click(); a.remove();
}
async function copyResultToClipboard() {
    if (!lastResult) { alert("No result to copy yet."); return; }
    try {
        await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
    } catch (e) {
        alert(`Copy failed: ${e.message}`);
    }
}

// NEW: polling
async function pollJob(jobId, onUpdateElId) {
    const el = document.getElementById(onUpdateElId);
    async function tick() {
        try {
            const res = await fetch(`/jobs/${jobId}`);
            const j = await res.json();
            if (j.status === 'done' || j.status === 'error' || j.status === 'canceled' || j.status === 'not_found') {
                el.innerHTML = `<span class="${j.status==='done'?'ok':'err'}">${j.status}</span>`;
                if (j.status === 'done') showResult({ job_id: jobId, result: j.result });
                else showResult({ job_id: jobId, status: j.status, error: j.error });
                return;
            }
            el.innerHTML = `<span class="muted">in-queue/running (job ${jobId})</span>`;
            setTimeout(tick, 1500);
        } catch (e) {
            el.innerHTML = `<span class="err">poll error: ${e.message}</span>`;
        }
    }
    tick();
}

async function refreshModels() {
    const res = await fetch('/models'); const j = await res.json();
    for (const id of ['g_model','c_model']) {
        const sel = document.getElementById(id); sel.innerHTML='';
        const arr = j.models || [];
        if (!arr.length) { const o=document.createElement('option'); o.value=''; o.textContent='— no models loaded —'; sel.appendChild(o); continue; }
        for (const m of arr) { const o=document.createElement('option'); o.value=m; o.textContent=m; sel.appendChild(o); }
    }
}

async function refreshWorkers() {
    const res = await fetch('/workers'); const j = await res.json();
    const sel = document.getElementById('workerSel'); sel.innerHTML='';
    const arr = j.workers || [];
    if (!arr.length) { const o=document.createElement('option'); o.value=''; o.textContent='— no workers —'; sel.appendChild(o); closeSSE(); document.getElementById('progressBox').textContent=''; return; }
    for (const w of arr) {
        const o=document.createElement('option');
        o.value = w.key; o.textContent = `gpu ${w.gpu_id} — ${w.model}`; sel.appendChild(o);
    }
    switchWorker();
}

async function refresh() {
    const el = document.getElementById('status'); el.textContent='...';
    try { const res = await fetch('/status'); el.textContent = JSON.stringify(await res.json(), null, 2); } catch(e){ el.textContent=e.message; }
    refreshModels(); refreshWorkers();
}

function closeSSE(){ if (evtSource){ try{ evtSource.close(); }catch(_){} evtSource=null; } }
function switchWorker(){
    const key = document.getElementById('workerSel').value;
    if (!key) { closeSSE(); document.getElementById('progressBox').textContent=''; return; }
    openSSE(`/events/worker/${encodeURIComponent(key)}`);
}
function openSSE(url) {
    closeSSE();
    evtSource = new EventSource(url);
    evtSource.addEventListener('tail', (ev) => {
        try { const obj = JSON.parse(ev.data); const lines = (obj.lines||[]).slice(-5);
            document.getElementById('progressBox').textContent = lines.join("\n"); }
        catch { /* ignore */ }
    });
}

function parseJSONSafe(text, fallback) { if (!text || !text.trim()) return fallback; try { return JSON.parse(text); } catch { return fallback; } }

async function loadUiState() {
    try {
        const res = await fetch('/ui/state');
        if (!res.ok) throw new Error('failed loading ui state');
        const data = await res.json();
        uiState = {
            processor_presets: Array.isArray(data.processor_presets) ? data.processor_presets : [],
            prompt_bank: data.prompt_bank && typeof data.prompt_bank === 'object' ? data.prompt_bank : { simple: [], chat: [] },
            sampling_bank: data.sampling_bank && typeof data.sampling_bank === 'object' ? data.sampling_bank : { simple: [], chat: [] },
        };
    } catch (_) {
        uiState = JSON.parse(JSON.stringify(UI_STATE_DEFAULT));
    }
}

async function persistUiStateSection(section, value) {
    uiState[section] = value;
    try {
        await fetch(`/ui/state/${section}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value }),
        });
    } catch (_) {
        // keep in-memory state even if persistence request fails
    }
}

function getProcessorPresets() {
    return Array.isArray(uiState.processor_presets) ? uiState.processor_presets : [];
}

function setProcessorPresets(items) {
    persistUiStateSection('processor_presets', items);
}

function refreshProcessorPresetSelectors() {
    const presets = getProcessorPresets();
    for (const prefix of ['g', 'c']) {
        const selectEl = document.getElementById(`${prefix}_pp_preset_select`);
        if (!selectEl) continue;
        selectEl.innerHTML = '';
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = '— choose preset —';
        selectEl.appendChild(defaultOpt);
        for (const p of presets) {
            const o = document.createElement('option');
            o.value = p.name;
            o.textContent = p.name;
            selectEl.appendChild(o);
        }
    }
}

function saveProcessorPreset(prefix) {
    const nameEl = document.getElementById(`${prefix}_pp_preset_name`);
    const specEl = document.getElementById(`${prefix}_post_processor`);
    const name = (nameEl.value || '').trim();
    const spec = parseJSONSafe(specEl.value, null);
    if (!name) { alert('Preset name is required.'); return; }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { alert('Post-processor spec must be a valid JSON object.'); return; }
    if (!spec.name || typeof spec.name !== 'string') { alert("Post-processor spec must include string field 'name'."); return; }

    const presets = getProcessorPresets().filter((p) => p.name !== name);
    presets.push({ name, spec });
    presets.sort((a, b) => a.name.localeCompare(b.name));
    setProcessorPresets(presets);
    refreshProcessorPresetSelectors();
    alert(`Saved preset '${name}'.`);
}

function applyProcessorPreset(prefix) {
    const selectEl = document.getElementById(`${prefix}_pp_preset_select`);
    const specEl = document.getElementById(`${prefix}_post_processor`);
    const selected = (selectEl.value || '').trim();
    if (!selected) return;
    const preset = getProcessorPresets().find((p) => p.name === selected);
    if (!preset) { alert(`Preset '${selected}' not found.`); return; }
    specEl.value = JSON.stringify(preset.spec, null, 2);
}

function deleteProcessorPreset(prefix) {
    const selectEl = document.getElementById(`${prefix}_pp_preset_select`);
    const selected = (selectEl.value || '').trim();
    if (!selected) { alert('Choose a preset to delete.'); return; }
    const presets = getProcessorPresets().filter((p) => p.name !== selected);
    setProcessorPresets(presets);
    refreshProcessorPresetSelectors();
}

function modeNameFromPrefix(prefix) {
    return prefix === 'c' ? 'chat' : 'simple';
}

function getBankMap(key) {
    const value = uiState[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function setBankMap(key, value) {
    persistUiStateSection(key, value);
}

function upsertNamedBankItem(key, mode, name, value) {
    const bank = getBankMap(key);
    const items = Array.isArray(bank[mode]) ? bank[mode] : [];
    const filtered = items.filter((it) => it && it.name !== name);
    filtered.push({ name, value });
    filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    bank[mode] = filtered;
    setBankMap(key, bank);
}

function getNamedBankItem(key, mode, name) {
    const bank = getBankMap(key);
    const items = Array.isArray(bank[mode]) ? bank[mode] : [];
    return items.find((it) => it && it.name === name) || null;
}

function deleteNamedBankItem(key, mode, name) {
    const bank = getBankMap(key);
    const items = Array.isArray(bank[mode]) ? bank[mode] : [];
    bank[mode] = items.filter((it) => it && it.name !== name);
    setBankMap(key, bank);
}

function refreshPromptBankSelectors() {
    for (const prefix of ['g', 'c']) {
        const mode = modeNameFromPrefix(prefix);
        const selectEl = document.getElementById(`${prefix}_prompt_bank_select`);
        if (!selectEl) continue;
        const bank = getBankMap('prompt_bank');
        const items = Array.isArray(bank[mode]) ? bank[mode] : [];
        selectEl.innerHTML = '';
        const d = document.createElement('option'); d.value = ''; d.textContent = '— prompt bank —'; selectEl.appendChild(d);
        for (const item of items) {
            const o = document.createElement('option');
            o.value = item.name;
            o.textContent = item.name;
            selectEl.appendChild(o);
        }
    }
}

function savePromptBankItem(prefix) {
    const mode = modeNameFromPrefix(prefix);
    const nameEl = document.getElementById(`${prefix}_prompt_bank_name`);
    const textareaId = prefix === 'c' ? 'c_msgs' : 'g_prompt';
    const contentEl = document.getElementById(textareaId);
    const name = (nameEl?.value || '').trim();
    const value = contentEl?.value || '';
    if (!name) { alert('Prompt preset name is required.'); return; }
    if (!value.trim()) { alert('Prompt JSON is empty.'); return; }
    upsertNamedBankItem('prompt_bank', mode, name, value);
    refreshPromptBankSelectors();
}

function loadPromptBankItem(prefix) {
    const mode = modeNameFromPrefix(prefix);
    const selectEl = document.getElementById(`${prefix}_prompt_bank_select`);
    const selected = (selectEl?.value || '').trim();
    if (!selected) return;
    const item = getNamedBankItem('prompt_bank', mode, selected);
    if (!item) { alert(`Prompt preset '${selected}' not found.`); return; }
    const textareaId = prefix === 'c' ? 'c_msgs' : 'g_prompt';
    const contentEl = document.getElementById(textareaId);
    contentEl.value = item.value || '';
}

function deletePromptBankItem(prefix) {
    const mode = modeNameFromPrefix(prefix);
    const selectEl = document.getElementById(`${prefix}_prompt_bank_select`);
    const selected = (selectEl?.value || '').trim();
    if (!selected) { alert('Choose a prompt preset to delete.'); return; }
    deleteNamedBankItem('prompt_bank', mode, selected);
    refreshPromptBankSelectors();
}

function refreshSamplingBankSelectors() {
    for (const prefix of ['g', 'c']) {
        const mode = modeNameFromPrefix(prefix);
        const selectEl = document.getElementById(`${prefix}_sampling_bank_select`);
        if (!selectEl) continue;
        const bank = getBankMap('sampling_bank');
        const items = Array.isArray(bank[mode]) ? bank[mode] : [];
        selectEl.innerHTML = '';
        const d = document.createElement('option'); d.value = ''; d.textContent = '— sampling bank —'; selectEl.appendChild(d);
        for (const item of items) {
            const o = document.createElement('option');
            o.value = item.name;
            o.textContent = item.name;
            selectEl.appendChild(o);
        }
    }
}

function saveSamplingBankItem(prefix) {
    const mode = modeNameFromPrefix(prefix);
    const nameEl = document.getElementById(`${prefix}_sampling_bank_name`);
    const textareaId = prefix === 'c' ? 'c_sampling' : 'g_sampling';
    const contentEl = document.getElementById(textareaId);
    const name = (nameEl?.value || '').trim();
    const value = contentEl?.value || '';
    if (!name) { alert('Sampling preset name is required.'); return; }
    if (!value.trim()) { alert('Sampling JSON is empty.'); return; }
    upsertNamedBankItem('sampling_bank', mode, name, value);
    refreshSamplingBankSelectors();
}

function loadSamplingBankItem(prefix) {
    const mode = modeNameFromPrefix(prefix);
    const selectEl = document.getElementById(`${prefix}_sampling_bank_select`);
    const selected = (selectEl?.value || '').trim();
    if (!selected) return;
    const item = getNamedBankItem('sampling_bank', mode, selected);
    if (!item) { alert(`Sampling preset '${selected}' not found.`); return; }
    const textareaId = prefix === 'c' ? 'c_sampling' : 'g_sampling';
    const contentEl = document.getElementById(textareaId);
    contentEl.value = item.value || '';
}

function deleteSamplingBankItem(prefix) {
    const mode = modeNameFromPrefix(prefix);
    const selectEl = document.getElementById(`${prefix}_sampling_bank_select`);
    const selected = (selectEl?.value || '').trim();
    if (!selected) { alert('Choose a sampling preset to delete.'); return; }
    deleteNamedBankItem('sampling_bank', mode, selected);
    refreshSamplingBankSelectors();
}

function buildPythonScriptProcessorSpec(prefix) {
    const codeEl = document.getElementById(`${prefix}_pp_script_code`);
    const depsEl = document.getElementById(`${prefix}_pp_script_deps`);
    const entrypointEl = document.getElementById(`${prefix}_pp_script_entrypoint`);
    const targetSpecEl = document.getElementById(`${prefix}_post_processor`);
    if (!codeEl || !targetSpecEl) return;
    const code = (codeEl.value || '').trim();
    if (!code) { alert('Script code is required.'); return; }
    const dependencies = (depsEl?.value || '')
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
    const entrypoint = ((entrypointEl?.value || '').trim() || 'process');
    const spec = {
        name: 'python_script',
        config: { code, entrypoint },
        runtime: { dependencies, auto_install: true },
        on_error: 'fail',
    };
    targetSpecEl.value = JSON.stringify(spec, null, 2);
}

function validateStartConfig(cfg) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error('Start panel vLLM config JSON must be an object.');
    }
    if ('use_transformers' in cfg) {
        throw new Error("Config contract changed: remove 'use_transformers' and set 'model_impl' to 'vllm' or 'transformers'.");
    }
    if (!('model_impl' in cfg)) {
        throw new Error("Start panel vLLM config JSON must include 'model_impl' ('vllm' or 'transformers').");
    }
    if (!['vllm', 'transformers'].includes(cfg.model_impl)) {
        throw new Error("'model_impl' must be either 'vllm' or 'transformers'.");
    }
    return cfg;
}
async function readFileAsJSON(inputEl) { const f = inputEl.files && inputEl.files[0]; if (!f) return null; return JSON.parse(await f.text()); }

function enableTabPlaceholderCompletion() {
    const fields = document.querySelectorAll('input[placeholder], textarea[placeholder]');
    for (const field of fields) {
        const tag = field.tagName.toLowerCase();
        const isTextInput = tag === 'input' && (!field.type || ['text', 'search', 'url', 'email', 'tel'].includes(field.type));
        const isTextarea = tag === 'textarea';
        if (!isTextInput && !isTextarea) continue;

        field.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Tab' || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return;
            if ((field.value || '').trim() !== '') return;
            const placeholder = (field.getAttribute('placeholder') || '').trim();
            if (!placeholder) return;
            ev.preventDefault();
            field.value = placeholder;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            const pos = field.value.length;
            if (typeof field.setSelectionRange === 'function') field.setSelectionRange(pos, pos);
        });
    }
}

async function ensureModelLoaded(modelName, autoStartEnabled) {
    if (!autoStartEnabled) return;
    const modelsRes = await fetch('/models');
    const modelsJson = await modelsRes.json();
    if ((modelsJson.models || []).includes(modelName)) return;

    const cfgText = document.getElementById('cfg').value;
    const cfg = validateStartConfig(parseJSONSafe(cfgText, null));

    const gtxt = document.getElementById('gpu').value.trim();
    const gpu = gtxt === "" ? null : Number(gtxt);
    const startBody = { model_name: modelName, config: cfg, gpu_id: gpu };
    const startRes = await fetch('/start', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(startBody),
    });
    const startJson = await startRes.json();
    if (!startRes.ok) throw new Error(startJson.detail || `Failed to auto-start model ${modelName}`);
    await refresh();
}

async function startModel() {
    const m = document.getElementById('mname').value.trim();
    const gtxt = document.getElementById('gpu').value.trim();
    const gpu = gtxt === "" ? null : Number(gtxt);
    const cfgTxt = document.getElementById('cfg').value;
    const msg = document.getElementById('start_msg'); msg.textContent='...';
    try {
        const body = { model_name: m, config: validateStartConfig(parseJSONSafe(cfgTxt, null)), gpu_id: gpu };
        const res = await fetch('/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const j = await res.json(); if (!res.ok) throw new Error(j.detail || JSON.stringify(j));
        msg.innerHTML = `<span class="ok">started ${j.model_name} on gpu ${j.gpu_id} (pid ${j.pid})</span>`;
        refresh();
    } catch (e) { msg.innerHTML = `<span class="err">${e.message}</span>`; }
}

async function stopWorker(e) {
    e.preventDefault();
    const m = document.getElementById('s_model').value.trim();
    const g = document.getElementById('s_gpu').value.trim();
    if (!m || g === "") return;
    const form = new FormData(); form.append('model_name', m); form.append('gpu_id', Number(g));
    try { const res = await fetch('/stop', { method:'POST', body: form }); const j = await res.json();
        if (!res.ok) throw new Error(j.detail || JSON.stringify(j)); document.getElementById('start_msg').innerHTML = `<span class="ok">${j.status}</span>`; refresh();
    } catch (e2) { document.getElementById('start_msg').innerHTML = `<span class="err">${e2.message}</span>`; }
}

async function submitSimple() {
    const m = (document.getElementById('g_model_manual').value.trim() || document.getElementById('g_model').value.trim());
    const useOffline = document.getElementById('g_offline').checked;
    const cleanupModelAfterJob = document.getElementById('g_cleanup_model').checked;
    const autoStart = document.getElementById('g_autostart').checked;
    const includeMetadata = document.getElementById('g_include_metadata').checked;
    const postProcessor = parseJSONSafe(document.getElementById('g_post_processor').value, null);
    const ppPayload = Array.isArray(postProcessor)
        ? { post_processors: postProcessor }
        : { post_processor: postProcessor };
    const sampling = parseJSONSafe(document.getElementById('g_sampling').value, samplingDefault);
    const fileEl = document.getElementById('g_file');
    let prompts = parseJSONSafe(document.getElementById('g_prompt').value, []);
    const fromFile = await readFileAsJSON(fileEl); if (fromFile) prompts = fromFile;
    if (!m) { document.getElementById('g_msg').innerHTML = '<span class="err">Model is required.</span>'; return; }
    if (!Array.isArray(prompts)) { document.getElementById('g_msg').innerHTML = '<span class="err">Prompts must be an array of {prompt, metadata?} items.</span>'; return; }
    if (!prompts.every((p) => p && typeof p === 'object' && typeof p.prompt === 'string')) {
        document.getElementById('g_msg').innerHTML = '<span class="err">Each item must include a string prompt field.</span>';
        return;
    }
    try {
        if (useOffline) await ensureModelLoaded(m, autoStart);
        const endpoint = useOffline ? '/generate/offline' : '/generate/simple';
        const headers = {'Content-Type':'application/json'};
        if (useOffline) headers['X-UI-Request'] = '1';
        const payload = useOffline
            ? { model_name: m, type: 'generate', prompts, sampling, include_metadata: includeMetadata, cleanup_model_after_job: cleanupModelAfterJob, ...ppPayload }
            : { model_name: m, prompts, sampling, include_metadata: includeMetadata, ...ppPayload };
        const res = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify(payload) });
        const j = await res.json(); if (!res.ok) { document.getElementById('g_msg').innerHTML = `<span class="err">${j.detail || 'error'}</span>`; return; }
        document.getElementById('g_msg').innerHTML = `<span class="ok">${j.status || 'queued'} (job ${j.job_id})</span>`;
        pollJob(j.job_id, 'g_msg');
    } catch (e) {
        document.getElementById('g_msg').innerHTML = `<span class="err">${e.message}</span>`;
    }
}

async function submitChat() {
    const m = (document.getElementById('c_model_manual').value.trim() || document.getElementById('c_model').value.trim());
    const useOffline = document.getElementById('c_offline').checked;
    const cleanupModelAfterJob = document.getElementById('c_cleanup_model').checked;
    const autoStart = document.getElementById('c_autostart').checked;
    const sampling = parseJSONSafe(document.getElementById('c_sampling').value, samplingDefault);
    const outField = document.getElementById('c_outfield').value || "output";
    const includeMetadata = document.getElementById('c_include_metadata').checked;
    const postProcessor = parseJSONSafe(document.getElementById('c_post_processor').value, null);
    const ppPayload = Array.isArray(postProcessor)
        ? { post_processors: postProcessor }
        : { post_processor: postProcessor };
    const fileEl = document.getElementById('c_file');
    let prompts = parseJSONSafe(document.getElementById('c_msgs').value, []);
    const fromFile = await readFileAsJSON(fileEl); if (fromFile) prompts = fromFile;
    if (!m) { document.getElementById('c_msg').innerHTML = '<span class="err">Model is required.</span>'; return; }
    if (!Array.isArray(prompts)) { document.getElementById('c_msg').innerHTML = '<span class="err">Chat must be an array of items.</span>'; return; }
    try {
        if (useOffline) await ensureModelLoaded(m, autoStart);
        const endpoint = useOffline ? '/generate/offline' : '/generate/chat';
        const headers = {'Content-Type':'application/json'};
        if (useOffline) headers['X-UI-Request'] = '1';
        const payload = useOffline
            ? { model_name: m, type: 'chat', prompts, sampling, output_field: outField, include_metadata: includeMetadata, cleanup_model_after_job: cleanupModelAfterJob, ...ppPayload }
            : { model_name: m, prompts, sampling, output_field: outField, include_metadata: includeMetadata, ...ppPayload };
        const res = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify(payload) });
        const j = await res.json(); if (!res.ok) { document.getElementById('c_msg').innerHTML = `<span class="err">${j.detail || 'error'}</span>`; return; }
        document.getElementById('c_msg').innerHTML = `<span class="ok">${j.status || 'queued'} (job ${j.job_id})</span>`;
        pollJob(j.job_id, 'c_msg');
    } catch (e) {
        document.getElementById('c_msg').innerHTML = `<span class="err">${e.message}</span>`;
    }
}

async function bootstrapUI() {
    enableTabPlaceholderCompletion();
    await loadUiState();
    refreshProcessorPresetSelectors();
    refreshPromptBankSelectors();
    refreshSamplingBankSelectors();
    refresh();
}

bootstrapUI();
