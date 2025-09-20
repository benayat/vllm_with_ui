let lastResult = null;
let evtSource = null;

const samplingDefault = { temperature: 0.0, top_p: 1.0, max_tokens: 256 };

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
async function readFileAsJSON(inputEl) { const f = inputEl.files && inputEl.files[0]; if (!f) return null; return JSON.parse(await f.text()); }

async function startModel() {
    const m = document.getElementById('mname').value.trim();
    const gtxt = document.getElementById('gpu').value.trim();
    const gpu = gtxt === "" ? null : Number(gtxt);
    const cfgTxt = document.getElementById('cfg').value;
    const msg = document.getElementById('start_msg'); msg.textContent='...';
    try {
        const body = { model_name: m, config: parseJSONSafe(cfgTxt, {}), gpu_id: gpu };
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
    const m = document.getElementById('g_model').value.trim();
    const sampling = parseJSONSafe(document.getElementById('g_sampling').value, samplingDefault);
    const fileEl = document.getElementById('g_file');
    let prompts = parseJSONSafe(document.getElementById('g_prompt').value, []);
    const fromFile = await readFileAsJSON(fileEl); if (fromFile) prompts = fromFile;
    if (!Array.isArray(prompts)) { document.getElementById('g_msg').innerHTML = '<span class="err">Prompts must be an array of strings.</span>'; return; }
    const res = await fetch('/generate/simple', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ model_name:m, prompts, sampling }) });
    const j = await res.json(); if (!res.ok) { document.getElementById('g_msg').innerHTML = `<span class="err">${j.detail || 'error'}</span>`; return; }
    document.getElementById('g_msg').innerHTML = `<span class="ok">queued (job ${j.job_id})</span>`;
    pollJob(j.job_id, 'g_msg');
}

async function submitChat() {
    const m = document.getElementById('c_model').value.trim();
    const sampling = parseJSONSafe(document.getElementById('c_sampling').value, samplingDefault);
    const outField = document.getElementById('c_outfield').value || "output";
    const fileEl = document.getElementById('c_file');
    let prompts = parseJSONSafe(document.getElementById('c_msgs').value, []);
    const fromFile = await readFileAsJSON(fileEl); if (fromFile) prompts = fromFile;
    if (!Array.isArray(prompts)) { document.getElementById('c_msg').innerHTML = '<span class="err">Chat must be an array of items.</span>'; return; }
    const res = await fetch('/generate/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ model_name:m, prompts, sampling, output_field: outField }) });
    const j = await res.json(); if (!res.ok) { document.getElementById('c_msg').innerHTML = `<span class="err">${j.detail || 'error'}</span>`; return; }
    document.getElementById('c_msg').innerHTML = `<span class="ok">queued (job ${j.job_id})</span>`;
    pollJob(j.job_id, 'c_msg');
}

refresh();
