const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCycle, sleep } = require('../src/main.js');

function makeFixtureConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
  const templatePath = path.join(dir, 'analyze.md');
  fs.writeFileSync(templatePath, '处理任务 {youtrack_id}', 'utf8');
  return {
    intervalSeconds: 60,
    agent: 'pi',
    agentConfig: { sessionDir: path.join(dir, '.pi-sessions'), path: 'pi' },
    rules: [
      {
        labels: ['readyed'],
        notLabels: ['done'],
        promptTemplate: templatePath,
      },
    ],
  };
}

function makeDeps(overrides = {}) {
  return {
    sources: {
      youtrack: { fetchTasks: async () => [
        { id: '1', idReadable: 'CS-1', labels: ['readyed'] },
        { id: '2', idReadable: 'CS-2', labels: ['readyed', 'done'] },
      ] },
      wiki: { fetchTasks: async () => [] },
    },
    urls: { youtrack: 'http://yt.ispeco.com:8099', wiki: 'https://wiki.ispeco.com' },
    tokens: { youtrack: 't', wiki: 'wt' },
    runAgent: async () => ({ exitCode: 0 }),
    httpClient: null,
    cwd: '.',
    shouldStop: () => false,
    ...overrides,
  };
}

test('runCycle：按规则抓取、过滤、执行', async () => {
  const config = makeFixtureConfig();
  const ran = [];
  const deps = makeDeps({
    runAgent: async (prompt, opts) => {
      ran.push(prompt);
      return { exitCode: 0 };
    },
  });
  await runCycle({ config, deps, round: 1 });
  assert.deepStrictEqual(ran, ['处理任务 CS-1']); // CS-2 含 done 被过滤
});

test('runCycle：模板替换使用 idReadable', async () => {
  const config = makeFixtureConfig();
  let prompt = null;
  const deps = makeDeps({
    runAgent: async (p) => { prompt = p; return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.strictEqual(prompt, '处理任务 CS-1');
});

test('runCycle：同轮多个 rule 抓到同一任务只执行一次', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
  const templatePath = path.join(dir, 'analyze.md');
  fs.writeFileSync(templatePath, '处理 {youtrack_id}', 'utf8');
  const config = {
    intervalSeconds: 60,
    agent: 'pi',
    agentConfig: { sessionDir: dir, path: 'pi' },
    rules: [
      { labels: ['a'], notLabels: [], promptTemplate: templatePath },
      { labels: ['b'], notLabels: [], promptTemplate: templatePath },
    ],
  };
  const ran = [];
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async () => [{ id: '1', idReadable: 'CS-1', labels: ['a', 'b'] }] },
      wiki: { fetchTasks: async () => [] },
    },
    runAgent: async (p) => { ran.push(p); return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.deepStrictEqual(ran, ['处理 CS-1']);
});

test('runCycle：无候选任务时不调用 runAgent', async () => {
  const config = makeFixtureConfig();
  let calls = 0;
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async () => [] },
      wiki: { fetchTasks: async () => [] },
    },
    runAgent: async () => { calls++; return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.strictEqual(calls, 0);
});

test('runCycle：抓取失败记日志并继续其他规则', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
  const templatePath = path.join(dir, 'analyze.md');
  fs.writeFileSync(templatePath, '处理 {youtrack_id}', 'utf8');
  const config = {
    intervalSeconds: 60,
    agent: 'pi',
    agentConfig: { sessionDir: dir, path: 'pi' },
    rules: [
      { labels: ['a'], notLabels: [], promptTemplate: templatePath },
      { labels: ['b'], notLabels: [], promptTemplate: templatePath },
    ],
  };
  const ran = [];
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async (rule) => {
        if (rule.labels[0] === 'a') throw new Error('网络错误: ECONNREFUSED');
        return [{ id: '1', idReadable: 'CS-1', labels: ['b'] }];
      } },
      wiki: { fetchTasks: async () => [] },
    },
    runAgent: async (p) => { ran.push(p); return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.deepStrictEqual(ran, ['处理 CS-1']);
});

test('runCycle：runAgent 非零退出码不中断循环', async () => {
  const config = makeFixtureConfig();
  const ran = [];
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async () => [
        { id: '1', idReadable: 'CS-1', labels: ['readyed'] },
        { id: '2', idReadable: 'CS-2', labels: ['readyed'] },
      ] },
      wiki: { fetchTasks: async () => [] },
    },
    runAgent: async (p) => {
      ran.push(p);
      return { exitCode: p.includes('CS-1') ? 1 : 0 };
    },
  });
  await runCycle({ config, deps, round: 1 });
  assert.deepStrictEqual(ran, ['处理任务 CS-1', '处理任务 CS-2']);
});

test('runCycle：shouldStop 时提前返回', async () => {
  const config = makeFixtureConfig();
  let calls = 0;
  let stopped = false;
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async () => [{ id: '1', idReadable: 'CS-1', labels: ['readyed'] }] },
      wiki: { fetchTasks: async () => [] },
    },
    runAgent: async () => { calls++; stopped = true; return { exitCode: 0 }; },
    shouldStop: () => stopped,
  });
  await runCycle({ config, deps, round: 1 });
  assert.strictEqual(calls, 1); // 第一个任务执行后停止，不再有第二个任务
});

test('runCycle：模板读取失败时跳过该任务继续', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
  const templateA = path.join(dir, 'a.md');
  const templateB = path.join(dir, 'b.md');
  fs.writeFileSync(templateA, '处理A {youtrack_id}', 'utf8');
  fs.writeFileSync(templateB, '处理B {youtrack_id}', 'utf8');
  const config = {
    intervalSeconds: 60,
    agent: 'pi',
    agentConfig: { sessionDir: dir, path: 'pi' },
    rules: [
      { labels: ['a'], notLabels: [], promptTemplate: templateA },
      { labels: ['b'], notLabels: [], promptTemplate: templateB },
    ],
  };
  const ran = [];
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async (rule) => {
        if (rule.labels[0] === 'a') {
          fs.rmSync(templateA); // 模拟模板文件被删除
          return [{ id: '1', idReadable: 'CS-1', labels: ['a'] }];
        }
        return [{ id: '2', idReadable: 'CS-2', labels: ['b'] }];
      } },
      wiki: { fetchTasks: async () => [] },
    },
    runAgent: async (p) => { ran.push(p); return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.deepStrictEqual(ran, ['处理B CS-2']);
});

test('sleep：正常延时后 resolve', async () => {
  const start = Date.now();
  await sleep(50);
  assert.ok(Date.now() - start >= 40);
});

test('sleep：shouldStop 为 true 时提前 resolve', async () => {
  const start = Date.now();
  await sleep(10000, () => true);
  assert.ok(Date.now() - start < 1000);
});

const { resolveEnv } = require('../src/main.js'); // runCycle 已由文件顶部导入

test('runCycle：wiki 规则从注册表取 fetch 并渲染 {wiki_url}', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
  const templatePath = path.join(dir, 'wiki.md');
  fs.writeFileSync(templatePath, '读取页面 {wiki_url}', 'utf8');
  const config = {
    intervalSeconds: 60,
    agent: 'pi',
    agentConfig: { sessionDir: dir, path: 'pi' },
    rules: [
      { source: 'wiki', labels: ['ready'], notLabels: ['explored'], promptTemplate: templatePath },
    ],
  };
  const ran = [];
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async () => { throw new Error('不应调用 youtrack fetch'); } },
      wiki: { fetchTasks: async () => [
        { id: '111', idReadable: '111', title: '页面A', url: 'https://wiki.ispeco.com/pages/viewpage.action?pageId=111', labels: ['ready'] },
      ] },
    },
    runAgent: async (prompt) => { ran.push(prompt); return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.deepStrictEqual(ran, ['读取页面 https://wiki.ispeco.com/pages/viewpage.action?pageId=111']);
});

test('runCycle：youtrack 规则缺省 source 仍走注册表 youtrack', async () => {
  const config = makeFixtureConfig();
  let youtrackCalled = 0;
  let wikiCalled = false;
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async () => { youtrackCalled++; return [{ id: '1', idReadable: 'CS-1', labels: ['readyed'] }]; } },
      wiki: { fetchTasks: async () => { wikiCalled = true; return []; } },
    },
  });
  await runCycle({ config, deps, round: 1 });
  assert.strictEqual(youtrackCalled, 1); // 正面断言：确实分发到了 youtrack
  assert.strictEqual(wikiCalled, false);
});

test('resolveEnv：youtrack token 缺失报错', () => {
  assert.throws(
    () => resolveEnv({ rules: [{ source: 'youtrack' }] }, {}),
    /SUPERMAP_YOUTRACK_TOKEN/
  );
});

test('resolveEnv：wiki 规则缺 wiki token 报错', () => {
  assert.throws(
    () => resolveEnv({ rules: [{ source: 'wiki' }] }, { SUPERMAP_YOUTRACK_TOKEN: 't' }),
    /SUPERMAP_WIKI_TOKEN/
  );
});

test('resolveEnv：只用 wiki 规则时不要求 youtrack token', () => {
  const env = resolveEnv({ rules: [{ source: 'wiki' }] }, { SUPERMAP_WIKI_TOKEN: 'wt' });
  assert.strictEqual(env.tokens.wiki, 'wt');
  assert.strictEqual(env.tokens.youtrack, undefined);
});

test('resolveEnv：无 wiki 规则不要求 wiki token', () => {
  const env = resolveEnv(
    { rules: [{ source: 'youtrack' }] },
    { SUPERMAP_YOUTRACK_TOKEN: 't' }
  );
  assert.strictEqual(env.tokens.wiki, undefined);
});

test('resolveEnv：URL 缺省值来自注册表', () => {
  const env = resolveEnv(
    { rules: [] },
    { SUPERMAP_YOUTRACK_TOKEN: 't', SUPERMAP_WIKI_TOKEN: 'wt' }
  );
  assert.strictEqual(env.urls.youtrack, 'http://yt.ispeco.com:8099');
  assert.strictEqual(env.urls.wiki, 'https://wiki.ispeco.com');
});

test('resolveEnv：urlEnv 环境变量覆盖默认 URL', () => {
  const env = resolveEnv(
    { rules: [] },
    { SUPERMAP_YOUTRACK_TOKEN: 't', SUPERMAP_WIKI_TOKEN: 'wt', YOUTRACK_URL: 'http://custom:9999' }
  );
  assert.strictEqual(env.urls.youtrack, 'http://custom:9999');
  assert.strictEqual(env.urls.wiki, 'https://wiki.ispeco.com');
});

test('runCycle：模板渲染规则级占位符 {labels}/{not_labels}', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
  const templatePath = path.join(dir, 'rule.md');
  fs.writeFileSync(templatePath, '任务须满足 {labels}，完成后打上 {not_labels}', 'utf8');
  const config = {
    intervalSeconds: 60,
    agent: 'pi',
    agentConfig: { sessionDir: dir, path: 'pi' },
    rules: [
      { labels: ['ready', 'explorer'], notLabels: ['explored', 'done'], promptTemplate: templatePath },
    ],
  };
  let prompt = null;
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async () => [
        { id: '1', idReadable: 'CS-1', labels: ['ready', 'explorer'] },
      ] },
      wiki: { fetchTasks: async () => [] },
    },
    runAgent: async (p) => { prompt = p; return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.strictEqual(prompt, '任务须满足 ready, explorer，完成后打上 explored, done');
});

test('runCycle：notLabels 未配置时 {not_labels} 替换为空字符串', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
  const templatePath = path.join(dir, 'rule.md');
  fs.writeFileSync(templatePath, '完成后打上 {not_labels}', 'utf8');
  const config = {
    intervalSeconds: 60,
    agent: 'pi',
    agentConfig: { sessionDir: dir, path: 'pi' },
    rules: [
      { labels: ['ready'], notLabels: [], promptTemplate: templatePath },
    ],
  };
  let prompt = null;
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async () => [
        { id: '1', idReadable: 'CS-1', labels: ['ready'] },
      ] },
      wiki: { fetchTasks: async () => [] },
    },
    runAgent: async (p) => { prompt = p; return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.strictEqual(prompt, '完成后打上 ');
});

test('runCycle：config.agent 与 agentConfig 透传给 runAgent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
  const templatePath = path.join(dir, 'analyze.md');
  fs.writeFileSync(templatePath, '处理 {youtrack_id}', 'utf8');
  const config = {
    intervalSeconds: 60,
    agent: 'pi',
    agentConfig: { sessionDir: dir, path: '/opt/pi' },
    rules: [{ labels: ['a'], notLabels: [], promptTemplate: templatePath }],
  };
  let opts = null;
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async () => [{ id: '1', idReadable: 'CS-1', labels: ['a'] }] },
      wiki: { fetchTasks: async () => [] },
    },
    runAgent: async (p, o) => { opts = o; return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.strictEqual(opts.agent, 'pi');
  assert.strictEqual(opts.agentConfig.path, '/opt/pi');
  assert.strictEqual(opts.agentConfig.sessionDir, dir);
});
