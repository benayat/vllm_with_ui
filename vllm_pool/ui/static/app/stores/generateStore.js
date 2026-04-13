import { createStore } from './createStore.js';

export const generateStore = createStore({
    simpleValid: false,
    chatValid: false,
});

export function setGenerateValidity({ simpleValid, chatValid }) {
    generateStore.update((state) => ({
        ...state,
        simpleValid: !!simpleValid,
        chatValid: !!chatValid,
    }));
}
