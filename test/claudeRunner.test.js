const { test } = require('node:test');
const assert = require('node:assert');
const { buildClaudeArgs } = require('../src/claudeRunner.js');

test('buildClaudeArgs：返回 claude 命令、-p + 映射参数、stdin: true', () => {
  const { cmd, args, stdin } = buildClaudeArgs('prompt', {
    tmpFile: '/tmp/x.md',
    cwd: '/work',
    agentConfig: { path: 'claude', permissionMode: 'bypassPermissions' },
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

test('buildClaudeArgs：未配置权限时不再硬编码 --permission-mode', () => {
  const { args } = buildClaudeArgs('p', { tmpFile: '/tmp/x.md', cwd: '.', agentConfig: { path: 'claude' } });
  assert.deepStrictEqual(args, ['-p']);
});

test('buildClaudeArgs：args 数组拼接在末尾', () => {
  const { args } = buildClaudeArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { path: 'claude', model: 'sonnet', args: ['--extra'] },
  });
  assert.deepStrictEqual(args, ['-p', '--model', 'sonnet', '--extra']);
});
