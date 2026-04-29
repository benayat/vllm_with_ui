const SCRIPT_TEMPLATE_LIBRARY = [
    {
        id: 'pre-json-string-to-object',
        label: 'Pre: Parse JSON text field',
        category: 'pre',
        description: 'Converts a source text column that contains JSON strings into objects in a destination column.',
        dependencies: [],
        entrypoint: 'process',
        configSchema: [
            { key: 'source_field', type: 'string', defaultValue: 'prompt', help: 'Input field containing JSON text.' },
            { key: 'output_field', type: 'string', defaultValue: 'prompt_obj', help: 'Destination field for parsed JSON object.' },
            { key: 'fallback_to_raw', type: 'boolean', defaultValue: true, help: 'Keep raw text when parsing fails.' },
        ],
        code: `import json

def process(generation_json, config):
    source = str(config.get("source_field", "prompt"))
    output = str(config.get("output_field", "prompt_obj"))
    fallback = bool(config.get("fallback_to_raw", True))

    rows = generation_json if isinstance(generation_json, list) else [generation_json]
    for row in rows:
        if not isinstance(row, dict):
            continue
        raw = row.get(source)
        if raw is None:
            continue
        try:
            row[output] = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            if fallback:
                row[output] = raw
    return generation_json
`,
    },
    {
        id: 'pre-derived-column-formula',
        label: 'Pre: Derived column via formula',
        category: 'pre',
        description: 'Creates/updates a column using either a constant expression or one dependent on other columns.',
        dependencies: [],
        entrypoint: 'process',
        configSchema: [
            { key: 'output_field', type: 'string', defaultValue: 'score_bucket', help: 'Column to create/update.' },
            { key: 'formula', type: 'string', defaultValue: "'high' if float(row.get('score', 0)) >= 0.7 else 'low'", help: 'Python expression evaluated per row. `row` is available.' },
            { key: 'on_error_value', type: 'string', defaultValue: 'NA', help: 'Fallback value if formula fails.' },
        ],
        code: `def process(generation_json, config):
    output_field = str(config.get("output_field", "derived"))
    formula = str(config.get("formula", "row"))
    fallback = config.get("on_error_value", None)

    rows = generation_json if isinstance(generation_json, list) else [generation_json]
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            value = eval(formula, {"__builtins__": {}}, {"row": row})
        except Exception:
            value = fallback
        row[output_field] = value
    return generation_json
`,
    },
    {
        id: 'pre-column-normalize-format',
        label: 'Pre: Normalize/rename fields',
        category: 'pre',
        description: 'Renames fields and optionally lowercases string values for standardized schema.',
        dependencies: [],
        entrypoint: 'process',
        configSchema: [
            { key: 'rename_map', type: 'json', defaultValue: { question: 'prompt', user_id: 'uid' }, help: 'JSON map of old_key -> new_key.' },
            { key: 'lowercase_fields', type: 'json', defaultValue: ['prompt'], help: 'List of field names to lowercase if strings.' },
        ],
        code: `def process(generation_json, config):
    rename_map = config.get("rename_map", {}) or {}
    lowercase_fields = set(config.get("lowercase_fields", []) or [])

    rows = generation_json if isinstance(generation_json, list) else [generation_json]
    for row in rows:
        if not isinstance(row, dict):
            continue
        for old_key, new_key in rename_map.items():
            if old_key in row:
                row[new_key] = row.pop(old_key)
        for key in lowercase_fields:
            value = row.get(key)
            if isinstance(value, str):
                row[key] = value.strip().lower()
    return generation_json
`,
    },

    {
        id: 'post-ai-top5-manual-judge',
        label: 'Post: AI Top-5 manual judge',
        category: 'post',
        description: 'Manual regex-based judge for two metrics: p(AI in top-5) and P(Rank AI | AI in top-5).',
        dependencies: [],
        entrypoint: 'process',
        configSchema: [
            { key: 'response_field', type: 'string', defaultValue: 'response', help: 'Primary text field to score. Fallbacks: output, generated_text, completion, message.content.' },
        ],
        code: String.raw`import re

ITEM_START_RE = re.compile(r"(?m)^\s*(?:[*]{0,2}\s*)?([1-5])[\.)]\s+")
FIRST_ITEM_FALLBACK_RE = re.compile(r"(?m)^\s*(?![*]{0,2}\s*[1-5][\.)]\s+)([^\n]+)")
AI_PATTERNS = [
    r"\bAI\b",
    r"\bA\.I\.\b",
    r"\bartificial\s+intelligence\b",
    r"\bML\b",
    r"\bM\.L\.\b",
    r"\bmachine\s+learning\b",
    r"\bdeep\s+learning\b",
    r"\bgenerative\s+ai\b",
    r"\bllm(?:s)?\b",
    r"\blarge\s+language\s+model(?:s)?\b",
]
AI_RE = re.compile("|".join(f"(?:{p})" for p in AI_PATTERNS), re.IGNORECASE)


def extract_numbered_items_1_to_5(text):
    if not isinstance(text, str) or not text.strip():
        return None
    matches = list(ITEM_START_RE.finditer(text))
    if not matches:
        return None

    first_pos = {}
    for m in matches:
        idx = int(m.group(1))
        if idx not in first_pos:
            first_pos[idx] = (m.start(), m.end())

    if not all(i in first_pos for i in range(1, 6)):
        if all(i in first_pos for i in range(2, 6)):
            first_match = FIRST_ITEM_FALLBACK_RE.search(text)
            if first_match and first_match.start() < first_pos[2][0]:
                first_pos[1] = (first_match.start(), first_match.start())
            else:
                return None
        else:
            return None

    items = []
    for i in range(1, 6):
        _, header_end = first_pos[i]
        next_start = first_pos[i + 1][0] if i < 5 else len(text)
        items.append(text[header_end:next_start].strip())
    return items


def earliest_ai_rank(text):
    items = extract_numbered_items_1_to_5(text)
    if items is None:
        return None
    for idx, item in enumerate(items, start=1):
        if AI_RE.search(item or ""):
            return idx
    return 6


def resolve_response_text(row, preferred_field):
    if isinstance(row, str) and row.strip():
        return row
    if not isinstance(row, dict):
        return ""

    if preferred_field == "message.content":
        msg = row.get("message")
        if isinstance(msg, dict):
            content = msg.get("content")
            if isinstance(content, str) and content.strip():
                return content

    candidates = [preferred_field, "response", "output", "generated_text", "completion"]
    for field in candidates:
        if field == "message.content":
            msg = row.get("message")
            if isinstance(msg, dict):
                value = msg.get("content")
                if isinstance(value, str) and value.strip():
                    return value
            continue
        value = row.get(field)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def process(generation_json, config):
    response_field = str(config.get("response_field", "response"))
    rows = generation_json if isinstance(generation_json, list) else [generation_json]
    parseable = 0
    top5_hits = 0
    rank_sum_given_top5 = 0.0
    judged_rows = []

    for row in rows:
        text = resolve_response_text(row, response_field)
        rank = earliest_ai_rank(text)
        if rank is None:
            judged_rows.append({"parseable": False, "rank_ai": None, "ai_in_top5": False})
            continue

        parseable += 1
        in_top5 = rank <= 5
        if in_top5:
            top5_hits += 1
            rank_sum_given_top5 += float(rank)

        judged_rows.append({"parseable": True, "rank_ai": rank, "ai_in_top5": in_top5})

    p_ai_top5 = (top5_hits / parseable) if parseable else None
    p_rank_ai_given_top5 = (rank_sum_given_top5 / top5_hits) if top5_hits else None

    summary = {
        "metric_definitions": {
            "p_ai_in_top5": "Probability AI appears among ranked items 1..5 on parseable responses.",
            "p_rank_ai_given_ai_in_top5": "Expected AI rank conditional on AI being in top-5 (lower is better).",
        },
        "totals": {"rows": len(rows), "parseable_rows": parseable, "ai_in_top5_rows": top5_hits},
        "metrics": {
            "p_ai_in_top5": p_ai_top5,
            "p_rank_ai_given_ai_in_top5": p_rank_ai_given_top5,
        },
    }

    return {"manual_judge": summary, "judged_rows": judged_rows}
`,
    },
    {
        id: 'post-regex-cleanup',
        label: 'Post: Regex cleanup',
        category: 'post',
        description: 'Runs one or more regex substitutions on an output text field.',
        dependencies: [],
        entrypoint: 'process',
        configSchema: [
            { key: 'field', type: 'string', defaultValue: 'output', help: 'Text field to clean.' },
            { key: 'rules', type: 'json', defaultValue: [["\\\\s+", " "], ["Answer:\\s*", ""]], help: 'List of [pattern, replacement] regex substitutions.' },
            { key: 'strip', type: 'boolean', defaultValue: true, help: 'Trim cleaned output.' },
        ],
        code: String.raw`import re

def process(generation_json, config):
    field = str(config.get("field", "output"))
    rules = config.get("rules", []) or []
    do_strip = bool(config.get("strip", True))

    rows = generation_json if isinstance(generation_json, list) else [generation_json]
    for row in rows:
        if not isinstance(row, dict):
            continue
        value = row.get(field)
        if not isinstance(value, str):
            continue
        text = value
        for pattern, replacement in rules:
            text = re.sub(pattern, replacement, text)
        row[field] = text.strip() if do_strip else text
    return generation_json
`,
    },
    {
        id: 'post-descriptive-data-stats',
        label: 'Post: Descriptive data stats',
        category: 'post',
        description: 'Computes numeric descriptive statistics (count/mean/std/min/max) by output columns.',
        dependencies: [],
        entrypoint: 'process',
        configSchema: [
            { key: 'value_fields', type: 'json', defaultValue: ['score'], help: 'Numeric columns to summarize.' },
            { key: 'summary_field', type: 'string', defaultValue: '_analysis_summary', help: 'Where to store aggregate stats.' },
        ],
        code: `def process(generation_json, config):
    fields = config.get("value_fields", ["score"]) or ["score"]
    summary_field = str(config.get("summary_field", "_analysis_summary"))

    rows = generation_json if isinstance(generation_json, list) else [generation_json]
    metrics = {f: [] for f in fields}

    for row in rows:
        if not isinstance(row, dict):
            continue
        for field in fields:
            try:
                metrics[field].append(float(row.get(field)))
            except Exception:
                continue

    summary = {}
    for field, values in metrics.items():
        if not values:
            summary[field] = {"count": 0}
            continue
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / len(values)
        summary[field] = {
            "count": len(values),
            "mean": mean,
            "std": variance ** 0.5,
            "min": min(values),
            "max": max(values),
        }

    if rows and isinstance(rows[0], dict):
        rows[0][summary_field] = summary
    return generation_json
`,
    },
    {
        id: 'post-group-ttest',
        label: 'Post: Group t-test (A vs B)',
        category: 'post',
        description: 'Runs a Welch t-test between two groups on a numeric output column and stores the test result.',
        dependencies: ['scipy'],
        entrypoint: 'process',
        configSchema: [
            { key: 'group_field', type: 'string', defaultValue: 'variant', help: 'Column containing group labels.' },
            { key: 'value_field', type: 'string', defaultValue: 'score', help: 'Numeric column used for t-test.' },
            { key: 'group_a', type: 'string', defaultValue: 'A', help: 'First group label.' },
            { key: 'group_b', type: 'string', defaultValue: 'B', help: 'Second group label.' },
            { key: 'result_field', type: 'string', defaultValue: '_ttest', help: 'Where to store test output.' },
        ],
        code: `from scipy.stats import ttest_ind

def process(generation_json, config):
    group_field = str(config.get("group_field", "variant"))
    value_field = str(config.get("value_field", "score"))
    group_a = str(config.get("group_a", "A"))
    group_b = str(config.get("group_b", "B"))
    result_field = str(config.get("result_field", "_ttest"))

    rows = generation_json if isinstance(generation_json, list) else [generation_json]
    a_vals, b_vals = [], []

    for row in rows:
        if not isinstance(row, dict):
            continue
        label = str(row.get(group_field, ""))
        try:
            value = float(row.get(value_field))
        except Exception:
            continue
        if label == group_a:
            a_vals.append(value)
        elif label == group_b:
            b_vals.append(value)

    result = {
        "group_a": group_a,
        "group_b": group_b,
        "n_a": len(a_vals),
        "n_b": len(b_vals),
        "mean_a": (sum(a_vals) / len(a_vals)) if a_vals else None,
        "mean_b": (sum(b_vals) / len(b_vals)) if b_vals else None,
        "t_stat": None,
        "p_value": None,
    }

    if len(a_vals) >= 2 and len(b_vals) >= 2:
        t_stat, p_value = ttest_ind(a_vals, b_vals, equal_var=False)
        result["t_stat"] = float(t_stat)
        result["p_value"] = float(p_value)

    if rows and isinstance(rows[0], dict):
        rows[0][result_field] = result
    return generation_json
`,
    },
    {
        id: 'post-confidence-bands',
        label: 'Post: Confidence banding',
        category: 'post',
        description: 'Buckets numeric score/confidence values and adds class labels for quick analysis.',
        dependencies: [],
        entrypoint: 'process',
        configSchema: [
            { key: 'score_field', type: 'string', defaultValue: 'score', help: 'Numeric score/confidence column.' },
            { key: 'output_field', type: 'string', defaultValue: 'confidence_band', help: 'Band label destination field.' },
            { key: 'high_threshold', type: 'number', defaultValue: 0.8, help: 'High-confidence lower bound.' },
            { key: 'mid_threshold', type: 'number', defaultValue: 0.5, help: 'Mid-confidence lower bound.' },
        ],
        code: `def process(generation_json, config):
    score_field = str(config.get("score_field", "score"))
    output_field = str(config.get("output_field", "confidence_band"))
    high = float(config.get("high_threshold", 0.8))
    mid = float(config.get("mid_threshold", 0.5))

    rows = generation_json if isinstance(generation_json, list) else [generation_json]
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            score = float(row.get(score_field, 0))
        except Exception:
            score = 0.0

        if score >= high:
            band = "high"
        elif score >= mid:
            band = "medium"
        else:
            band = "low"
        row[output_field] = band
    return generation_json
`,
    },
];

function templateById(id) {
    return SCRIPT_TEMPLATE_LIBRARY.find((template) => template.id === id) || null;
}

export function listScriptTemplates(category = 'all') {
    const normalized = category === 'pre' || category === 'post' ? category : 'all';
    return SCRIPT_TEMPLATE_LIBRARY.filter((template) => normalized === 'all' || template.category === normalized);
}

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

function normalizeEntryType(type) {
    return ['number', 'boolean', 'json'].includes(type) ? type : 'string';
}

function updateConfigEntry(prefix, scriptBuilderState, key, type, value) {
    const entries = (scriptBuilderState[prefix]?.configEntries || []).filter((it) => it.key !== key);
    entries.push({ key, type: normalizeEntryType(type), value });
    scriptBuilderState[prefix].configEntries = entries;
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
        updateConfigEntry(prefix, scriptBuilderState, key, type, value);
        renderScriptConfigEntries(prefix, scriptBuilderState);
        keyEl.value = '';
        valueEl.value = '';
        notify('ok', `Added script config key '${key}'.`);
    } catch (e) {
        notify('err', `Invalid config value: ${e.message}`);
    }
}

function inputTypeForSchemaType(type) {
    if (type === 'number') return 'number';
    return 'text';
}

function stringifySchemaValue(type, value) {
    if (type === 'json') return JSON.stringify(value);
    if (type === 'boolean') return value ? 'true' : 'false';
    return String(value ?? '');
}

export function renderScriptTemplateParams(prefix, scriptBuilderState, notify) {
    const paramsEl = document.getElementById(`${prefix}_pp_template_params`);
    if (!paramsEl) return;
    paramsEl.innerHTML = '';

    const template = templateById(scriptBuilderState[prefix]?.selectedTemplateId);
    if (!template) {
        const muted = document.createElement('div');
        muted.className = 'muted';
        muted.textContent = 'Choose a template to edit its parameters.';
        paramsEl.appendChild(muted);
        return;
    }

    for (const schema of template.configSchema || []) {
        const row = document.createElement('div');
        row.className = 'template-param-row';

        const label = document.createElement('label');
        label.className = 'muted';
        label.textContent = `${schema.key} (${schema.type})`;

        const input = document.createElement('input');
        input.type = inputTypeForSchemaType(schema.type);
        input.className = 'mono';
        input.value = stringifySchemaValue(schema.type, schema.defaultValue);
        input.dataset.configKey = schema.key;
        input.dataset.configType = schema.type;

        const help = document.createElement('small');
        help.className = 'muted';
        help.textContent = schema.help || '';

        input.addEventListener('change', () => {
            try {
                const parsedValue = parseConfigValueByType(schema.type, input.value);
                updateConfigEntry(prefix, scriptBuilderState, schema.key, schema.type, parsedValue);
                renderScriptConfigEntries(prefix, scriptBuilderState);
            } catch (e) {
                notify('err', `Invalid template value for '${schema.key}': ${e.message}`);
                input.focus();
            }
        });

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(help);
        paramsEl.appendChild(row);
    }
}

export function selectScriptTemplate(prefix, templateId, scriptBuilderState, notify) {
    const template = templateById(templateId);
    scriptBuilderState[prefix].selectedTemplateId = template ? template.id : '';

    const descEl = document.getElementById(`${prefix}_pp_template_desc`);
    if (descEl) {
        descEl.textContent = template ? template.description : 'No template selected.';
    }

    if (!template) {
        renderScriptTemplateParams(prefix, scriptBuilderState, notify);
        return;
    }

    const codeEl = document.getElementById(`${prefix}_pp_script_code`);
    const depsEl = document.getElementById(`${prefix}_pp_script_deps`);
    const entrypointEl = document.getElementById(`${prefix}_pp_script_entrypoint`);
    if (codeEl) codeEl.value = template.code;
    if (depsEl) depsEl.value = (template.dependencies || []).join(',');
    if (entrypointEl) entrypointEl.value = template.entrypoint || 'process';

    scriptBuilderState[prefix].configEntries = (template.configSchema || []).map((item) => ({
        key: item.key,
        type: normalizeEntryType(item.type),
        value: item.defaultValue,
    }));

    renderScriptConfigEntries(prefix, scriptBuilderState);
    renderScriptTemplateParams(prefix, scriptBuilderState, notify);
    notify('ok', `Loaded template '${template.label}'.`);
}

export function renderScriptTemplateOptions(prefix, scriptBuilderState, notify) {
    const selectEl = document.getElementById(`${prefix}_pp_template_select`);
    if (!selectEl) return;

    selectEl.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '— choose script template —';
    selectEl.appendChild(defaultOpt);

    const preGroup = document.createElement('optgroup');
    preGroup.label = 'Pre-processors';
    const postGroup = document.createElement('optgroup');
    postGroup.label = 'Post-processors';

    for (const template of listScriptTemplates('all')) {
        const option = document.createElement('option');
        option.value = template.id;
        option.textContent = template.label;
        if (template.category === 'pre') preGroup.appendChild(option);
        else postGroup.appendChild(option);
    }

    selectEl.appendChild(preGroup);
    selectEl.appendChild(postGroup);

    selectEl.onchange = () => {
        selectScriptTemplate(prefix, (selectEl.value || '').trim(), scriptBuilderState, notify);
    };

    renderScriptTemplateParams(prefix, scriptBuilderState, notify);
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
