const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { runAgent } = require('../src/agentRunner.js');

function makeFakeChild(exitCode) {
  const child = new EventEmitter();
  child.kill = () => { child.emit('exit', exitCode); };
  process.nextTick(() => child.emit('exit', exitCode));
  return child;
}

const agentConfig = { sessionDir: '/work/.pi-sessions', path: 'pi' };

// mock 接在 spawn 输入层（shell 之前），这里模拟 shell 剥离引号，还原真实进程收到的参数
function unquoteShellArg(arg) {
  return arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg;
}

test('runAgent：spawn 参数来自注册表 buildArgs，临时文件内容为 prompt', async () => {
  let spawnArgs = null;
  let tmpContent = null;
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    tmpContent = fs.readFileSync(unquoteShellArg(args[1]).slice(1), 'utf8');
    return makeFakeChild(0);
  };
  const result = await runAgent('处理 CS-1', {
    agent: 'pi', cwd: '/work', agentConfig, spawnFn,
  });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(spawnArgs.cmd, 'pi');
  assert.strictEqual(spawnArgs.opts.cwd, '/work');
  assert.strictEqual(spawnArgs.opts.stdio, 'inherit');
  assert.deepStrictEqual(spawnArgs.args, ['-p', spawnArgs.args[1], '--session-dir', spawnArgs.args[3]]);
  assert.strictEqual(unquoteShellArg(spawnArgs.args[3]), '/work/.pi-sessions');
  const tmpArg = unquoteShellArg(spawnArgs.args[1]);
  assert.ok(tmpArg.startsWith('@'));
  assert.ok(tmpArg.includes('agent-task-'));
  assert.strictEqual(tmpContent, '处理 CS-1');
});

test('runAgent：win32 下对非 flag 参数包引号并 shell: true', async () => {
  let spawnArgs = null;
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { args, opts };
    return makeFakeChild(0);
  };
  await runAgent('x', {
    agent: 'pi', cwd: '/work', agentConfig, spawnFn, isWin: true,
  });
  assert.strictEqual(spawnArgs.args[0], '-p');                  // flag 不加引号
  assert.ok(spawnArgs.args[1].startsWith('"@'));               // @tmpfile 加引号
  assert.ok(spawnArgs.args[1].endsWith('.md"'));
  assert.strictEqual(spawnArgs.args[2], '--session-dir');       // flag 不加引号
  assert.strictEqual(spawnArgs.args[3], '"/work/.pi-sessions"'); // 值加引号
  assert.strictEqual(spawnArgs.opts.shell, true);
});

test('runAgent：执行后删除临时文件', async () => {
  let tmpPath = null;
  const spawnFn = (cmd, args) => {
    tmpPath = unquoteShellArg(args[1]).slice(1);
    return makeFakeChild(0);
  };
  await runAgent('x', { agent: 'pi', cwd: '.', agentConfig, spawnFn });
  assert.strictEqual(fs.existsSync(tmpPath), false);
});

test('runAgent：非零退出码返回且不抛异常', async () => {
  const result = await runAgent('x', {
    agent: 'pi', cwd: '.', agentConfig, spawnFn: () => makeFakeChild(1),
  });
  assert.strictEqual(result.exitCode, 1);
});

test('runAgent：onChild 回调收到 child 对象', async () => {
  let received = null;
  const spawnFn = () => makeFakeChild(0);
  await runAgent('x', {
    agent: 'pi', cwd: '.', agentConfig, spawnFn,
    onChild: (child) => { received = child; },
  });
  assert.ok(received);
});

test('runAgent：onChild 同步抛错时 reject 该错误并调用 kill', async () => {
  let killed = false;
  const spawnFn = () => {
    const child = makeFakeChild(0);
    const origKill = child.kill;
    child.kill = () => { killed = true; origKill(); };
    return child;
  };
  await assert.rejects(
    runAgent('x', { agent: 'pi', cwd: '.', agentConfig, spawnFn,
      onChild: () => { throw new Error('onChild boom'); } }),
    /onChild boom/
  );
  assert.strictEqual(killed, true);
});

test('runAgent：spawn error 事件 reject 且清理临时文件', async () => {
  let tmpPath = null;
  const spawnFn = (cmd, args) => {
    tmpPath = unquoteShellArg(args[1]).slice(1);
    const child = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  };
  await assert.rejects(
    runAgent('x', { agent: 'pi', cwd: '.', agentConfig, spawnFn }),
    /ENOENT/
  );
  assert.strictEqual(fs.existsSync(tmpPath), false);
});

test('runAgent：claude 声明 stdin，prompt 写入子进程 stdin 并 end，stdio 为 pipe', async () => {
  let spawnArgs = null;
  const stdin = new EventEmitter();
  stdin.write = (data) => { stdin.data = data; };
  stdin.end = () => { stdin.ended = true; };
  const child = makeFakeChild(0);
  child.stdin = stdin;
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    return child;
  };
  const result = await runAgent('处理 CS-1', {
    agent: 'claude', cwd: '/work', agentConfig: { path: 'claude', permissionMode: 'bypassPermissions' }, spawnFn, isWin: true,
  });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(spawnArgs.cmd, 'claude');
  assert.deepStrictEqual(spawnArgs.args, ['-p', '--permission-mode', '"bypassPermissions"']);
  assert.deepStrictEqual(spawnArgs.opts.stdio, ['pipe', 'inherit', 'inherit']);
  assert.strictEqual(stdin.data, '处理 CS-1');
  assert.strictEqual(stdin.ended, true);
});

test('runAgent：claude stdin 收到 error（EPIPE）不崩溃', async () => {
  const stdin = new EventEmitter();
  stdin.write = () => {};
  stdin.end = () => {};
  const child = makeFakeChild(0);
  child.stdin = stdin;
  const spawnFn = () => child;
  const result = await runAgent('x', {
    agent: 'claude', cwd: '.', agentConfig: { path: 'claude' }, spawnFn,
  });
  assert.strictEqual(result.exitCode, 0);
  stdin.emit('error', new Error('EPIPE')); // 若无 error 监听器，EventEmitter 会同步抛 "Unhandled 'error' event" 使测试失败
});
