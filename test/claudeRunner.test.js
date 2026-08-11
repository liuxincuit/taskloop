const { test } = require('node:test');
const assert = require('node:assert');
const { buildClaudeArgs } = require('../src/claudeRunner.js');

test('buildClaudeArgs：返回 claude 命令、-p + bypassPermissions、stdin: true', () => {
  const { cmd, args, stdin } = buildClaudeArgs('prompt', {
    tmpFile: '/tmp/x.md',
    cwd: '/work',
    agentConfig: { path: 'claude' },
  });
  assert.strictEqual(cmd, 'claude');
  assert.deepStrictEqual(args, ['-p', '--permission-mode', 'bypassPermissions']);
  assert.strictEqual(stdin, true);
});

test('buildClaudeArgs：path 缺省为 claude', () => {
  const { cmd } = buildClaudeArgs('p', { tmpFile: '/tmp/x.md', cwd: '.', agentConfig: {} });
  assert.strictEqual(cmd, 'claude');
});

test('buildClaudeArgs：path 自定义完整路径', () => {
  const { cmd } = buildClaudeArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { path: '/opt/claude/bin/claude' },
  });
  assert.strictEqual(cmd, '/opt/claude/bin/claude');
});
