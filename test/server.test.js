const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp, listen, BIND_HOST, DEFAULT_PORT } = require('../src/server.js');
const { describeOptions } = require('../src/routes.js');
const { SOURCE_KEYS } = require('../src/sources.js');
const { THINKING_LEVELS } = require('../src/config.js');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskloop-server-'));
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'templates', 'analyze.md'), 'body');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    intervalSeconds: 60,
    rules: [{ source: 'youtrack', labels: ['ready'], promptTemplate: 'templates/analyze.md' }],
  }, null, 2));
  return { dir, configPath };
}

/** 起一个真实端口 0 的服务，返回基地址与关闭函数 */
async function startServer(overrides = {}) {
  const { dir, configPath } = makeWorkspace();
  const app = createApp({ configPath, ...overrides });
  const address = await listen(app.server, 0);

  return {
    dir,
    configPath,
    app,
    base: `http://${BIND_HOST}:${address.port}`,
    async close() {
      app.events.closeAll();
      const done = new Promise((resolve) => app.server.close(resolve));
      // fetch 的 keep-alive 与 SSE 长连接会让 close 一直等待，必须主动断开
      app.server.closeAllConnections?.();
      await done;
    },
  };
}

async function req(base, method, pathname, body) {
  const url = new URL(pathname, base);
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

test('服务只监听回环地址', async () => {
  const srv = await startServer();
  const address = srv.app.server.address();

  assert.strictEqual(address.address, BIND_HOST);
  assert.notStrictEqual(address.address, '0.0.0.0');
  await srv.close();
});

test('默认端口是 4789', () => {
  assert.strictEqual(DEFAULT_PORT, 4789);
});

test('端口被占用时给出明确中文错误', async () => {
  const blocker = http.createServer(() => {});
  await new Promise((resolve) => blocker.listen(0, BIND_HOST, resolve));
  const { port } = blocker.address();

  // 用一个尚未监听的 server 去抢端口，才能触发 EADDRINUSE
  const bare = http.createServer(() => {});
  await assert.rejects(() => listen(bare, port), /已被占用/);

  await new Promise((resolve) => blocker.close(resolve));
});

test('GET /api/state：停止状态返回 stopped 且无唤醒时间', async () => {
  const srv = await startServer();
  const res = await req(srv.base, 'GET', '/api/state');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.state, 'stopped');
  assert.strictEqual(res.json.nextWakeAt, null);
  await srv.close();
});

test('GET /api/state：运行中返回轮次与唤醒时间', async () => {
  let releaseRound;
  const srv = await startServer({
    worker: undefined,
  });
  await srv.close();

  // 用一个可控的 worker 覆盖默认实现
  const { dir, configPath } = makeWorkspace();
  const { Worker } = require('../src/worker.js');
  const worker = new Worker({
    configPath,
    output: null,
    loadConfig: () => ({
      intervalSeconds: 30,
      workdir: dir,
      sessionDir: dir,
      rules: [{ source: 'youtrack', labels: ['ready'], notLabels: [], promptTemplate: 'x.md' }],
    }),
    loadEnv: () => ({}),
    resolveEnv: () => ({ urls: { youtrack: 'http://yt' }, tokens: {} }),
    createHttpClient: () => (async () => null),
    sources: { youtrack: { fetchTasks: async () => [] } },
    renderTemplate: () => '',
    runTask: async () => ({ status: 'success', text: '' }),
    filterTasks: (l) => l,
  });

  const app = createApp({ configPath, worker });
  const address = await listen(app.server, 0);
  const base = `http://${BIND_HOST}:${address.port}`;

  await req(base, 'POST', '/api/start');
  await new Promise((r) => setTimeout(r, 50));

  const res = await req(base, 'GET', '/api/state');
  assert.strictEqual(res.json.state, 'running');
  assert.strictEqual(res.json.round, 1);
  assert.ok(res.json.nextWakeAt > Date.now());
  assert.strictEqual(res.json.rules.length, 1);

  await req(base, 'POST', '/api/stop');
  app.events.closeAll();
  await new Promise((r) => app.server.close(r));
  releaseRound?.();
});

test('GET /api/events：响应头为事件流并收到一条状态事件', async () => {
  const srv = await startServer();

  const controller = new AbortController();
  const res = await fetch(`${srv.base}/api/events`, { signal: controller.signal });
  assert.strictEqual(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const reader = res.body.getReader();
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);

  assert.match(chunk, /event: state/);
  assert.match(chunk, /"state":"stopped"/);

  controller.abort();
  await srv.close();
});

test('POST /api/start、/api/stop、/api/wake 在不可用状态下返回 409', async () => {
  const srv = await startServer();

  // 停止状态下 wake 不可用
  const wake = await req(srv.base, 'POST', '/api/wake');
  assert.strictEqual(wake.status, 409);
  assert.match(wake.json.error, /循环未运行/);

  // 停止状态下 stop 是幂等的，不报错
  const stop = await req(srv.base, 'POST', '/api/stop');
  assert.strictEqual(stop.status, 200);
  assert.strictEqual(stop.json.state.state, 'stopped');

  await srv.close();
});

test('POST /api/start：配置有误时返回 409 与中文错误', async () => {
  const { dir, configPath } = makeWorkspace();
  fs.writeFileSync(configPath, JSON.stringify({
    intervalSeconds: 0,
    rules: [{ source: 'youtrack', labels: ['ready'], promptTemplate: 'templates/analyze.md' }],
  }));
  const app = createApp({ configPath });
  const address = await listen(app.server, 0);
  const base = `http://${BIND_HOST}:${address.port}`;

  const res = await req(base, 'POST', '/api/start');
  assert.strictEqual(res.status, 409);
  assert.match(res.json.error, /intervalSeconds 必须是正整数/);

  app.events.closeAll();
  await new Promise((r) => app.server.close(r));
});

test('GET /api/config：返回原始配置与表单选项', async () => {
  const srv = await startServer();
  fs.writeFileSync(srv.configPath, JSON.stringify({
    intervalSeconds: 45,
    workdir: './w',
    unknownField: 'keep me',
    rules: [{ source: 'youtrack', labels: ['ready'], promptTemplate: 'templates/analyze.md' }],
  }, null, 2));

  const res = await req(srv.base, 'GET', '/api/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.config.intervalSeconds, 45);
  assert.strictEqual(res.json.config.workdir, './w', '应返回原始相对路径');
  assert.strictEqual(res.json.config.unknownField, 'keep me');
  assert.deepStrictEqual(res.json.options.sources, SOURCE_KEYS);
  assert.deepStrictEqual(res.json.options.thinkingLevels, THINKING_LEVELS);
  assert.ok(res.json.options.templates.includes('templates/analyze.md'));
  await srv.close();
});

test('PUT /api/config：保存后原始相对路径与未知字段不被改写', async () => {
  const srv = await startServer();
  const original = {
    intervalSeconds: 45,
    workdir: './w',
    unknownField: 'keep me',
    rules: [{ source: 'youtrack', labels: ['ready'], promptTemplate: 'templates/analyze.md' }],
  };
  fs.writeFileSync(srv.configPath, JSON.stringify(original, null, 2));

  const updated = { ...original, intervalSeconds: 90 };
  const res = await req(srv.base, 'PUT', '/api/config', updated);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.ok, true);

  const written = JSON.parse(fs.readFileSync(srv.configPath, 'utf8'));
  assert.strictEqual(written.intervalSeconds, 90);
  assert.strictEqual(written.workdir, './w', '相对路径不应被固化为绝对路径');
  assert.strictEqual(written.unknownField, 'keep me', '未知字段应被保留');
  await srv.close();
});

test('PUT /api/config：校验失败时不写文件', async () => {
  const srv = await startServer();
  const before = fs.readFileSync(srv.configPath, 'utf8');

  const res = await req(srv.base, 'PUT', '/api/config', { intervalSeconds: -5, rules: [] });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /intervalSeconds/);
  assert.strictEqual(fs.readFileSync(srv.configPath, 'utf8'), before, '文件不应被修改');
  await srv.close();
});

test('PUT /api/config：遗留 agent 字段被拒绝', async () => {
  const srv = await startServer();
  const res = await req(srv.base, 'PUT', '/api/config', {
    agent: 'pi',
    rules: [{ source: 'youtrack', labels: ['ready'], promptTemplate: 'templates/analyze.md' }],
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /"agent" 字段已移除/);
  await srv.close();
});

test('未知路径返回 404 JSON', async () => {
  const srv = await startServer();
  const res = await req(srv.base, 'GET', '/nope');
  assert.strictEqual(res.status, 404);
  assert.match(res.json.error, /未知路径/);
  await srv.close();
});

test('describeOptions：来源选项来自注册表，新增来源无需改这里', () => {
  const options = describeOptions(process.cwd());
  assert.deepStrictEqual(options.sources, SOURCE_KEYS);
  for (const name of SOURCE_KEYS) {
    assert.ok(options.sourceMeta[name].tokenEnv, `${name} 应声明 tokenEnv`);
  }
});
