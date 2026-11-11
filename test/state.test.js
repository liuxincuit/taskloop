const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../src/state.js');

function tmpFile(name = 'state.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-state-'));
  return path.join(dir, name);
}

test('load：文件不存在时以空状态启动并且不写文件', () => {
  const file = tmpFile();
  const store = new StateStore({ file });
  const snap = store.load();

  assert.deepStrictEqual(snap.tasks, []);
  assert.deepStrictEqual(snap.logs, []);
  assert.strictEqual(fs.existsSync(file), false, '不应在只读时创建文件');
});

test('recordTask / recordLog：写入后可以从磁盘读回（读写往返）', () => {
  const file = tmpFile();
  const store = new StateStore({ file });
  store.load();

  store.recordTask({ id: 'CS-1', source: 'youtrack', status: 'success', durationMs: 1200 });
  store.recordLog({ level: 'info', message: '本轮开始' });

  const snapshot = new StateStore({ file }).load();
  assert.strictEqual(snapshot.tasks.length, 1);
  assert.strictEqual(snapshot.tasks[0].id, 'CS-1');
  assert.strictEqual(snapshot.tasks[0].status, 'success');
  assert.strictEqual(snapshot.logs.length, 1);
  assert.strictEqual(snapshot.logs[0].message, '本轮开始');
});

test('recordTask：同 id 的执行中记录会被就地更新而不是重复追加', () => {
  const file = tmpFile();
  const store = new StateStore({ file });
  store.load();

  store.recordTask({ id: 'CS-9', source: 'youtrack', status: 'running', startedAt: 100 });
  store.recordTask({ id: 'CS-9', source: 'youtrack', status: 'success', startedAt: 100, durationMs: 500 });

  assert.strictEqual(store.data.tasks.length, 1);
  assert.strictEqual(store.data.tasks[0].status, 'success');
  assert.strictEqual(store.data.tasks[0].durationMs, 500);
});

test('load：把执行中的记录标记为已中断', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    tasks: [
      { id: 'A', status: 'running' },
      { id: 'B', status: 'success' },
    ],
    logs: [],
  }));

  const snapshot = new StateStore({ file }).load();
  const a = snapshot.tasks.find((t) => t.id === 'A');
  const b = snapshot.tasks.find((t) => t.id === 'B');

  assert.strictEqual(a.status, 'interrupted');
  assert.ok(a.endedAt > 0);
  assert.strictEqual(b.status, 'success');
});

test('load：状态文件损坏时以空历史启动并保留原文件', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ broken json');

  const errors = [];
  const store = new StateStore({ file, onError: (m) => errors.push(m) });
  const snapshot = store.load();

  assert.deepStrictEqual(snapshot.tasks, []);
  assert.match(errors[0], /不是合法 JSON/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ broken json', '损坏文件应原样保留');
});

test('load：状态文件结构不符时不抛错', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '[1,2,3]');
  const errors = [];
  const store = new StateStore({ file, onError: (m) => errors.push(m) });

  assert.deepStrictEqual(store.load().tasks, []);
  assert.match(errors[0], /结构不符/);
});

test('上限：任务历史超过上限时丢弃最旧记录', () => {
  const file = tmpFile();
  const store = new StateStore({ file, historyLimit: 3 });
  store.load();

  for (let i = 1; i <= 5; i += 1) {
    store.recordTask({ id: `T-${i}`, status: 'success' });
  }

  assert.strictEqual(store.data.tasks.length, 3);
  assert.deepStrictEqual(store.data.tasks.map((t) => t.id), ['T-3', 'T-4', 'T-5']);
});

test('上限：日志环形缓冲超过上限时丢弃最旧条目', () => {
  const file = tmpFile();
  const store = new StateStore({ file, logLimit: 2 });
  store.load();

  for (let i = 1; i <= 4; i += 1) {
    store.recordLog({ message: `log-${i}` });
  }

  assert.deepStrictEqual(store.data.logs.map((l) => l.message), ['log-3', 'log-4']);
});

test('save：写盘失败时只上报，不向调用方抛出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-state-'));
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'x');

  const errors = [];
  const store = new StateStore({ file: path.join(blocker, 'state.json'), onError: (m) => errors.push(m) });
  store.load();

  assert.doesNotThrow(() => store.recordTask({ id: 'X', status: 'success' }));
  assert.match(errors[0], /状态写盘失败/);
});

test('体积：状态文件不随对话文本长度增长', () => {
  const file = tmpFile();
  const store = new StateStore({ file });
  store.load();

  // 任务记录只保存会话路径，不保存对话正文
  store.recordTask({
    id: 'CS-1',
    source: 'youtrack',
    status: 'success',
    sessionFile: '/sessions/abc.jsonl',
    durationMs: 1000,
  });

  const sizeSmall = fs.statSync(file).size;

  const longFile = tmpFile();
  const longStore = new StateStore({ file: longFile });
  longStore.load();
  longStore.recordTask({
    id: 'CS-1',
    source: 'youtrack',
    status: 'success',
    sessionFile: '/sessions/abc.jsonl',
    durationMs: 1000,
    conversation: 'x'.repeat(200000),
  });
  const sizeBig = fs.statSync(longFile).size;

  assert.strictEqual(sizeBig, sizeSmall, '额外的对话字段不应被写入状态文件');
});

test('setMeta：写入的元数据能跨实例读回', () => {
  const file = tmpFile();
  const store = new StateStore({ file });
  store.load();
  store.setMeta({ round: 12, state: 'stopped' });

  const snapshot = new StateStore({ file }).load();
  assert.strictEqual(snapshot.meta.round, 12);
  assert.strictEqual(snapshot.meta.state, 'stopped');
});

test('自动创建状态文件所在目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-state-'));
  const file = path.join(dir, 'deep', 'nested', 'state.json');
  const store = new StateStore({ file });
  store.load();
  store.recordTask({ id: 'A', status: 'success' });

  assert.ok(fs.existsSync(file));
});
