import { createStore } from './createStore.js';

export const uiStateStore = createStore({
    value: null,
    lastLoadedAt: null,
});

export function setUiState(value) {
    uiStateStore.setState({
        value,
        lastLoadedAt: new Date().toISOString(),
    });
}
