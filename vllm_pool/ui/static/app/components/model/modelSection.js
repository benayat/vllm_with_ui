export function renderModelOptions(modelIds, models) {
    for (const id of modelIds) {
        const sel = document.getElementById(id);
        if (!sel) continue;
        sel.innerHTML = '';
        const arr = Array.isArray(models) ? models : [];
        if (!arr.length) {
            const o = document.createElement('option');
            o.value = '';
            o.textContent = '— no models loaded —';
            sel.appendChild(o);
            continue;
        }
        for (const model of arr) {
            const o = document.createElement('option');
            o.value = model;
            o.textContent = model;
            sel.appendChild(o);
        }
    }
}

export function renderWorkerOptions(workers) {
    const sel = document.getElementById('workerSel');
    if (!sel) return;
    sel.innerHTML = '';
    const arr = Array.isArray(workers) ? workers : [];
    if (!arr.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '— no workers —';
        sel.appendChild(o);
        return;
    }
    for (const w of arr) {
        const o = document.createElement('option');
        o.value = w.key;
        o.textContent = `gpu ${w.gpu_id} — ${w.model}`;
        sel.appendChild(o);
    }
}

export function renderStopTargets(workers) {
    const sel = document.getElementById('s_target');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— select deployed model —';
    sel.appendChild(blank);

    const arr = Array.isArray(workers) ? workers : [];
    for (const w of arr) {
        const o = document.createElement('option');
        o.value = `${w.model}|${w.gpu_id}`;
        o.textContent = `${w.model} (gpu ${w.gpu_id})`;
        sel.appendChild(o);
    }
    if (prev && Array.from(sel.options).some((opt) => opt.value === prev)) sel.value = prev;
}
