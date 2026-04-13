import { createStore } from './createStore.js';

export const modelStore = createStore({
    models: [],
    workers: [],
});

export function setModels(models) {
    modelStore.update((state) => ({ ...state, models: Array.isArray(models) ? models : [] }));
}

export function setWorkers(workers) {
    modelStore.update((state) => ({ ...state, workers: Array.isArray(workers) ? workers : [] }));
}
