import { createStore } from './createStore.js';

export const appStore = createStore({
    activityLog: [],
    toasts: [],
});

export function pushActivity(entry) {
    appStore.update((state) => {
        const next = [entry, ...state.activityLog].slice(0, 30);
        return { ...state, activityLog: next };
    });
}

export function pushToast(toast) {
    appStore.update((state) => ({
        ...state,
        toasts: [...state.toasts, toast],
    }));
}
