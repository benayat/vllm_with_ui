export function parseConfigValueByType(type, rawValue) {
    if (type === 'number') {
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed)) throw new Error('Number config value is invalid.');
        return parsed;
    }
    if (type === 'boolean') {
        const val = String(rawValue || '').trim().toLowerCase();
        if (val === 'true') return true;
        if (val === 'false') return false;
        throw new Error("Boolean config value must be 'true' or 'false'.");
    }
    if (type === 'json') return JSON.parse(rawValue);
    return String(rawValue ?? '');
}

export function renderScriptConfigEntries(prefix, scriptBuilderState) {
    const listEl = document.getElementById(`${prefix}_pp_cfg_rows`);
    if (!listEl) return;
    const entries = scriptBuilderState[prefix]?.configEntries || [];
    listEl.innerHTML = '';
    if (!entries.length) {
        const muted = document.createElement('div');
        muted.className = 'muted';
        muted.textContent = 'No config entries yet.';
        listEl.appendChild(muted);
        return;
    }
    entries.forEach((entry, idx) => {
        const row = document.createElement('div');
        row.className = 'script-config-row mono';
        const label = document.createElement('span');
        label.textContent = `${entry.key} (${entry.type}) = ${JSON.stringify(entry.value)}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Delete';
        btn.onclick = () => {
            scriptBuilderState[prefix].configEntries.splice(idx, 1);
            renderScriptConfigEntries(prefix, scriptBuilderState);
        };
        row.appendChild(label);
        row.appendChild(btn);
        listEl.appendChild(row);
    });
}

export function addScriptConfigEntry(prefix, scriptBuilderState, notify) {
    const keyEl = document.getElementById(`${prefix}_pp_cfg_key`);
    const typeEl = document.getElementById(`${prefix}_pp_cfg_type`);
    const valueEl = document.getElementById(`${prefix}_pp_cfg_value`);
    const key = (keyEl?.value || '').trim();
    const type = (typeEl?.value || 'string').trim();
    const rawValue = (valueEl?.value || '').trim();
    if (!key) {
        notify('err', 'Config key is required.');
        return;
    }
    try {
        const value = parseConfigValueByType(type, rawValue);
        const entries = scriptBuilderState[prefix].configEntries.filter((it) => it.key !== key);
        entries.push({ key, type, value });
        scriptBuilderState[prefix].configEntries = entries;
        renderScriptConfigEntries(prefix, scriptBuilderState);
        keyEl.value = '';
        valueEl.value = '';
        notify('ok', `Added script config key '${key}'.`);
    } catch (e) {
        notify('err', `Invalid config value: ${e.message}`);
    }
}

export function getScriptBuilderConfig(prefix, scriptBuilderState) {
    const entries = scriptBuilderState[prefix]?.configEntries || [];
    return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

export function setScriptBuilderTarget(prefix, target, scriptBuilderState) {
    scriptBuilderState[prefix].target = target === 'pre' ? 'pre' : 'post';
    const preZone = document.getElementById(`${prefix}_drop_pre`);
    const postZone = document.getElementById(`${prefix}_drop_post`);
    if (preZone) preZone.classList.toggle('active-target', scriptBuilderState[prefix].target === 'pre');
    if (postZone) postZone.classList.toggle('active-target', scriptBuilderState[prefix].target === 'post');
}

export function buildPythonScriptProcessorSpec(prefix, scriptBuilderState, notify, targetOverride = null) {
    const codeEl = document.getElementById(`${prefix}_pp_script_code`);
    const depsEl = document.getElementById(`${prefix}_pp_script_deps`);
    const entrypointEl = document.getElementById(`${prefix}_pp_script_entrypoint`);
    const target = targetOverride || scriptBuilderState[prefix]?.target || 'post';
    const targetSpecEl = document.getElementById(`${prefix}_${target}_processor`);
    if (!codeEl || !targetSpecEl) return;
    const code = (codeEl.value || '').trim();
    if (!code) {
        notify('err', 'Script code is required.');
        return;
    }
    const dependencies = (depsEl?.value || '').split(',').map((x) => x.trim()).filter((x) => x.length > 0);
    const entrypoint = ((entrypointEl?.value || '').trim() || 'process');
    const config = getScriptBuilderConfig(prefix, scriptBuilderState);
    const spec = {
        name: 'python_script',
        config: { code, entrypoint, ...config },
        runtime: { dependencies, auto_install: true },
        on_error: 'fail',
    };
    targetSpecEl.value = JSON.stringify(spec, null, 2);
    notify('ok', `Script applied to ${target === 'pre' ? 'pre' : 'post'}-processor.`);
}

export function initScriptBuilderDnD(prefix, scriptBuilderState, notify) {
    const card = document.getElementById(`${prefix}_script_card`);
    const zones = [
        document.getElementById(`${prefix}_drop_pre`),
        document.getElementById(`${prefix}_drop_post`),
    ].filter(Boolean);
    if (!card || !zones.length) return;
    card.addEventListener('dragstart', (ev) => {
        if (ev.dataTransfer) {
            ev.dataTransfer.setData('text/plain', `${prefix}:script`);
            ev.dataTransfer.effectAllowed = 'move';
        }
        card.dataset.dragging = '1';
    });
    card.addEventListener('dragend', () => {
        card.dataset.dragging = '';
        zones.forEach((z) => z.classList.remove('drag-over'));
    });
    zones.forEach((zone) => {
        zone.addEventListener('dragenter', (ev) => {
            ev.preventDefault();
            zone.classList.add('drag-over');
        });
        zone.addEventListener('dragover', (ev) => {
            ev.preventDefault();
            if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
            zone.classList.add('drag-over');
        });
        zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
        zone.addEventListener('drop', (ev) => {
            ev.preventDefault();
            zone.classList.remove('drag-over');
            const target = zone.dataset.target === 'pre' ? 'pre' : 'post';
            setScriptBuilderTarget(prefix, target, scriptBuilderState);
            buildPythonScriptProcessorSpec(prefix, scriptBuilderState, notify, target);
        });
    });
    setScriptBuilderTarget(prefix, scriptBuilderState[prefix].target, scriptBuilderState);
}
