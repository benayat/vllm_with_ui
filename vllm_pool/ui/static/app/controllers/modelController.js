import { apiClient } from '../services/apiClient.js';

export async function ensureModelLoaded({ modelName, autoStartEnabled, config, gpuId, onModelAutoStarted = null }) {
    if (!autoStartEnabled) return false;
    const modelsJson = await apiClient.getModels();
    if ((modelsJson.models || []).includes(modelName)) return false;

    const payload = { model_name: modelName, config, gpu_id: gpuId };
    const started = await apiClient.startModel(payload);
    if (onModelAutoStarted) onModelAutoStarted(started);
    return true;
}

export async function startModelWorker({ modelName, model_name, config, gpuId, gpu_id }) {
    const resolvedModel = modelName ?? model_name;
    const resolvedGpu = gpuId ?? gpu_id;
    return apiClient.startModel({ model_name: resolvedModel, config, gpu_id: resolvedGpu });
}

export async function stopModelWorker({ modelName, gpuId }) {
    const form = new FormData();
    form.append('model_name', modelName);
    form.append('gpu_id', Number(gpuId));
    return apiClient.stopWorker(form);
}
