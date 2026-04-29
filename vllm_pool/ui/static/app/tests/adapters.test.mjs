import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toStartModelRequest,
  toSimpleGenerationRequest,
  toChatGenerationRequest,
} from '../adapters/requests.js';
import { toResultFromJob } from '../adapters/responses.js';

test('toStartModelRequest maps camelCase to API payload', () => {
  const payload = toStartModelRequest({ modelName: 'm', config: { a: 1 }, gpuId: 2 });
  assert.deepEqual(payload, { model_name: 'm', config: { a: 1 }, gpu_id: 2 });
});

test('toSimpleGenerationRequest handles offline and online modes', () => {
  const base = {
    modelName: 'm',
    prompts: [{ prompt: 'hi' }],
    sampling: { temperature: 0 },
    includeMetadata: true,
    cleanupModelAfterJob: true,
    preProcessor: null,
    postProcessor: null,
  };
  const online = toSimpleGenerationRequest({ ...base, useOffline: false });
  assert.equal(online.type, undefined);
  assert.equal(online.model_name, 'm');

  const offline = toSimpleGenerationRequest({ ...base, useOffline: true });
  assert.equal(offline.type, 'generate');
  assert.equal(offline.cleanup_model_after_job, true);
});

test('toChatGenerationRequest maps output field and offline type', () => {
  const payload = toChatGenerationRequest({
    modelName: 'm',
    useOffline: true,
    prompts: [{ messages: [] }],
    sampling: {},
    outField: 'output',
    includeMetadata: false,
    cleanupModelAfterJob: false,
    preProcessor: null,
    postProcessor: null,
  });
  assert.equal(payload.type, 'chat');
  assert.equal(payload.output_field, 'output');
});

test('toResultFromJob returns done payload and error payload', () => {
  assert.deepEqual(
    toResultFromJob('j1', { status: 'done', result: [{ output: 'ok' }] }),
    { job_id: 'j1', result: [{ output: 'ok' }] },
  );

  assert.deepEqual(
    toResultFromJob('j2', { status: 'error', error: 'failed' }),
    { job_id: 'j2', status: 'error', error: 'failed' },
  );
});
