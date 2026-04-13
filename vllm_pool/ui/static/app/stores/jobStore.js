import { createStore } from './createStore.js';

export const jobStore = createStore({
    lastResult: null,
});

export function setLastResult(result) {
    jobStore.update((state) => ({ ...state, lastResult: result }));
}

export function clearLastResult() {
    jobStore.update((state) => ({ ...state, lastResult: null }));
}
