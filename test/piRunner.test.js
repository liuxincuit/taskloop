const { test } = require('node:test');
const assert = require('node:assert');
const { buildPiArgs } = require('../src/piRunner.js');

test('buildPiArgs：返回 pi 命令与 -p @tmpfile --session-dir 参数', () => {
  const { cmd, args } = buildPiArgs('prompt', {
    tmpFile: '/tmp/pi-task-1.md',
    cwd: '/work',
    agentConfig: { sessionDir: '/work/.pi-sessions', path: 'pi' },
  });
  assert.strictEqual(cmd, 'pi');
  assert.deepStrictEqual(args, ['-p', '@/tmp/pi-task-1.md', '--session-dir', '/work/.pi-sessions']);
});

test('buildPiArgs：path 缺省为 pi', () => {
  const { cmd } = buildPiArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { sessionDir: '/work' },
  });
  assert.strictEqual(cmd, 'pi');
});

test('buildPiArgs：path 自定义完整路径', () => {
  const { cmd } = buildPiArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { sessionDir: '/work', path: '/opt/pi/bin/pi' },
  });
  assert.strictEqual(cmd, '/opt/pi/bin/pi');
});

test('buildPiArgs：sessionDir 透传', () => {
  const { args } = buildPiArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { sessionDir: '/sessions' },
  });
  assert.deepStrictEqual(args, ['-p', '@/tmp/x.md', '--session-dir', '/sessions']);
});
