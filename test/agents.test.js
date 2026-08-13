const { test } = require('node:test');
const assert = require('node:assert');
const { agents, AGENT_KEYS } = require('../src/agents.js');
const { buildPiArgs } = require('../src/piRunner.js');
const { buildClaudeArgs } = require('../src/claudeRunner.js');

test('注册表：pi 与 claude 两个 agent', () => {
  assert.deepStrictEqual(AGENT_KEYS, ['pi', 'claude']);
});

test('注册表：pi 条目声明 buildArgs 与 pathKeys', () => {
  assert.strictEqual(agents.pi.buildArgs, buildPiArgs);
  assert.deepStrictEqual(agents.pi.pathKeys, ['sessionDir']);
});

test('注册表：claude 条目声明 buildArgs 与 pathKeys', () => {
  assert.strictEqual(agents.claude.buildArgs, buildClaudeArgs);
  assert.deepStrictEqual(agents.claude.pathKeys, []);
});
