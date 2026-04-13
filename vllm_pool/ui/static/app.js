import { apiClient } from './app/services/apiClient.js';
import { openTailSse, closeSse } from './app/services/sseClient.js';
import { pollJobUntilTerminal } from './app/services/jobPollingService.js';
import { ensureModelLoaded as ensureModelLoadedViaController, startModelWorker, stopModelWorker } from './app/controllers/modelController.js';
import { queueGeneration, getJobStatus } from './app/controllers/generationController.js';
import {
    UI_STATE_DEFAULT,
    loadUiStateFromApi,
    persistUiStateSection as persistUiStateSectionViaController,
    getModeBank,
    setModeBank,
    upsertNamedItem,
    getNamedItem,
    deleteNamedItem,
} from './app/controllers/uiStateController.js';
import {
    validateJsonField as validateJsonFieldCore,
    validateUploadInput as validateUploadInputCore,
} from './app/validators/formValidators.js';
import { renderStatusSummary } from './app/components/status/statusSection.js';
import { renderResultSummary } from './app/components/result/resultSummary.js';
import { setSummaryCards } from './app/components/shared/summaryCards.js';
import { renderModelOptions, renderWorkerOptions, renderStopTargets } from './app/components/model/modelSection.js';
import {
    renderScriptConfigEntries as renderScriptConfigEntriesController,
    addScriptConfigEntry as addScriptConfigEntryController,
    initScriptBuilderDnD as initScriptBuilderDnDController,
    buildPythonScriptProcessorSpec as buildPythonScriptProcessorSpecController,
} from './app/controllers/scriptBuilderController.js';
import { toStartModelRequest, toSimpleGenerationRequest, toChatGenerationRequest } from './app/adapters/requests.js';
import { toResultFromJob } from './app/adapters/responses.js';
import { storageService } from './app/services/storageService.js';
import { logger } from './app/services/loggerService.js';
import { appStore, pushActivity, pushToast } from './app/stores/appStore.js';
import { setLastResult, clearLastResult } from './app/stores/jobStore.js';
import { setModels, setWorkers } from './app/stores/modelStore.js';
import { setGenerateValidity } from './app/stores/generateStore.js';
import { setUiState as setUiStateStoreSnapshot } from './app/stores/uiStateStore.js';
import { renderActivityFeed } from './app/components/feedback/activityFeed.js';
import { renderResultJson } from './app/components/result/resultInspector.js';

let lastResult = null;
let evtSource = null;
let liveTailBuffer = [];

const samplingDefault = { temperature: 0.0, top_p: 1.0, max_tokens: 256 };
let uiState = JSON.parse(JSON.stringify(UI_STATE_DEFAULT));
const validationState = {
    g_sampling: false,
    c_sampling: false,
    g_prompt: false,
    c_msgs: false,
    g_pre_processor: true,
    g_post_processor: true,
    c_pre_processor: true,
    c_post_processor: true,
    g_file_prompt: true,
    c_file_prompt: true,
};
const scriptBuilderState = {
    g: { configEntries: [], target: 'post' },
    c: { configEntries: [], target: 'post' },
};

function nowTimeLabel() {
    return new Date().toISOString().slice(11, 19);
}

function addActivity(kind, message) {
    pushActivity({ ts: nowTimeLabel(), kind: kind || 'info', message });
    renderActivityFeed(appStore.getState().activityLog);
}

function notify(kind, message, timeoutMs = 3200) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${kind || 'info'}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, timeoutMs);
    pushToast({ ts: Date.now(), kind: kind || 'info', message });
    addActivity(kind, message);
    if (kind === 'err') logger.error(message);
    else logger.info(message);
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

function showResult(obj){
    lastResult = obj;
    setLastResult(obj);
    renderResultSummary(obj);
    renderResultJson(obj);
}
function clearResults(){
    lastResult=null;
    clearLastResult();
    setSummaryCards('resultSummary', []);
    renderResultJson(null);
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
    pollJobUntilTerminal({
        getJob: getJobStatus,
        jobId,
        intervalMs: 1500,
        onProgress: () => {
            el.innerHTML = `<span class="muted">in-queue/running (job ${jobId})</span>`;
        },
        onTerminal: (job) => {
            el.innerHTML = `<span class="${job.status === 'done' ? 'ok' : 'err'}">${job.status}</span>`;
            showResult(toResultFromJob(jobId, job));
            addActivity(job.status === 'done' ? 'ok' : 'err', `Job ${jobId} ${job.status}.`);
        },
        onError: (e) => {
            el.innerHTML = `<span class="err">poll error: ${e.message}</span>`;
        },
    });
}

async function refreshModels() {
    const j = await apiClient.getModels();
    const models = j.models || [];
    setModels(models);
    renderModelOptions(['g_model', 'c_model'], models);
}

async function refreshWorkers() {
    const j = await apiClient.getWorkers();
    const arr = j.workers || [];
    setWorkers(arr);
    renderStopTargets(arr);
    renderWorkerOptions(arr);
    if (!arr.length) { closeSSE(); liveTailBuffer = []; document.getElementById('progressBox').textContent=''; return; }
    switchWorker();
}

async function refresh() {
    const el = document.getElementById('status'); el.textContent='...';
    try {
        const statusObj = await apiClient.getStatus();
        renderStatusSummary(statusObj);
        el.textContent = JSON.stringify(statusObj, null, 2);
    } catch(e){
        logger.error('Status refresh failed', { error: e.message });
        renderStatusSummary({ error: e.message });
        el.textContent=e.message;
    }
    refreshModels(); refreshWorkers();
}

function closeSSE(){ if (evtSource){ closeSse(evtSource); evtSource=null; } }
function switchWorker(){
    const key = document.getElementById('workerSel').value;
    if (!key) { closeSSE(); liveTailBuffer = []; document.getElementById('progressBox').textContent=''; return; }
    liveTailBuffer = [];
    openSSE(`/events/worker/${encodeURIComponent(key)}`);
}
function openSSE(url) {
    closeSSE();
    evtSource = openTailSse(url, {
        onTail: (obj) => {
            const incoming = Array.isArray(obj.lines) ? obj.lines.map((s) => String(s || '').trim()).filter(Boolean) : [];
            if (incoming.length) {
                for (const line of incoming) {
                    if (!liveTailBuffer.length || liveTailBuffer[liveTailBuffer.length - 1] !== line) {
                        liveTailBuffer.push(line);
                    }
                }
                liveTailBuffer = liveTailBuffer.slice(-5);
            }
            document.getElementById('progressBox').textContent = liveTailBuffer.join('\n');
        },
    });
}

function parseJSONSafe(text, fallback) { if (!text || !text.trim()) return fallback; try { return JSON.parse(text); } catch { return fallback; } }

function samplingFormIds(prefix) {
    return {
        temp: `${prefix}_temp`,
        topP: `${prefix}_top_p`,
        maxTokens: `${prefix}_max_tokens`,
        samplingJson: `${prefix}_sampling`,
    };
}

function applySamplingForm(prefix, notifyUser = true) {
    const ids = samplingFormIds(prefix);
    const temp = Number(document.getElementById(ids.temp)?.value);
    const topP = Number(document.getElementById(ids.topP)?.value);
    const maxTokens = Number(document.getElementById(ids.maxTokens)?.value);
    if (!Number.isFinite(temp) || temp < 0) { notify('err', 'Temperature must be a non-negative number.'); return; }
    if (!Number.isFinite(topP) || topP < 0 || topP > 1) { notify('err', 'Top-p must be between 0 and 1.'); return; }
    if (!Number.isInteger(maxTokens) || maxTokens < 1) { notify('err', 'Max tokens must be an integer >= 1.'); return; }
    const samplingEl = document.getElementById(ids.samplingJson);
    const current = parseJSONSafe(samplingEl?.value, {});
    const next = {
        ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
        temperature: temp,
        top_p: topP,
        max_tokens: maxTokens,
    };
    samplingEl.value = JSON.stringify(next, null, 2);
    runFormValidations();
    if (notifyUser) notify('ok', 'Sampling JSON updated from form fields.');
}

function syncSamplingFormFromJson(prefix, notifyUser = true) {
    const ids = samplingFormIds(prefix);
    const sampling = parseJSONSafe(document.getElementById(ids.samplingJson)?.value, null);
    if (!sampling || typeof sampling !== 'object' || Array.isArray(sampling)) {
        if (notifyUser) notify('err', 'Sampling JSON must be a JSON object.');
        return;
    }
    const setIfFinite = (id, value) => {
        const num = Number(value);
        if (Number.isFinite(num)) document.getElementById(id).value = String(num);
    };
    setIfFinite(ids.temp, sampling.temperature);
    setIfFinite(ids.topP, sampling.top_p);
    setIfFinite(ids.maxTokens, sampling.max_tokens);
    if (notifyUser) notify('ok', 'Sampling form fields loaded from JSON.');
}

async function loadUiState() {
    try {
        uiState = await loadUiStateFromApi();
        setUiStateStoreSnapshot(uiState);
        storageService.setJSON('vllm_ui_state_cache', uiState);
    } catch (_) {
        uiState = storageService.getJSON('vllm_ui_state_cache', JSON.parse(JSON.stringify(UI_STATE_DEFAULT)));
        setUiStateStoreSnapshot(uiState);
    }
}

async function persistUiStateSection(section, value) {
    uiState[section] = value;
    setUiStateStoreSnapshot(uiState);
    storageService.setJSON('vllm_ui_state_cache', uiState);
    try {
        await persistUiStateSectionViaController(section, value);
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
    uiState[key] = value;
    persistUiStateSection(key, value);
}

function upsertNamedBankItem(key, mode, name, value) {
    const bank = getBankMap(key);
    const items = getModeBank(bank, mode);
    const nextItems = upsertNamedItem(items, name, value);
    const nextBank = setModeBank(bank, mode, nextItems);
    setBankMap(key, nextBank);
}

function getNamedBankItem(key, mode, name) {
    const bank = getBankMap(key);
    const items = getModeBank(bank, mode);
    return getNamedItem(items, name);
}

function deleteNamedBankItem(key, mode, name) {
    const bank = getBankMap(key);
    const items = getModeBank(bank, mode);
    const nextItems = deleteNamedItem(items, name);
    const nextBank = setModeBank(bank, mode, nextItems);
    setBankMap(key, nextBank);
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

function renderScriptConfigEntries(prefix) {
    renderScriptConfigEntriesController(prefix, scriptBuilderState);
}

function addScriptConfigEntry(prefix) {
    addScriptConfigEntryController(prefix, scriptBuilderState, notify);
}

function initScriptBuilderDnD(prefix) {
    initScriptBuilderDnDController(prefix, scriptBuilderState, notify);
}

function buildPythonScriptProcessorSpec(prefix, targetOverride = null) {
    buildPythonScriptProcessorSpecController(prefix, scriptBuilderState, notify, targetOverride);
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
    const cfgText = document.getElementById('cfg').value;
    const cfg = validateStartConfig(parseJSONSafe(cfgText, null));
    const gtxt = document.getElementById('gpu').value.trim();
    const gpu = gtxt === "" ? null : Number(gtxt);
    const started = await ensureModelLoadedViaController({
        modelName,
        autoStartEnabled,
        config: cfg,
        gpuId: gpu,
    });
    if (started) await refresh();
}

async function startModel() {
    const m = document.getElementById('mname').value.trim();
    const gtxt = document.getElementById('gpu').value.trim();
    const gpu = gtxt === "" ? null : Number(gtxt);
    const cfgTxt = document.getElementById('cfg').value;
    setInlineMessage('start_msg', 'info', 'Starting model...');
    try {
        const j = await startModelWorker(toStartModelRequest({
            modelName: m,
            config: validateStartConfig(parseJSONSafe(cfgTxt, null)),
            gpuId: gpu,
        }));
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
    const target = document.getElementById('s_target').value;
    if (!target || !target.includes('|')) return;
    const [m, g] = target.split('|');
    try { const j = await stopModelWorker({ modelName: m, gpuId: g });
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
    if (simpleBtn) simpleBtn.disabled = !(validationState.g_sampling && validationState.g_prompt && validationState.g_pre_processor && validationState.g_post_processor && validationState.g_file_prompt);
    if (chatBtn) chatBtn.disabled = !(validationState.c_sampling && validationState.c_msgs && validationState.c_pre_processor && validationState.c_post_processor && validationState.c_file_prompt);
}

function validateJsonField({ inputId, statusId, optional = false, expectArray = false, key, itemValidator = null, itemError = 'Invalid item shape.' }) {
    return validateJsonFieldCore({
        inputId,
        statusId,
        optional,
        expectArray,
        key,
        itemValidator,
        itemError,
        setFieldStatus,
        setValidationFlag,
    });
}

async function validateUploadInput({ inputId, statusId, key, expectArray = true, itemValidator = null, itemError = 'Invalid item shape.' }) {
    return validateUploadInputCore({
        inputId,
        statusId,
        key,
        expectArray,
        itemValidator,
        itemError,
        setFieldStatus,
        setValidationFlag,
    });
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
    validateJsonField({ inputId: 'g_pre_processor', statusId: 'g_pre_processor_status', key: 'g_pre_processor', optional: true });
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
    validateJsonField({ inputId: 'c_pre_processor', statusId: 'c_pre_processor_status', key: 'c_pre_processor', optional: true });
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
    setGenerateValidity({
        simpleValid: validationState.g_sampling && validationState.g_prompt && validationState.g_pre_processor && validationState.g_post_processor && validationState.g_file_prompt,
        chatValid: validationState.c_sampling && validationState.c_msgs && validationState.c_pre_processor && validationState.c_post_processor && validationState.c_file_prompt,
    });
}

async function submitSimple() {
    await runFormValidations();
    if (!validationState.g_sampling || !validationState.g_prompt || !validationState.g_pre_processor || !validationState.g_post_processor || !validationState.g_file_prompt) {
        setInlineMessage('g_msg', 'err', 'Please fix invalid JSON fields before submitting.');
        return;
    }
    setButtonLoading('btnSimpleGenerate', true, 'Generating...');
    const m = (document.getElementById('g_model_manual').value.trim() || document.getElementById('g_model').value.trim());
    const useOffline = document.getElementById('g_offline').checked;
    const cleanupModelAfterJob = document.getElementById('g_cleanup_model').checked;
    const autoStart = document.getElementById('g_autostart').checked;
    const includeMetadata = document.getElementById('g_include_metadata').checked;
    const preProcessor = parseJSONSafe(document.getElementById('g_pre_processor').value, null);
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
        const payload = toSimpleGenerationRequest({
            modelName: m,
            useOffline,
            prompts,
            sampling,
            includeMetadata,
            cleanupModelAfterJob,
            preProcessor,
            postProcessor,
        });
        const j = await queueGeneration({ endpoint, payload, useOffline });
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
    if (!validationState.c_sampling || !validationState.c_msgs || !validationState.c_pre_processor || !validationState.c_post_processor || !validationState.c_file_prompt) {
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
    const preProcessor = parseJSONSafe(document.getElementById('c_pre_processor').value, null);
    const postProcessor = parseJSONSafe(document.getElementById('c_post_processor').value, null);
    const fileEl = document.getElementById('c_file');
    let prompts = parseJSONSafe(document.getElementById('c_msgs').value, []);
    const fromFile = await readFileAsJSON(fileEl); if (fromFile) prompts = fromFile;
    if (!m) { setInlineMessage('c_msg', 'err', 'Model is required.'); setButtonLoading('btnChatGenerate', false); return; }
    if (!Array.isArray(prompts)) { setInlineMessage('c_msg', 'err', 'Chat must be an array of items.'); setButtonLoading('btnChatGenerate', false); return; }
    try {
        if (useOffline) await ensureModelLoaded(m, autoStart);
        const endpoint = useOffline ? '/generate/offline' : '/generate/chat';
        const payload = toChatGenerationRequest({
            modelName: m,
            useOffline,
            prompts,
            sampling,
            outField,
            includeMetadata,
            cleanupModelAfterJob,
            preProcessor,
            postProcessor,
        });
        const j = await queueGeneration({ endpoint, payload, useOffline });
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

function bindUIEvents() {
    const bindClick = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    };
    const bindChange = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', handler);
    };
    const bindSubmit = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('submit', handler);
    };

    bindClick('btnStartModel', startModel);
    bindSubmit('stopWorkerForm', stopWorker);
    bindClick('btnRefreshStatus', refresh);
    bindChange('workerSel', switchWorker);
    bindClick('tabSimple', () => switchTab('simple'));
    bindClick('tabChat', () => switchTab('chat'));

    bindClick('btnGApplySampling', () => applySamplingForm('g'));
    bindClick('btnGSyncSampling', () => syncSamplingFormFromJson('g'));
    bindClick('btnGSamplingSave', () => saveSamplingBankItem('g'));
    bindClick('btnGSamplingLoad', () => loadSamplingBankItem('g'));
    bindClick('btnGSamplingDelete', () => deleteSamplingBankItem('g'));
    bindClick('btnGScriptAddConfig', () => addScriptConfigEntry('g'));
    bindClick('btnGScriptUsePre', () => buildPythonScriptProcessorSpec('g', 'pre'));
    bindClick('btnGScriptUsePost', () => buildPythonScriptProcessorSpec('g', 'post'));
    bindClick('btnGPresetSave', () => saveProcessorPreset('g'));
    bindClick('btnGPresetLoad', () => applyProcessorPreset('g'));
    bindClick('btnGPresetDelete', () => deleteProcessorPreset('g'));
    bindClick('btnGPromptSave', () => savePromptBankItem('g'));
    bindClick('btnGPromptLoad', () => loadPromptBankItem('g'));
    bindClick('btnGPromptDelete', () => deletePromptBankItem('g'));
    bindClick('btnSimpleGenerate', submitSimple);

    bindClick('btnCApplySampling', () => applySamplingForm('c'));
    bindClick('btnCSyncSampling', () => syncSamplingFormFromJson('c'));
    bindClick('btnCSamplingSave', () => saveSamplingBankItem('c'));
    bindClick('btnCSamplingLoad', () => loadSamplingBankItem('c'));
    bindClick('btnCSamplingDelete', () => deleteSamplingBankItem('c'));
    bindClick('btnCScriptAddConfig', () => addScriptConfigEntry('c'));
    bindClick('btnCScriptUsePre', () => buildPythonScriptProcessorSpec('c', 'pre'));
    bindClick('btnCScriptUsePost', () => buildPythonScriptProcessorSpec('c', 'post'));
    bindClick('btnCPresetSave', () => saveProcessorPreset('c'));
    bindClick('btnCPresetLoad', () => applyProcessorPreset('c'));
    bindClick('btnCPresetDelete', () => deleteProcessorPreset('c'));
    bindClick('btnCPromptSave', () => savePromptBankItem('c'));
    bindClick('btnCPromptLoad', () => loadPromptBankItem('c'));
    bindClick('btnCPromptDelete', () => deletePromptBankItem('c'));
    bindClick('btnChatGenerate', submitChat);

    bindClick('btnSaveJson', saveJSON);
    bindClick('btnCopyResult', copyResultToClipboard);
    bindClick('btnClearResults', clearResults);
}

export async function bootstrapUI() {
    logger.info('Bootstrapping UI');
    bindUIEvents();
    enableTabPlaceholderCompletion();
    await loadUiState();
    refreshProcessorPresetSelectors();
    refreshPromptBankSelectors();
    refreshSamplingBankSelectors();
    for (const id of ['g_sampling', 'g_prompt', 'g_pre_processor', 'g_post_processor', 'c_sampling', 'c_msgs', 'c_pre_processor', 'c_post_processor']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.addEventListener('input', () => { runFormValidations(); });
        el.addEventListener('blur', () => { runFormValidations(); });
    }
    for (const prefix of ['g', 'c']) {
        syncSamplingFormFromJson(prefix, false);
    }
    for (const prefix of ['g', 'c']) {
        renderScriptConfigEntries(prefix);
        initScriptBuilderDnD(prefix);
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
