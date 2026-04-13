import { apiClient } from '../services/apiClient.js';

export const UI_STATE_DEFAULT = {
    processor_presets: [],
    prompt_bank: { simple: [], chat: [] },
    sampling_bank: { simple: [], chat: [] },
};

export function normalizeUiState(data) {
    return {
        processor_presets: Array.isArray(data?.processor_presets) ? data.processor_presets : [],
        prompt_bank: data?.prompt_bank && typeof data.prompt_bank === 'object' ? data.prompt_bank : { simple: [], chat: [] },
        sampling_bank: data?.sampling_bank && typeof data.sampling_bank === 'object' ? data.sampling_bank : { simple: [], chat: [] },
    };
}

export async function loadUiStateFromApi() {
    const data = await apiClient.getUiState();
    return normalizeUiState(data);
}

export async function persistUiStateSection(section, value) {
    return apiClient.setUiStateSection(section, value);
}

export function getModeBank(bankRoot, mode) {
    const bank = bankRoot && typeof bankRoot === 'object' ? bankRoot : {};
    return Array.isArray(bank[mode]) ? bank[mode] : [];
}

export function setModeBank(bankRoot, mode, items) {
    const safeItems = Array.isArray(items) ? items : [];
    return {
        ...(bankRoot && typeof bankRoot === 'object' ? bankRoot : {}),
        [mode]: safeItems,
    };
}

export function upsertNamedItem(items, name, value) {
    const safeItems = Array.isArray(items) ? items : [];
    const next = safeItems.filter((item) => item?.name !== name);
    next.push({ name, value });
    next.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return next;
}

export function getNamedItem(items, name) {
    const safeItems = Array.isArray(items) ? items : [];
    return safeItems.find((item) => item?.name === name) || null;
}

export function deleteNamedItem(items, name) {
    const safeItems = Array.isArray(items) ? items : [];
    return safeItems.filter((item) => item?.name !== name);
}
