let lastResult = null;
let evtSource = null;

const samplingDefault = { temperature: 0.0, top_p: 1.0, max_tokens: 256 };
const UI_STATE_DEFAULT = {
    processor_presets: [],
    prompt_bank: { simple: [], chat: [] },
    sampling_bank: { simple: [], chat: [] },
};
let uiState = JSON.parse(JSON.stringify(UI_STATE_DEFAULT));
const activityLog = [];
const validationState = {
    g_sampling: false,
    c_sampling: false,
    g_prompt: false,
    c_msgs: false,
    g_post_processor: true,
    c_post_processor: true,
    g_file_prompt: true,
    c_file_prompt: true,
};

function nowTimeLabel() {
    return new Date().toISOString().slice(11, 19);
}

function addActivity(kind, message) {
    activityLog.unshift({ ts: nowTimeLabel(), kind: kind || 'info', message });
    if (activityLog.length > 30) activityLog.pop();
    const feed = document.getElementById('activityFeed');
    if (!feed) return;
    feed.innerHTML = '';
    for (const item of activityLog) {
        const li = document.createElement('li');
        const ts = document.createElement('span');
        ts.className = 'activity-time';
        ts.textContent = `[${item.ts}]`;
        const msg = document.createElement('span');
        msg.className = item.kind;
        msg.textContent = item.message;
        li.appendChild(ts);
        li.appendChild(msg);
        feed.appendChild(li);
    }
}

function notify(kind, message, timeoutMs = 3200) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${kind || 'info'}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, timeoutMs);
    addActivity(kind, message);
}

function setInlineMessage(elId, kind, message) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!message) { el.textContent = ''; return; }
    el.innerHTML = `<span class="${kind}">${message}</span>`;
}

function setFieldStatus(elId, kind, message) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.className = `field-status ${kind || 'muted'}`;
    el.textContent = message;
}

function setValidationFlag(key, valid) {
    validationState[key] = !!valid;
    updateGenerateButtonsState();
}

function setButtonLoading(buttonId, isLoading, loadingText = 'Working...') {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    if (!btn.dataset.defaultText) btn.dataset.defaultText = btn.textContent;
    btn.disabled = !!isLoading;
    btn.textContent = isLoading ? loadingText : btn.dataset.defaultText;
    if (!isLoading) updateGenerateButtonsState();
}

function switchTab(which) {
    const sBtn = document.getElementById('tabSimple');
    const cBtn = document.getElementById('tabChat');
    const sPanel = document.getElementById('panelSimple');
    const cPanel = document.getElementById('panelChat');
    if (which === 'simple') {
        sBtn.classList.add('tab-active');
        cBtn.classList.remove('tab-active');
        sPanel.hidden = false;
        cPanel.hidden = true;
    }
    else {
        cBtn.classList.add('tab-active');
        sBtn.classList.remove('tab-active');
        cPanel.hidden = false;
        sPanel.hidden = true;
    }
}

function setSummaryCards(elId, items) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = '';
    const safeItems = Array.isArray(items) ? items.filter((it) => it && it.k) : [];
    if (!safeItems.length) return;
    for (const item of safeItems) {
        const card = document.createElement('div');
        card.className = 'summary-card';
        const k = document.createElement('span');
        k.className = 'summary-k';
        k.textContent = item.k;
        const v = document.createElement('span');
        v.className = 'summary-v';
        v.textContent = item.v ?? '—';
        card.appendChild(k);
        card.appendChild(v);
        el.appendChild(card);
    }
}

function renderStatusSummary(statusObj) {
    if (!statusObj || typeof statusObj !== 'object') { setSummaryCards('statusSummary', []); return; }
    const workers = Array.isArray(statusObj.workers) ? statusObj.workers.length : 0;
    const models = Array.isArray(statusObj.models) ? statusObj.models.length : 0;
    const jobs = Array.isArray(statusObj.jobs) ? statusObj.jobs.length : 0;
    const hasError = !!statusObj.error;
    setSummaryCards('statusSummary', [
        { k: 'Workers', v: String(workers) },
        { k: 'Models', v: String(models) },
        { k: 'Jobs', v: String(jobs) },
        { k: 'Health', v: hasError ? 'Degraded' : 'OK' },
    ]);
}

function renderResultSummary(resultObj) {
    if (!resultObj || typeof resultObj !== 'object') { setSummaryCards('resultSummary', []); return; }
    const resultRows = Array.isArray(resultObj.result) ? resultObj.result.length : (Array.isArray(resultObj.rows) ? resultObj.rows.length : 0);
    setSummaryCards('resultSummary', [
        { k: 'Job ID', v: resultObj.job_id || '—' },
        { k: 'Status', v: resultObj.status || (resultObj.error ? 'error' : 'done') },
        { k: 'Rows', v: String(resultRows) },
        { k: 'Error', v: resultObj.error ? 'Yes' : 'No' },
    ]);
}

function showResult(obj){
    lastResult = obj;
    renderResultSummary(obj);
    document.getElementById('resultBox').textContent = JSON.stringify(obj,null,2);
}
function clearResults(){
    lastResult=null;
    setSummaryCards('resultSummary', []);
    document.getElementById('resultBox').textContent='';
}
function saveJSON(){
    if (!lastResult) { notify('info', 'No result available yet. Run a generation first.'); return; }
    const blob = new Blob([JSON.stringify(lastResult, null, 2)], {type: "application/json"});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    const id = ('job_id' in lastResult) ? lastResult.job_id : 'result'; a.download = `${id}.json`;
    document.body.appendChild(a); a.click(); a.remove();
}
async function copyResultToClipboard() {
    if (!lastResult) { notify('info', 'No result available to copy yet.'); return; }
    try {
        await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
        notify('ok', 'Copied result JSON to clipboard.');
    } catch (e) {
        notify('err', `Copy failed: ${e.message}`);
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
                addActivity(j.status === 'done' ? 'ok' : 'err', `Job ${jobId} ${j.status}.`);
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
    try {
        const res = await fetch('/status');
        const statusObj = await res.json();
        renderStatusSummary(statusObj);
        el.textContent = JSON.stringify(statusObj, null, 2);
    } catch(e){
        renderStatusSummary({ error: e.message });
        el.textContent=e.message;
    }
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
    if (!name) { notify('err', 'Preset name is required.'); return; }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { notify('err', 'Post-processor spec must be a valid JSON object.'); return; }
    if (!spec.name || typeof spec.name !== 'string') { notify('err', "Post-processor spec must include string field 'name'."); return; }

    const presets = getProcessorPresets().filter((p) => p.name !== name);
    presets.push({ name, spec });
    presets.sort((a, b) => a.name.localeCompare(b.name));
    setProcessorPresets(presets);
    refreshProcessorPresetSelectors();
    notify('ok', `Saved preset '${name}'.`);
}

function applyProcessorPreset(prefix) {
    const selectEl = document.getElementById(`${prefix}_pp_preset_select`);
    const specEl = document.getElementById(`${prefix}_post_processor`);
    const selected = (selectEl.value || '').trim();
    if (!selected) return;
    const preset = getProcessorPresets().find((p) => p.name === selected);
    if (!preset) { notify('err', `Preset '${selected}' not found.`); return; }
    specEl.value = JSON.stringify(preset.spec, null, 2);
}

function deleteProcessorPreset(prefix) {
    const selectEl = document.getElementById(`${prefix}_pp_preset_select`);
    const selected = (selectEl.value || '').trim();
    if (!selected) { notify('err', 'Choose a preset to delete.'); return; }
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
    if (!name) { notify('err', 'Prompt preset name is required.'); return; }
    if (!value.trim()) { notify('err', 'Prompt JSON is empty.'); return; }
    upsertNamedBankItem('prompt_bank', mode, name, value);
    refreshPromptBankSelectors();
}

function loadPromptBankItem(prefix) {
    const mode = modeNameFromPrefix(prefix);
    const selectEl = document.getElementById(`${prefix}_prompt_bank_select`);
    const selected = (selectEl?.value || '').trim();
    if (!selected) return;
    const item = getNamedBankItem('prompt_bank', mode, selected);
    if (!item) { notify('err', `Prompt preset '${selected}' not found.`); return; }
    const textareaId = prefix === 'c' ? 'c_msgs' : 'g_prompt';
    const contentEl = document.getElementById(textareaId);
    contentEl.value = item.value || '';
}

function deletePromptBankItem(prefix) {
    const mode = modeNameFromPrefix(prefix);
    const selectEl = document.getElementById(`${prefix}_prompt_bank_select`);
    const selected = (selectEl?.value || '').trim();
    if (!selected) { notify('err', 'Choose a prompt preset to delete.'); return; }
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
    if (!name) { notify('err', 'Sampling preset name is required.'); return; }
    if (!value.trim()) { notify('err', 'Sampling JSON is empty.'); return; }
    upsertNamedBankItem('sampling_bank', mode, name, value);
    refreshSamplingBankSelectors();
}

function loadSamplingBankItem(prefix) {
    const mode = modeNameFromPrefix(prefix);
    const selectEl = document.getElementById(`${prefix}_sampling_bank_select`);
    const selected = (selectEl?.value || '').trim();
    if (!selected) return;
    const item = getNamedBankItem('sampling_bank', mode, selected);
    if (!item) { notify('err', `Sampling preset '${selected}' not found.`); return; }
    const textareaId = prefix === 'c' ? 'c_sampling' : 'g_sampling';
    const contentEl = document.getElementById(textareaId);
    contentEl.value = item.value || '';
}

function deleteSamplingBankItem(prefix) {
    const mode = modeNameFromPrefix(prefix);
    const selectEl = document.getElementById(`${prefix}_sampling_bank_select`);
    const selected = (selectEl?.value || '').trim();
    if (!selected) { notify('err', 'Choose a sampling preset to delete.'); return; }
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
    if (!code) { notify('err', 'Script code is required.'); return; }
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
    setInlineMessage('start_msg', 'info', 'Starting model...');
    try {
        const body = { model_name: m, config: validateStartConfig(parseJSONSafe(cfgTxt, null)), gpu_id: gpu };
        const res = await fetch('/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const j = await res.json(); if (!res.ok) throw new Error(j.detail || JSON.stringify(j));
        setInlineMessage('start_msg', 'ok', `started ${j.model_name} on gpu ${j.gpu_id} (pid ${j.pid})`);
        notify('ok', `Model ${j.model_name} started on GPU ${j.gpu_id}.`);
        refresh();
    } catch (e) {
        setInlineMessage('start_msg', 'err', e.message);
        notify('err', `Start failed: ${e.message}`);
    }
}

async function stopWorker(e) {
    e.preventDefault();
    const m = document.getElementById('s_model').value.trim();
    const g = document.getElementById('s_gpu').value.trim();
    if (!m || g === "") return;
    const form = new FormData(); form.append('model_name', m); form.append('gpu_id', Number(g));
    try { const res = await fetch('/stop', { method:'POST', body: form }); const j = await res.json();
        if (!res.ok) throw new Error(j.detail || JSON.stringify(j));
        setInlineMessage('start_msg', 'ok', j.status);
        notify('ok', j.status || 'Worker stopped.');
        refresh();
    } catch (e2) {
        setInlineMessage('start_msg', 'err', e2.message);
        notify('err', `Stop failed: ${e2.message}`);
    }
}

function updateGenerateButtonsState() {
    const simpleBtn = document.getElementById('btnSimpleGenerate');
    const chatBtn = document.getElementById('btnChatGenerate');
    if (simpleBtn) simpleBtn.disabled = !(validationState.g_sampling && validationState.g_prompt && validationState.g_post_processor && validationState.g_file_prompt);
    if (chatBtn) chatBtn.disabled = !(validationState.c_sampling && validationState.c_msgs && validationState.c_post_processor && validationState.c_file_prompt);
}

function formatJsonParseError(rawMessage, rawValue) {
    const msg = String(rawMessage || 'Invalid JSON');
    const match = msg.match(/position\s+(\d+)/i);
    if (!match) return msg;
    const pos = Number(match[1]);
    if (!Number.isFinite(pos) || pos < 0) return msg;
    const text = rawValue || '';
    const line = text.slice(0, pos).split('\n').length;
    const col = pos - text.lastIndexOf('\n', pos - 1);
    return `${msg} (line ${line}, column ${col})`;
}

function validateJsonField({ inputId, statusId, optional = false, expectArray = false, key, itemValidator = null, itemError = 'Invalid item shape.' }) {
    const rawValue = document.getElementById(inputId)?.value || '';
    const value = rawValue.trim();
    if (!value) {
        if (optional) {
            setFieldStatus(statusId, 'muted', 'Optional.');
            setValidationFlag(key, true);
            return true;
        }
        setFieldStatus(statusId, 'warn', 'Required field is empty.');
        setValidationFlag(key, false);
        return false;
    }

    try {
        const parsed = JSON.parse(value);
        if (expectArray && !Array.isArray(parsed)) {
            setFieldStatus(statusId, 'err', 'Must be a JSON array.');
            setValidationFlag(key, false);
            return false;
        }
        if (expectArray && itemValidator && !parsed.every(itemValidator)) {
            setFieldStatus(statusId, 'err', itemError);
            setValidationFlag(key, false);
            return false;
        }
        if (!expectArray && typeof parsed !== 'object') {
            setFieldStatus(statusId, 'err', 'Must be a JSON object.');
            setValidationFlag(key, false);
            return false;
        }
        setFieldStatus(statusId, 'ok', 'Valid JSON.');
        setValidationFlag(key, true);
        return true;
    } catch (err) {
        const msg = formatJsonParseError(err?.message, rawValue);
        setFieldStatus(statusId, 'err', `Invalid JSON: ${msg}`);
        setValidationFlag(key, false);
        return false;
    }
}

async function validateUploadInput({ inputId, statusId, key, expectArray = true, itemValidator = null, itemError = 'Invalid item shape.' }) {
    const inputEl = document.getElementById(inputId);
    const file = inputEl?.files?.[0];
    if (!file) {
        setValidationFlag(key, true);
        return true;
    }
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (expectArray && !Array.isArray(parsed)) throw new Error('Uploaded file must contain a JSON array.');
        if (expectArray && itemValidator && !parsed.every(itemValidator)) throw new Error(itemError);
        setFieldStatus(statusId, 'ok', `Using uploaded file: ${file.name}`);
        setValidationFlag(key, true);
        return true;
    } catch (e) {
        setFieldStatus(statusId, 'err', `Uploaded file invalid: ${formatJsonParseError(e?.message, '')}`);
        setValidationFlag(key, false);
        return false;
    }
}

async function runFormValidations() {
    validateJsonField({ inputId: 'g_sampling', statusId: 'g_sampling_status', key: 'g_sampling' });
    validateJsonField({
        inputId: 'g_prompt',
        statusId: 'g_prompt_status',
        key: 'g_prompt',
        expectArray: true,
        itemValidator: (p) => p && typeof p === 'object' && typeof p.prompt === 'string',
        itemError: "Each item must include a string 'prompt'.",
    });
    validateJsonField({ inputId: 'g_post_processor', statusId: 'g_post_processor_status', key: 'g_post_processor', optional: true });

    validateJsonField({ inputId: 'c_sampling', statusId: 'c_sampling_status', key: 'c_sampling' });
    validateJsonField({
        inputId: 'c_msgs',
        statusId: 'c_msgs_status',
        key: 'c_msgs',
        expectArray: true,
        itemValidator: (p) => p && typeof p === 'object' && Array.isArray(p.messages),
        itemError: "Each item must include a 'messages' array.",
    });
    validateJsonField({ inputId: 'c_post_processor', statusId: 'c_post_processor_status', key: 'c_post_processor', optional: true });
    await validateUploadInput({
        inputId: 'g_file',
        statusId: 'g_prompt_status',
        key: 'g_file_prompt',
        expectArray: true,
        itemValidator: (p) => p && typeof p === 'object' && typeof p.prompt === 'string',
        itemError: "Uploaded items must include a string 'prompt'.",
    });
    await validateUploadInput({
        inputId: 'c_file',
        statusId: 'c_msgs_status',
        key: 'c_file_prompt',
        expectArray: true,
        itemValidator: (p) => p && typeof p === 'object' && Array.isArray(p.messages),
        itemError: "Uploaded items must include a 'messages' array.",
    });
}

async function submitSimple() {
    await runFormValidations();
    if (!validationState.g_sampling || !validationState.g_prompt || !validationState.g_post_processor || !validationState.g_file_prompt) {
        setInlineMessage('g_msg', 'err', 'Please fix invalid JSON fields before submitting.');
        return;
    }
    setButtonLoading('btnSimpleGenerate', true, 'Generating...');
    const m = (document.getElementById('g_model_manual').value.trim() || document.getElementById('g_model').value.trim());
    const useOffline = document.getElementById('g_offline').checked;
    const cleanupModelAfterJob = document.getElementById('g_cleanup_model').checked;
    const autoStart = document.getElementById('g_autostart').checked;
    const includeMetadata = document.getElementById('g_include_metadata').checked;
    const postProcessor = parseJSONSafe(document.getElementById('g_post_processor').value, null);
    const sampling = parseJSONSafe(document.getElementById('g_sampling').value, samplingDefault);
    const fileEl = document.getElementById('g_file');
    let prompts = parseJSONSafe(document.getElementById('g_prompt').value, []);
    const fromFile = await readFileAsJSON(fileEl); if (fromFile) prompts = fromFile;
    if (!m) { setInlineMessage('g_msg', 'err', 'Model is required.'); setButtonLoading('btnSimpleGenerate', false); return; }
    if (!Array.isArray(prompts)) { setInlineMessage('g_msg', 'err', 'Prompts must be an array of {prompt, metadata?} items.'); setButtonLoading('btnSimpleGenerate', false); return; }
    if (!prompts.every((p) => p && typeof p === 'object' && typeof p.prompt === 'string')) {
        setInlineMessage('g_msg', 'err', 'Each item must include a string prompt field.');
        setButtonLoading('btnSimpleGenerate', false);
        return;
    }
    try {
        if (useOffline) await ensureModelLoaded(m, autoStart);
        const endpoint = useOffline ? '/generate/offline' : '/generate/simple';
        const headers = {'Content-Type':'application/json'};
        if (useOffline) headers['X-UI-Request'] = '1';
        const payload = useOffline
            ? { model_name: m, type: 'generate', prompts, sampling, include_metadata: includeMetadata, cleanup_model_after_job: cleanupModelAfterJob, post_processor: postProcessor }
            : { model_name: m, prompts, sampling, include_metadata: includeMetadata, post_processor: postProcessor };
        const res = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify(payload) });
        const j = await res.json();
        if (!res.ok) { setInlineMessage('g_msg', 'err', j.detail || 'error'); notify('err', j.detail || 'Generation request failed.'); return; }
        setInlineMessage('g_msg', 'ok', `${j.status || 'queued'} (job ${j.job_id})`);
        notify('ok', `Simple job queued: ${j.job_id}`);
        pollJob(j.job_id, 'g_msg');
    } catch (e) {
        setInlineMessage('g_msg', 'err', e.message);
        notify('err', `Simple submit failed: ${e.message}`);
    } finally {
        setButtonLoading('btnSimpleGenerate', false);
    }
}

async function submitChat() {
    await runFormValidations();
    if (!validationState.c_sampling || !validationState.c_msgs || !validationState.c_post_processor || !validationState.c_file_prompt) {
        setInlineMessage('c_msg', 'err', 'Please fix invalid JSON fields before submitting.');
        return;
    }
    setButtonLoading('btnChatGenerate', true, 'Generating...');
    const m = (document.getElementById('c_model_manual').value.trim() || document.getElementById('c_model').value.trim());
    const useOffline = document.getElementById('c_offline').checked;
    const cleanupModelAfterJob = document.getElementById('c_cleanup_model').checked;
    const autoStart = document.getElementById('c_autostart').checked;
    const sampling = parseJSONSafe(document.getElementById('c_sampling').value, samplingDefault);
    const outField = document.getElementById('c_outfield').value || "output";
    const includeMetadata = document.getElementById('c_include_metadata').checked;
    const postProcessor = parseJSONSafe(document.getElementById('c_post_processor').value, null);
    const fileEl = document.getElementById('c_file');
    let prompts = parseJSONSafe(document.getElementById('c_msgs').value, []);
    const fromFile = await readFileAsJSON(fileEl); if (fromFile) prompts = fromFile;
    if (!m) { setInlineMessage('c_msg', 'err', 'Model is required.'); setButtonLoading('btnChatGenerate', false); return; }
    if (!Array.isArray(prompts)) { setInlineMessage('c_msg', 'err', 'Chat must be an array of items.'); setButtonLoading('btnChatGenerate', false); return; }
    try {
        if (useOffline) await ensureModelLoaded(m, autoStart);
        const endpoint = useOffline ? '/generate/offline' : '/generate/chat';
        const headers = {'Content-Type':'application/json'};
        if (useOffline) headers['X-UI-Request'] = '1';
        const payload = useOffline
            ? { model_name: m, type: 'chat', prompts, sampling, output_field: outField, include_metadata: includeMetadata, cleanup_model_after_job: cleanupModelAfterJob, post_processor: postProcessor }
            : { model_name: m, prompts, sampling, output_field: outField, include_metadata: includeMetadata, post_processor: postProcessor };
        const res = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify(payload) });
        const j = await res.json();
        if (!res.ok) { setInlineMessage('c_msg', 'err', j.detail || 'error'); notify('err', j.detail || 'Chat request failed.'); return; }
        setInlineMessage('c_msg', 'ok', `${j.status || 'queued'} (job ${j.job_id})`);
        notify('ok', `Chat job queued: ${j.job_id}`);
        pollJob(j.job_id, 'c_msg');
    } catch (e) {
        setInlineMessage('c_msg', 'err', e.message);
        notify('err', `Chat submit failed: ${e.message}`);
    } finally {
        setButtonLoading('btnChatGenerate', false);
    }
}

async function bootstrapUI() {
    enableTabPlaceholderCompletion();
    await loadUiState();
    refreshProcessorPresetSelectors();
    refreshPromptBankSelectors();
    refreshSamplingBankSelectors();
    for (const id of ['g_sampling', 'g_prompt', 'g_post_processor', 'c_sampling', 'c_msgs', 'c_post_processor']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.addEventListener('input', () => { runFormValidations(); });
        el.addEventListener('blur', () => { runFormValidations(); });
    }
    for (const id of ['g_file', 'c_file']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.addEventListener('change', () => { runFormValidations(); });
    }
    await runFormValidations();
    addActivity('info', 'UI initialized.');
    refresh();
}

bootstrapUI();
