import { setSummaryCards } from '../shared/summaryCards.js';

export function renderStatusSummary(statusObj) {
    if (!statusObj || typeof statusObj !== 'object') {
        setSummaryCards('statusSummary', []);
        return;
    }
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
    const hintEl = document.getElementById('statusHint');
    if (!hintEl) return;
    if (hasError) hintEl.textContent = `Status endpoint returned an error: ${statusObj.error}`;
    else if (workers === 0) hintEl.textContent = 'No workers are running yet. Start a model in the Start model panel to enable generation.';
    else if (jobs > 0) hintEl.textContent = `${jobs} job(s) pending or running. You can monitor progress in Recent activity and the response panel.`;
    else hintEl.textContent = 'System is healthy. You can submit generation jobs now.';
}
