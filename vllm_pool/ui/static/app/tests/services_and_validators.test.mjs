import test from 'node:test';
import assert from 'node:assert/strict';

import { pollJobUntilTerminal, isTerminalStatus } from '../services/jobPollingService.js';
import { storageService } from '../services/storageService.js';
import { validateJsonField, validateUploadInput } from '../validators/formValidators.js';

function installDocument(elements) {
  global.document = {
    getElementById(id) {
      return elements[id] || null;
    },
  };
}

test('job polling reaches terminal state', async () => {
  const statuses = ['queued', 'running', 'done'];
  let calls = 0;
  await new Promise((resolve, reject) => {
    pollJobUntilTerminal({
      jobId: 'job-1',
      intervalMs: 1,
      getJob: async () => ({ status: statuses[calls++] || 'done' }),
      onTerminal: (job) => {
        try {
          assert.equal(job.status, 'done');
          assert.ok(calls >= 3);
          resolve();
        } catch (e) {
          reject(e);
        }
      },
      onError: reject,
    });
  });
  assert.equal(isTerminalStatus('done'), true);
  assert.equal(isTerminalStatus('running'), false);
});

test('storageService get/set/remove JSON', () => {
  const map = new Map();
  global.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };

  assert.equal(storageService.setJSON('k', { a: 1 }), true);
  assert.deepEqual(storageService.getJSON('k', null), { a: 1 });
  assert.equal(storageService.remove('k'), true);
  assert.equal(storageService.getJSON('k', 'fallback'), 'fallback');
});

test('validateJsonField validates required array shape', () => {
  const statuses = {};
  installDocument({
    field: { value: '[{"prompt":"hi"}]' },
  });
  const flags = {};

  const ok = validateJsonField({
    inputId: 'field',
    statusId: 'status',
    key: 'k',
    expectArray: true,
    itemValidator: (x) => typeof x.prompt === 'string',
    setFieldStatus: (id, kind, msg) => { statuses[id] = { kind, msg }; },
    setValidationFlag: (k, v) => { flags[k] = v; },
  });

  assert.equal(ok, true);
  assert.equal(flags.k, true);
  assert.equal(statuses.status.kind, 'ok');
});

test('validateUploadInput validates uploaded array file', async () => {
  const statuses = {};
  installDocument({
    upload: {
      files: [{
        name: 'p.json',
        text: async () => '[{"messages":[]}]',
      }],
    },
  });
  const flags = {};

  const ok = await validateUploadInput({
    inputId: 'upload',
    statusId: 'upload_status',
    key: 'upload_key',
    expectArray: true,
    itemValidator: (x) => Array.isArray(x.messages),
    setFieldStatus: (id, kind, msg) => { statuses[id] = { kind, msg }; },
    setValidationFlag: (k, v) => { flags[k] = v; },
  });

  assert.equal(ok, true);
  assert.equal(flags.upload_key, true);
  assert.equal(statuses.upload_status.kind, 'ok');
});
