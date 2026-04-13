const TERMINAL = new Set(['done', 'error', 'canceled', 'not_found']);

export async function pollJobUntilTerminal({
    getJob,
    jobId,
    intervalMs = 1500,
    onProgress,
    onTerminal,
    onError,
}) {
    async function tick() {
        try {
            const job = await getJob(jobId);
            if (TERMINAL.has(job.status)) {
                if (onTerminal) onTerminal(job);
                return;
            }
            if (onProgress) onProgress(job);
            setTimeout(tick, intervalMs);
        } catch (err) {
            if (onError) onError(err);
        }
    }
    tick();
}

export function isTerminalStatus(status) {
    return TERMINAL.has(status);
}
