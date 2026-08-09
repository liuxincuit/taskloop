const { test } = require('node:test');
const assert = require('node:assert');
const { agents, AGENT_KEYS } = require('../src/agents.js');
const { buildPiArgs } = require('../src/piRunner.js');

test('注册表：只有 pi 一个 agent', () => {
  assert.deepStrictEqual(AGENT_KEYS, ['pi']);
});

test('注册表：pi 条目声明 buildArgs 与 optionKeys', () => {
  assert.strictEqual(agents.pi.buildArgs, buildPiArgs);
  assert.deepStrictEqual(agents.pi.optionKeys, ['sessionDir', 'path']);
});
