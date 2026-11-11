const test = require('node:test');
const assert = require('node:assert');
const { Worker, STATE, resolveEnv } = require('../src/worker.js');

async function waitFor(predicate, timeoutMs = 2000, label = '条件') {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待${label}超时`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function baseConfig(patch = {}) {
  return {
    intervalSeconds: 60,
    model: 'p/m',
    thinking: 'high',
    workdir: '/work',
    sessionDir: '/sessions',
    rules: [
      { source: 'youtrack', labels: ['ready'], notLabels: [], assignee: 'me', promptTemplate: '/tpl.md' },
    ],
    ...patch,
  };
}

function makeTask(id) {
  return { id, idReadable: id, title: id, url: `http://yt/${id}`, labels: ['ready'] };
}

/** 构造一个所有外部依赖都被替身的 Worker */
function makeWorker(options = {}) {
  const calls = { runTask: [], fetch: [], events: [] };
  const tasksByCall = options.tasksByCall ?? (() => [makeTask('CS-1')]);

  const worker = new Worker({
    configPath: '/cfg.json',
    cwd: '/work',
    output: null,
    loadConfig: () => options.config ?? baseConfig(),
    loadEnv: () => ({}),
    resolveEnv: () => ({ urls: { youtrack: 'http://yt', wiki: 'http://w', jira: 'http://j', scrum: 'http://s' }, tokens: {} }),
    createHttpClient: () => (async () => null),
    sources: options.sources ?? {
      youtrack: {
        fetchTasks: async () => {
          calls.fetch.push('youtrack');
          return tasksByCall('youtrack');
        },
      },
      wiki: { fetchTasks: async () => { calls.fetch.push('wiki'); return []; } },
      jira: { fetchTasks: async () => { calls.fetch.push('jira'); return []; } },
      scrum: { fetchTasks: async () => { calls.fetch.push('scrum'); return []; } },
    },
    renderTemplate: options.renderTemplate ?? (() => 'prompt body'),
    runTask: options.runTask ?? (async (prompt, opts) => {
      calls.runTask.push({ prompt, opts });
      return { status: 'success', text: 'ok' };
    }),
    filterTasks: options.filterTasks ?? ((list) => list),
  });

  worker.on('event', (event) => calls.events.push(event));
  return { worker, calls };
}

test('start：加载配置后立即执行第一轮，轮次为 1', async () => {
  const { worker } = makeWorker();
  await worker.start();
  await waitFor(() => worker.lastRun !== null, 2000, '第一轮结束');

  assert.strictEqual(worker.state, STATE.RUNNING);
  assert.strictEqual(worker.round, 1);
  assert.strictEqual(worker.lastRun.round, 1);
  await worker.stop();
});

test('start：重复启动时报错', async () => {
  const { worker } = makeWorker();
  await worker.start();
  await assert.rejects(() => worker.start(), /循环已在运行/);
  await worker.stop();
});

test('start：配置或 token 有误时抛出且不进入运行状态', async () => {
  const { worker } = makeWorker({
    config: null,
  });
  worker.deps.loadConfig = () => { throw new Error('intervalSeconds 必须是正整数'); };

  await assert.rejects(() => worker.start(), /intervalSeconds 必须是正整数/);
  assert.strictEqual(worker.state, STATE.STOPPED);
});

test('启动后按间隔重复执行轮次', async () => {
  const { worker } = makeWorker({ config: baseConfig({ intervalSeconds: 0.05 }) });
  await worker.start();
  await waitFor(() => worker.round >= 3, 3000, '到达第 3 轮');

  assert.ok(worker.round >= 3);
  await worker.stop();
});

test('wake：等待期间立即开始下一轮', async () => {
  const { worker } = makeWorker({ config: baseConfig({ intervalSeconds: 30 }) });
  await worker.start();
  await waitFor(() => worker.lastRun !== null, 2000, '第一轮结束');
  await waitFor(() => worker.nextWakeAt !== null, 500, '进入等待');

  const before = worker.round;
  worker.wake();
  await waitFor(() => worker.round === before + 1, 2000, '第二轮开始');

  assert.strictEqual(worker.round, before + 1);
  await worker.stop();
});

test('wake：停止状态下调用抛错', async () => {
  const { worker } = makeWorker();
  assert.throws(() => worker.wake(), /循环未运行/);
});

test('stop：停止后不再开始新轮次', async () => {
  const { worker } = makeWorker({ config: baseConfig({ intervalSeconds: 0.05 }) });
  await worker.start();
  await waitFor(() => worker.round >= 1, 2000, '第一轮');

  await worker.stop();
  const roundAtStop = worker.round;
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.strictEqual(worker.state, STATE.STOPPED);
  assert.strictEqual(worker.round, roundAtStop, '停止后轮次不应增加');
  assert.strictEqual(worker.nextWakeAt, null);
});

test('stop：仅在等待时停止，不产生已中止记录', async () => {
  const { worker } = makeWorker({
    tasksByCall: () => [],
  });
  await worker.start();
  await waitFor(() => worker.lastRun !== null, 2000, '第一轮结束');

  await worker.stop();
  assert.strictEqual(worker.state, STATE.STOPPED);
  assert.strictEqual(worker.lastRun.tasks.length, 0);
});

test('stop：有任务在跑时中止当前任务，并经过 stopping 中间态', async () => {
  let releaseTask;
  const taskGate = new Promise((resolve) => { releaseTask = resolve; });

  const { worker, calls } = makeWorker({
    runTask: async (prompt, opts) => {
      calls.runTask.push({ prompt, opts });
      // 模拟协作式中止：signal 触发后返回 aborted
      await new Promise((resolve) => {
        opts.signal.addEventListener('abort', resolve, { once: true });
        taskGate.then(resolve);
      });
      return { status: opts.signal.aborted ? 'aborted' : 'success', text: '' };
    },
  });

  await worker.start();
  await waitFor(() => worker.currentTask !== null, 2000, '任务开始');

  const stopping = worker.stop();
  assert.strictEqual(worker.state, STATE.STOPPING, '应立即进入 stopping');

  releaseTask();
  await stopping;

  assert.strictEqual(worker.state, STATE.STOPPED);
  const recorded = worker.lastRun.tasks.find((t) => t.id === 'CS-1');
  assert.ok(recorded, '中止的任务应保留记录');
  assert.strictEqual(recorded.status, 'aborted');
});

test('runCycle：同一轮内多条规则命中同一任务只执行一次', async () => {
  const { worker, calls } = makeWorker({
    config: baseConfig({
      rules: [
        { source: 'youtrack', labels: ['ready'], notLabels: [], promptTemplate: '/a.md' },
        { source: 'wiki', labels: ['ready'], notLabels: [], promptTemplate: '/b.md' },
      ],
    }),
    sources: {
      youtrack: { fetchTasks: async () => [makeTask('DUP-1')] },
      wiki: { fetchTasks: async () => [makeTask('DUP-1')] },
      jira: { fetchTasks: async () => [] },
      scrum: { fetchTasks: async () => [] },
    },
  });

  await worker.start();
  await waitFor(() => worker.lastRun !== null, 2000, '第一轮结束');

  assert.strictEqual(calls.runTask.length, 1);
  await worker.stop();
});

test('runCycle：单条规则抓取失败不影响其他规则', async () => {
  const { worker, calls } = makeWorker({
    config: baseConfig({
      rules: [
        { source: 'youtrack', labels: ['bad'], notLabels: [], promptTemplate: '/a.md' },
        { source: 'jira', labels: ['good'], notLabels: [], promptTemplate: '/b.md' },
      ],
    }),
    sources: {
      youtrack: { fetchTasks: async () => { throw new Error('认证失败，请检查 SUPERMAP_YOUTRACK_TOKEN'); } },
      wiki: { fetchTasks: async () => [] },
      jira: { fetchTasks: async () => [makeTask('JIRA-1')] },
      scrum: { fetchTasks: async () => [] },
    },
  });

  await worker.start();
  await waitFor(() => worker.lastRun !== null, 2000, '第一轮结束');

  assert.strictEqual(calls.runTask.length, 1, '第二条规则仍应执行');
  assert.match(worker.ruleStatus[0].error, /认证失败/);
  assert.strictEqual(worker.ruleStatus[1].error, null);
  await worker.stop();
});

test('runCycle：模板渲染失败时跳过该任务并继续', async () => {
  const { worker, calls } = makeWorker({
    tasksByCall: () => [makeTask('A-1'), makeTask('A-2')],
    renderTemplate: (tpl) => {
      if (tpl === '/bad.md') throw new Error('模板读取失败');
      return 'body';
    },
    config: baseConfig({
      rules: [{ source: 'youtrack', labels: ['ready'], notLabels: [], promptTemplate: '/bad.md' }],
    }),
  });

  await worker.start();
  await waitFor(() => worker.lastRun !== null, 2000, '第一轮结束');

  assert.strictEqual(calls.runTask.length, 0, '渲染失败的任务都不应执行');
  assert.strictEqual(worker.lastRun.tasks.length, 2);
  assert.ok(worker.lastRun.tasks.every((t) => t.status === 'failed'));
  await worker.stop();
});

test('runCycle：模型与推理强度透传给执行层，工作目录取 workdir', async () => {
  const { worker, calls } = makeWorker();
  await worker.start();
  await waitFor(() => calls.runTask.length === 1, 2000, '任务执行');

  const { opts } = calls.runTask[0];
  assert.strictEqual(opts.model, 'p/m');
  assert.strictEqual(opts.thinking, 'high');
  assert.strictEqual(opts.cwd, '/work');
  assert.strictEqual(opts.sessionDir, '/sessions');
  assert.ok(opts.signal, '应传入中止信号');
  await worker.stop();
});

test('runCycle：任务执行抛错时记为失败并继续后续任务', async () => {
  let count = 0;
  const { worker } = makeWorker({
    tasksByCall: () => [makeTask('B-1'), makeTask('B-2')],
    runTask: async () => {
      count += 1;
      if (count === 1) throw new Error('会话创建失败');
      return { status: 'success', text: '' };
    },
  });

  await worker.start();
  await waitFor(() => worker.lastRun !== null, 2000, '第一轮结束');

  assert.deepStrictEqual(worker.lastRun.tasks.map((t) => t.status), ['failed', 'success']);
  await worker.stop();
});

test('事件：轮次、规则、任务与状态事件按顺序发出', async () => {
  const { worker, calls } = makeWorker();
  await worker.start();
  await waitFor(() => worker.lastRun !== null, 2000, '第一轮结束');
  await worker.stop();

  const types = calls.events.map((e) => `${e.type}:${e.phase ?? ''}`);
  assert.ok(types.includes('state:'), '应有状态事件');
  assert.ok(types.includes('round:start'));
  assert.ok(types.includes('round:end'));
  assert.ok(types.includes('rule:fetch'), '应有规则抓取事件');
  assert.ok(types.includes('task:start'));
  assert.ok(types.includes('task:end'));
});

test('snapshot：包含运行状态、轮次、下次唤醒与规则进度', async () => {
  const { worker } = makeWorker({ config: baseConfig({ intervalSeconds: 60 }) });
  await worker.start();
  await waitFor(() => worker.nextWakeAt !== null, 2000, '进入等待');

  const snap = worker.snapshot();
  assert.strictEqual(snap.state, STATE.RUNNING);
  assert.strictEqual(snap.round, 1);
  assert.ok(snap.nextWakeAt > Date.now());
  assert.strictEqual(snap.rules.length, 1);
  assert.strictEqual(snap.rules[0].source, 'youtrack');
  await worker.stop();

  const stopped = worker.snapshot();
  assert.strictEqual(stopped.state, STATE.STOPPED);
  assert.strictEqual(stopped.nextWakeAt, null);
});

test('resolveEnv：只对配置中用到的来源要求 token', () => {
  const config = baseConfig({ rules: [{ source: 'wiki', labels: ['a'], notLabels: [], promptTemplate: '/a.md' }] });

  const env = resolveEnv(config, { SUPERMAP_WIKI_TOKEN: 'w', WIKI_URL: 'http://custom' });
  assert.strictEqual(env.tokens.wiki, 'w');
  assert.strictEqual(env.tokens.youtrack, undefined);
  assert.strictEqual(env.urls.wiki, 'http://custom');
  assert.strictEqual(env.urls.youtrack, 'http://yt.ispeco.com:8099');

  assert.throws(() => resolveEnv(config, {}), /未设置 SUPERMAP_WIKI_TOKEN/);
});

test('状态集成：任务执行过程与结果写入 stateStore，snapshot 带出历史', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { StateStore } = require('../src/state.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-worker-state-'));
  const store = new StateStore({ file: path.join(dir, 'state.json') });
  store.load();

  const calls = [];
  const worker = new Worker({
    configPath: '/cfg.json',
    output: null,
    stateStore: store,
    loadConfig: () => baseConfig(),
    loadEnv: () => ({}),
    resolveEnv: () => ({ urls: { youtrack: 'http://yt' }, tokens: {} }),
    createHttpClient: () => (async () => null),
    sources: { youtrack: { fetchTasks: async () => [makeTask('S-1')] } },
    renderTemplate: () => 'body',
    runTask: async (prompt, opts) => {
      // 执行中应当已经有一条 running 记录
      calls.push(store.snapshot().tasks[0]?.status);
      return { status: 'success', text: 'ok', sessionFile: '/s/1.jsonl' };
    },
    filterTasks: (list) => list,
  });

  await worker.start();
  await waitFor(() => worker.lastRun !== null, 2000, '第一轮结束');

  assert.strictEqual(calls[0], 'running', '执行开始时应写入 running 记录');
  const history = worker.snapshot().history;
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].id, 'S-1');
  assert.strictEqual(history[0].status, 'success');
  assert.strictEqual(history[0].sessionFile, '/s/1.jsonl');

  // 日志也应落盘
  assert.ok(store.snapshot().logs.length > 0);
  await worker.stop();
});
