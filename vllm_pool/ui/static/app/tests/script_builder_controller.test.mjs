import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listScriptTemplates,
  parseConfigValueByType,
  getScriptBuilderConfig,
} from '../controllers/scriptBuilderController.js';

test('listScriptTemplates returns pre and post template groups', () => {
  const all = listScriptTemplates('all');
  const pre = listScriptTemplates('pre');
  const post = listScriptTemplates('post');

  assert.ok(all.length >= 6);
  assert.ok(pre.length >= 3);
  assert.ok(post.length >= 3);
  assert.ok(pre.every((item) => item.category === 'pre'));
  assert.ok(post.every((item) => item.category === 'post'));
});

test('parseConfigValueByType parses primitive and json types', () => {
  assert.equal(parseConfigValueByType('number', '12.5'), 12.5);
  assert.equal(parseConfigValueByType('boolean', 'true'), true);
  assert.equal(parseConfigValueByType('boolean', 'false'), false);
  assert.deepEqual(parseConfigValueByType('json', '{"a":1}'), { a: 1 });
  assert.equal(parseConfigValueByType('string', 42), '42');

  assert.throws(() => parseConfigValueByType('number', 'abc'));
  assert.throws(() => parseConfigValueByType('boolean', 'yes'));
});

test('getScriptBuilderConfig maps config entry list to key-value object', () => {
  const state = {
    g: {
      configEntries: [
        { key: 'field', type: 'string', value: 'output' },
        { key: 'strip', type: 'boolean', value: true },
      ],
    },
  };

  assert.deepEqual(getScriptBuilderConfig('g', state), { field: 'output', strip: true });
});
