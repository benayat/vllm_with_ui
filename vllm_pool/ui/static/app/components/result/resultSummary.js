import { setSummaryCards } from '../shared/summaryCards.js';

export function renderResultSummary(resultObj) {
    if (!resultObj || typeof resultObj !== 'object') {
        setSummaryCards('resultSummary', []);
        return;
    }
    const resultRows = Array.isArray(resultObj.result)
        ? resultObj.result.length
        : (Array.isArray(resultObj.rows) ? resultObj.rows.length : 0);
    setSummaryCards('resultSummary', [
        { k: 'Job ID', v: resultObj.job_id || '—' },
        { k: 'Status', v: resultObj.status || (resultObj.error ? 'error' : 'done') },
        { k: 'Rows', v: String(resultRows) },
        { k: 'Error', v: resultObj.error ? 'Yes' : 'No' },
    ]);
}
