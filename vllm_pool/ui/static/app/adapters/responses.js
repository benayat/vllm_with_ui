export function toResultFromJob(jobId, jobResponse) {
    if (jobResponse.status === 'done') return { job_id: jobId, result: jobResponse.result };
    return { job_id: jobId, status: jobResponse.status, error: jobResponse.error };
}
