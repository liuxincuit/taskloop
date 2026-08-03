const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { runPi } = require('../src/piRunner.js');

function makeFakeChild(exitCode) {
  const child = new EventEmitter();
  child.kill = () => { child.emit('exit', exitCode); };
  process.nextTick(() => child.emit('exit', exitCode));
  return child;
}

test('runPi：spawn 参数与临时文件内容', async () => {
  let spawnArgs = null;
  let tmpContent = null;
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    const tmpArg = args[1].replace(/^"|"$/g, '');
    tmpContent = fs.readFileSync(tmpArg.slice(1), 'utf8');
    return makeFakeChild(0);
  };
  const result = await runPi('处理 CS-1', {
    cwd: 'C:/work',
    sessionDir: 'C:/work/.pi-sessions',
    spawnFn,
  });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(spawnArgs.cmd, 'pi');
  assert.strictEqual(spawnArgs.opts.cwd, 'C:/work');
  assert.strictEqual(spawnArgs.opts.stdio, 'inherit');
  const rawArgs = spawnArgs.args.map((a) => a.replace(/^"|"$/g, ''));
  assert.strictEqual(rawArgs[0], '-p');
  assert.ok(rawArgs[1].startsWith('@'));
  assert.ok(rawArgs[1].includes('pi-task-'));
  assert.strictEqual(rawArgs[2], '--session-dir');
  assert.strictEqual(rawArgs[3], 'C:/work/.pi-sessions');
  assert.strictEqual(tmpContent, '处理 CS-1');
});

test('runPi：执行后删除临时文件', async () => {
  let tmpPath = null;
  const spawnFn = (cmd, args) => {
    tmpPath = args[1].replace(/^"|"$/g, '').slice(1);
    return makeFakeChild(0);
  };
  await runPi('x', { cwd: '.', sessionDir: '.', spawnFn });
  assert.strictEqual(fs.existsSync(tmpPath), false);
});

test('runPi：非零退出码返回且不抛异常', async () => {
  const result = await runPi('x', {
    cwd: '.', sessionDir: '.', spawnFn: () => makeFakeChild(1),
  });
  assert.strictEqual(result.exitCode, 1);
});

test('runPi：onChild 回调收到 child 对象', async () => {
  let received = null;
  const spawnFn = () => makeFakeChild(0);
  await runPi('x', {
    cwd: '.', sessionDir: '.', spawnFn,
    onChild: (child) => { received = child; },
  });
  assert.ok(received);
});

test('runPi：spawn error 事件 reject 且清理临时文件', async () => {
  let tmpPath = null;
  const spawnFn = (cmd, args) => {
    tmpPath = args[1].replace(/^"|"$/g, '').slice(1);
    const child = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  };
  await assert.rejects(runPi('x', { cwd: '.', sessionDir: '.', spawnFn }), /ENOENT/);
  assert.strictEqual(fs.existsSync(tmpPath), false);
});
