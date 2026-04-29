async function parseJsonSafe(response) {
    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return { detail: text };
    }
}

async function request(path, options = {}) {
    const response = await fetch(path, options);
    const data = await parseJsonSafe(response);
    if (!response.ok) {
        const detail = data?.detail || `Request failed with status ${response.status}`;
        const err = new Error(detail);
        err.status = response.status;
        err.data = data;
        throw err;
    }
    return data;
}

export const apiClient = {
    getStatus() {
        return request('/status');
    },
    getModels() {
        return request('/models');
    },
    getWorkers() {
        return request('/workers');
    },
    getJob(jobId) {
        return request(`/jobs/${jobId}`);
    },
    getUiState() {
        return request('/ui/state');
    },
    setUiStateSection(section, value) {
        return request(`/ui/state/${section}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value }),
        });
    },
    startModel(payload) {
        return request('/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    },
    stopWorker(formData) {
        return request('/stop', {
            method: 'POST',
            body: formData,
        });
    },
    submitGenerate(endpoint, payload, { offline = false } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (offline) headers['X-UI-Request'] = '1';
        return request(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
    },
};
