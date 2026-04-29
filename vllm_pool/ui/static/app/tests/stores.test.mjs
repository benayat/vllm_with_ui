import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../stores/createStore.js';
import { modelStore, setModels, setWorkers } from '../stores/modelStore.js';
import { generateStore, setGenerateValidity } from '../stores/generateStore.js';
import { uiStateStore, setUiState } from '../stores/uiStateStore.js';

test('createStore supports get/update/subscribe', () => {
  const s = createStore({ n: 0 });
  let observed = null;
  const unsub = s.subscribe((st) => { observed = st.n; });
  s.update((st) => ({ ...st, n: 1 }));
  assert.equal(s.getState().n, 1);
  assert.equal(observed, 1);
  unsub();
});

test('modelStore setters normalize arrays', () => {
  setModels(['m1']);
  setWorkers([{ key: 'k1' }]);
  assert.deepEqual(modelStore.getState().models, ['m1']);
  assert.equal(modelStore.getState().workers[0].key, 'k1');
});

test('generateStore tracks simple/chat validity', () => {
  setGenerateValidity({ simpleValid: true, chatValid: false });
  assert.equal(generateStore.getState().simpleValid, true);
  assert.equal(generateStore.getState().chatValid, false);
});

test('uiStateStore captures snapshot and timestamp', () => {
  setUiState({ prompt_bank: { simple: [] } });
  const state = uiStateStore.getState();
  assert.deepEqual(state.value, { prompt_bank: { simple: [] } });
  assert.ok(typeof state.lastLoadedAt === 'string' && state.lastLoadedAt.length > 0);
});
