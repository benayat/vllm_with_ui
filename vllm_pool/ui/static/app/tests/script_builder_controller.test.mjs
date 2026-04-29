import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

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

test('post-ai-top5-manual-judge template Python code compiles and ranks AI mentions', () => {
  const template = listScriptTemplates('post').find((item) => item.id === 'post-ai-top5-manual-judge');
  assert.ok(template);

  const pySource = `${template.code}
sample = "1. Technology: cloud infrastructure\\n2. Healthcare: hospital systems\\n3. Energy: machine learning systems\\n4. Real Estate: housing demand\\n5. Consumer Goods: retail trends"
assert ITEM_START_RE.pattern
assert earliest_ai_rank(sample) == 3
`;

  const run = spawnSync('python3', ['-c', pySource], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});
