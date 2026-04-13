import { apiClient } from '../services/apiClient.js';

export async function queueGeneration({ endpoint, payload, useOffline }) {
    return apiClient.submitGenerate(endpoint, payload, { offline: useOffline });
}

export async function getJobStatus(jobId) {
    return apiClient.getJob(jobId);
}
