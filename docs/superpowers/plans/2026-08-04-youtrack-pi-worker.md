# YouTrack 任务循环执行器（youtrack-pi-worker）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现常驻 Node 脚本：按 config.json 中的规则定时从 YouTrack 抓取任务（label 过滤），逐个用 `pi -p` 非交互模式执行模板 prompt，Ctrl+C 退出。

**Architecture:** 零依赖 CommonJS 模块：纯函数（filter/template）+ 外部交互（youTrack/piRunner）依赖注入 + main 编排三层循环（while → rules → tasks）。测试用 Node 内置 `node:test`，外部依赖全部 mock。

**Tech Stack:** Node.js ≥ 20（本机 v24.16.0）、内置 `node:test`、`child_process.spawn`、内置 `http/https`。零 npm 依赖。

## Global Constraints

- 代码中不硬编码 labels、notLabels、promptTemplate、循环间隔——全部来自 config.json
- 全部使用 CommonJS（`require`），不使用 ESM
- 外部依赖（HTTP 客户端、spawn、sleep）一律通过参数注入，便于单测 mock
- 环境变量只判断是否设置，绝不输出 token 值
- 每个任务：先写失败测试 → 跑失败 → 实现 → 跑通过 → 提交
- 提交时 `git add` 只加本任务文件，绝不 add 用户文件（comment.md、icloudnative.md、.pi/ 等）
- 提交信息用 conventional 风格（feat:/test:/chore:）
- 测试验证通过后才可声称任务完成

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `test/smoke.test.js`

**Interfaces:**
- Produces: `package.json` 的 `npm test` 脚本（`node --test`），后续所有任务用它跑测试

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "youtrack-pi-worker",
  "private": true,
  "version": "0.1.0",
  "description": "定时从 YouTrack 按 label 抓取任务并通过 pi 非交互模式执行",
  "scripts": {
    "test": "node --test test/"
  }
}
```

- [ ] **Step 2: 创建冒烟测试 `test/smoke.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');

test('test runner works', () => {
  assert.strictEqual(1 + 1, 2);
});
```

- [ ] **Step 3: 运行测试确认 runner 可用**

Run: `cd F:/liuxin/temp/temp && npm test`
Expected: 1 个测试通过，exit 0

- [ ] **Step 4: 提交**

```bash
cd F:/liuxin/temp/temp
git add package.json test/smoke.test.js
git commit -m "chore: 初始化 node 项目与测试框架"
```

---

### Task 2: label 过滤纯函数

**Files:**
- Create: `src/filter.js`
- Test: `test/filter.test.js`

**Interfaces:**
- Produces: `filterTasks(tasks, labels, notLabels) → tasks`
  - `tasks`: `[{ id, idReadable, labels: string[] }]`
  - `labels`: 必须全部拥有（AND）的标签数组
  - `notLabels`: 拥有任一即排除的标签数组
  - 返回满足条件的任务子集（不修改入参）

- [ ] **Step 1: 写失败测试 `test/filter.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { filterTasks } = require('../src/filter.js');

test('AND 语义：缺少任一 label 不入选', () => {
  const tasks = [
    { id: '1', idReadable: 'CS-1', labels: ['readyed', 'clearly'] },
    { id: '2', idReadable: 'CS-2', labels: ['readyed'] },
  ];
  const result = filterTasks(tasks, ['readyed', 'clearly'], []);
  assert.deepStrictEqual(result.map((t) => t.idReadable), ['CS-1']);
});

test('notLabel：含任一排除标签即剔除', () => {
  const tasks = [
    { id: '1', idReadable: 'CS-1', labels: ['readyed', 'clearly'] },
    { id: '2', idReadable: 'CS-2', labels: ['readyed', 'clearly', 'done'] },
  ];
  const result = filterTasks(tasks, ['readyed', 'clearly'], ['done']);
  assert.deepStrictEqual(result.map((t) => t.idReadable), ['CS-1']);
});

test('空任务列表返回空数组', () => {
  assert.deepStrictEqual(filterTasks([], ['a'], []), []);
});

test('标签匹配大小写敏感', () => {
  const tasks = [{ id: '1', idReadable: 'CS-1', labels: ['Readyed'] }];
  assert.deepStrictEqual(filterTasks(tasks, ['readyed'], []), []);
});

test('labels 为空时不因标签排除任务', () => {
  const tasks = [{ id: '1', idReadable: 'CS-1', labels: [] }];
  assert.deepStrictEqual(filterTasks(tasks, [], ['done']), []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../src/filter.js'`

- [ ] **Step 3: 实现 `src/filter.js`**

```js
function filterTasks(tasks, labels, notLabels) {
  return tasks.filter((task) => {
    const taskLabels = new Set(task.labels);
    const hasAll = labels.every((label) => taskLabels.has(label));
    const hasExcluded = notLabels.some((label) => taskLabels.has(label));
    return hasAll && !hasExcluded;
  });
}

module.exports = { filterTasks };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 6 个测试全部 PASS（含 smoke）

- [ ] **Step 5: 提交**

```bash
cd F:/liuxin/temp/temp
git add src/filter.js test/filter.test.js
git commit -m "feat: label 过滤纯函数（AND + notLabel 排除）"
```

---

### Task 3: 模板占位符替换纯函数

**Files:**
- Create: `src/template.js`
- Test: `test/template.test.js`

**Interfaces:**
- Produces: `renderTemplate(content, { youtrackId }) → string`
  - 将所有 `{youtrack_id}` 替换为 `youtrackId`，不修改入参

- [ ] **Step 1: 写失败测试 `test/template.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { renderTemplate } = require('../src/template.js');

test('替换 {youtrack_id} 为 idReadable', () => {
  assert.strictEqual(
    renderTemplate('请处理任务 {youtrack_id}', { youtrackId: 'CS-1234' }),
    '请处理任务 CS-1234'
  );
});

test('多处占位符全部替换', () => {
  assert.strictEqual(
    renderTemplate('{youtrack_id} 和 {youtrack_id}', { youtrackId: 'CS-1' }),
    'CS-1 和 CS-1'
  );
});

test('无占位符时原样返回', () => {
  const content = '没有占位符的文本';
  assert.strictEqual(renderTemplate(content, { youtrackId: 'CS-1' }), content);
});

test('入参内容不被修改', () => {
  const content = '任务 {youtrack_id}';
  renderTemplate(content, { youtrackId: 'CS-1' });
  assert.strictEqual(content, '任务 {youtrack_id}');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../src/template.js'`

- [ ] **Step 3: 实现 `src/template.js`**

```js
function renderTemplate(content, { youtrackId }) {
  return content.replaceAll('{youtrack_id}', youtrackId);
}

module.exports = { renderTemplate };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 10 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
cd F:/liuxin/temp/temp
git add src/template.js test/template.test.js
git commit -m "feat: prompt 模板 {youtrack_id} 占位符替换"
```

---

### Task 4: 配置加载与校验

**Files:**
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig(configPath) → { intervalSeconds, sessionDir, rules }`
  - `intervalSeconds`: 正整数，缺省 60
  - `sessionDir`: 绝对路径；配置了 `sessionDir` 则相对 config.json 目录解析，否则为 config.json 所在目录
  - `rules`: `[{ labels: string[], notLabels: string[], assignee: string|undefined, promptTemplate: 绝对路径 }]`
  - 校验失败抛 `Error`（message 含具体原因）

**Config 格式（Task 8 会创建真实 config.json，此处仅测试 fixture）：**

```json
{
  "intervalSeconds": 60,
  "sessionDir": "./.pi-sessions",
  "rules": [
    {
      "labels": ["readyed", "clearly"],
      "notLabels": ["done"],
      "assignee": "me",
      "promptTemplate": "templates/analyze.md"
    }
  ]
}
```

- [ ] **Step 1: 写失败测试 `test/config.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config.js');

function makeFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  const templatePath = path.join(dir, 'templates', 'analyze.md');
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.writeFileSync(templatePath, '处理 {youtrack_id}', 'utf8');
  const config = {
    intervalSeconds: 60,
    sessionDir: './.pi-sessions',
    rules: [
      {
        labels: ['readyed', 'clearly'],
        notLabels: ['done'],
        assignee: 'me',
        promptTemplate: 'templates/analyze.md',
      },
    ],
    ...overrides,
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  return { dir, configPath, templatePath };
}

test('解析合法配置：路径解析与缺省值', () => {
  const { dir, configPath } = makeFixture();
  const result = loadConfig(configPath);
  assert.strictEqual(result.intervalSeconds, 60);
  assert.strictEqual(result.sessionDir, path.join(dir, '.pi-sessions'));
  assert.strictEqual(result.rules.length, 1);
  assert.deepStrictEqual(result.rules[0].labels, ['readyed', 'clearly']);
  assert.deepStrictEqual(result.rules[0].notLabels, ['done']);
  assert.strictEqual(result.rules[0].assignee, 'me');
  assert.strictEqual(result.rules[0].promptTemplate, path.join(dir, 'templates', 'analyze.md'));
});

test('缺省值：intervalSeconds 缺省 60，sessionDir 缺省 config 所在目录', () => {
  const { dir, configPath } = makeFixture();
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete raw.intervalSeconds;
  delete raw.sessionDir;
  fs.writeFileSync(configPath, JSON.stringify(raw), 'utf8');
  const result = loadConfig(configPath);
  assert.strictEqual(result.intervalSeconds, 60);
  assert.strictEqual(result.sessionDir, dir);
});

test('配置文件不是 JSON 对象时报错', () => {
  const { dir, configPath } = makeFixture();
  fs.writeFileSync(configPath, '[1,2]', 'utf8');
  assert.throws(() => loadConfig(configPath), /JSON 对象/);
});

test('intervalSeconds 非正整数时报错', () => {
  const { configPath } = makeFixture({ intervalSeconds: -1 });
  assert.throws(() => loadConfig(configPath), /intervalSeconds/);
});

test('rules 为空数组时报错', () => {
  const { configPath } = makeFixture({ rules: [] });
  assert.throws(() => loadConfig(configPath), /rules/);
});

test('labels 缺失时报错', () => {
  const { configPath } = makeFixture({
    rules: [{ notLabels: [], promptTemplate: 'templates/analyze.md' }],
  });
  assert.throws(() => loadConfig(configPath), /labels/);
});

test('notLabels 非数组时报错', () => {
  const { configPath } = makeFixture({
    rules: [{ labels: ['a'], notLabels: 'done', promptTemplate: 'templates/analyze.md' }],
  });
  assert.throws(() => loadConfig(configPath), /notLabels/);
});

test('assignee 非字符串时报错', () => {
  const { configPath } = makeFixture({
    rules: [{ labels: ['a'], assignee: 123, promptTemplate: 'templates/analyze.md' }],
  });
  assert.throws(() => loadConfig(configPath), /assignee/);
});

test('promptTemplate 文件不存在时报错', () => {
  const { configPath } = makeFixture({
    rules: [{ labels: ['a'], promptTemplate: 'templates/missing.md' }],
  });
  assert.throws(() => loadConfig(configPath), /文件不存在/);
});

test('notLabels 缺省为空数组', () => {
  const { configPath } = makeFixture({
    rules: [{ labels: ['a'], promptTemplate: 'templates/analyze.md' }],
  });
  const result = loadConfig(configPath);
  assert.deepStrictEqual(result.rules[0].notLabels, []);
  assert.strictEqual(result.rules[0].assignee, undefined);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../src/config.js'`

- [ ] **Step 3: 实现 `src/config.js`**

```js
const fs = require('node:fs');
const path = require('node:path');

function loadConfig(configPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`无法读取配置文件 ${configPath}: ${err.message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('配置文件必须是 JSON 对象');
  }
  const intervalSeconds = raw.intervalSeconds ?? 60;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error('intervalSeconds 必须是正整数');
  }
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new Error('rules 必须是非空数组');
  }
  const configDir = path.dirname(path.resolve(configPath));
  const sessionDir = raw.sessionDir
    ? path.resolve(configDir, raw.sessionDir)
    : configDir;
  const rules = raw.rules.map((rule, i) => {
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new Error(`rules[${i}] 必须是对象`);
    }
    if (!Array.isArray(rule.labels) || rule.labels.length === 0 ||
        rule.labels.some((l) => typeof l !== 'string' || l.length === 0)) {
      throw new Error(`rules[${i}].labels 必须是非空字符串数组`);
    }
    if (rule.notLabels !== undefined &&
        (!Array.isArray(rule.notLabels) ||
         rule.notLabels.some((l) => typeof l !== 'string' || l.length === 0))) {
      throw new Error(`rules[${i}].notLabels 必须是字符串数组`);
    }
    if (rule.assignee !== undefined &&
        (typeof rule.assignee !== 'string' || rule.assignee.length === 0)) {
      throw new Error(`rules[${i}].assignee 必须是非空字符串`);
    }
    if (typeof rule.promptTemplate !== 'string' || rule.promptTemplate.length === 0) {
      throw new Error(`rules[${i}].promptTemplate 必须是非空字符串`);
    }
    const templatePath = path.resolve(configDir, rule.promptTemplate);
    if (!fs.existsSync(templatePath)) {
      throw new Error(`rules[${i}].promptTemplate 文件不存在: ${templatePath}`);
    }
    return {
      labels: rule.labels,
      notLabels: rule.notLabels ?? [],
      assignee: rule.assignee,
      promptTemplate: templatePath,
    };
  });
  return { intervalSeconds, sessionDir, rules };
}

module.exports = { loadConfig };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 20 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
cd F:/liuxin/temp/temp
git add src/config.js test/config.test.js
git commit -m "feat: 配置加载与校验"
```

---

### Task 5: YouTrack 任务抓取

**Files:**
- Create: `src/youTrack.js`
- Test: `test/youTrack.test.js`

**Interfaces:**
- Produces:
  - `buildQuery(rule) → string`：`#a #b assignee: me` 形式（assignee 为 `me` 时输出 `assignee: me`，否则 `assignee: {login}`）
  - `createHttpClient() → (url: URL, { token }) → Promise<Array>`：node http/https GET 实现，401 抛"认证失败"错误，网络错误抛"网络错误"，超时抛"请求超时"，默认 30s
  - `fetchTasks(rule, { httpClient, url, token }) → Promise<[{ id, idReadable, labels }]>`：`httpClient` 缺省 `createHttpClient()`；`url` 为 base URL 字符串；构造 `/api/issues` 请求（`$top=-1`、`fields=id,idReadable,tags(id,name)`、`query=buildQuery(rule)`）；响应映射为 `{ id, idReadable, labels }`（`labels` 取 `tags[].name`，无 tags 为空数组）

- [ ] **Step 1: 写失败测试 `test/youTrack.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { buildQuery, createHttpClient, fetchTasks } = require('../src/youTrack.js');

test('buildQuery：多个 labels 生成 hashtag 查询', () => {
  assert.strictEqual(buildQuery({ labels: ['readyed', 'clearly'] }),
    '#readyed #clearly');
});

test('buildQuery：assignee 为 me', () => {
  assert.strictEqual(
    buildQuery({ labels: ['readyed'], assignee: 'me' }),
    '#readyed assignee: me'
  );
});

test('buildQuery：assignee 为 login', () => {
  assert.strictEqual(
    buildQuery({ labels: ['readyed'], assignee: 'liuxin' }),
    '#readyed assignee: {liuxin}'
  );
});

test('buildQuery：无 assignee', () => {
  assert.strictEqual(buildQuery({ labels: ['readyed'] }), '#readyed');
});

test('fetchTasks：请求 URL 与返回结构映射', async () => {
  const calls = [];
  const httpClient = async (url) => {
    calls.push(url);
    return [
      { id: '1-1', idReadable: 'CS-5599', tags: [{ name: 'readyed' }, { name: 'clearly' }] },
      { id: '1-2', idReadable: 'CS-5601', tags: [] },
    ];
  };
  const result = await fetchTasks(
    { labels: ['readyed'], assignee: 'me' },
    { httpClient, url: 'http://yt.ispeco.com:8099', token: 't' }
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].pathname, '/api/issues');
  assert.strictEqual(calls[0].searchParams.get('query'), '#readyed assignee: me');
  assert.strictEqual(calls[0].searchParams.get('fields'), 'id,idReadable,tags(id,name)');
  assert.strictEqual(calls[0].searchParams.get('$top'), '-1');
  assert.deepStrictEqual(result, [
    { id: '1-1', idReadable: 'CS-5599', labels: ['readyed', 'clearly'] },
    { id: '1-2', idReadable: 'CS-5601', labels: [] },
  ]);
});

test('fetchTasks：无 tags 时 labels 为空数组', async () => {
  const httpClient = async () => [{ id: '1', idReadable: 'CS-1' }];
  const result = await fetchTasks(
    { labels: ['a'] },
    { httpClient, url: 'http://yt.ispeco.com:8099', token: 't' }
  );
  assert.deepStrictEqual(result, [{ id: '1', idReadable: 'CS-1', labels: [] }]);
});

test('fetchTasks：httpClient 抛 401 认证错误', async () => {
  const httpClient = async () => { throw new Error('认证失败，请检查 SUPERMAP_YOUTRACK_TOKEN'); };
  await assert.rejects(
    fetchTasks({ labels: ['a'] }, { httpClient, url: 'http://yt.ispeco.com:8099', token: 't' }),
    /认证失败/
  );
});

test('fetchTasks：网络错误向上传播', async () => {
  const httpClient = async () => { throw new Error('网络错误: ECONNREFUSED'); };
  await assert.rejects(
    fetchTasks({ labels: ['a'] }, { httpClient, url: 'http://yt.ispeco.com:8099', token: 't' }),
    /网络错误/
  );
});

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

test('createHttpClient：200 返回 JSON', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[{"id":"1"}]');
  });
  try {
    const client = createHttpClient();
    const url = new URL(`http://127.0.0.1:${server.address().port}/api/issues`);
    const data = await client(url, { token: 't' });
    assert.deepStrictEqual(data, [{ id: '1' }]);
  } finally {
    await closeServer(server);
  }
});

test('createHttpClient：401 抛认证失败', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(401);
    res.end();
  });
  try {
    const client = createHttpClient();
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(client(url, { token: 't' }), /认证失败/);
  } finally {
    await closeServer(server);
  }
});

test('createHttpClient：非 2xx 抛 HTTP 状态错误', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(500);
    res.end();
  });
  try {
    const client = createHttpClient();
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(client(url, { token: 't' }), /HTTP 500/);
  } finally {
    await closeServer(server);
  }
});

test('createHttpClient：超时抛请求超时', async () => {
  const server = await startServer((req, res) => {
    const timer = setTimeout(() => res.end(), 1000);
    res.on('close', () => clearTimeout(timer));
  });
  try {
    const client = createHttpClient();
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(client(url, { token: 't', timeoutMs: 200 }), /请求超时/);
  } finally {
    await closeServer(server);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../src/youTrack.js'`

- [ ] **Step 3: 实现 `src/youTrack.js`**

```js
const http = require('node:http');
const https = require('node:https');

function buildQuery(rule) {
  const parts = rule.labels.map((label) => `#${label}`);
  if (rule.assignee) {
    parts.push(rule.assignee === 'me' ? 'assignee: me' : `assignee: {${rule.assignee}}`);
  }
  return parts.join(' ');
}

function createHttpClient() {
  return (url, { token, timeoutMs = 30000 }) =>
    new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'User-Agent': 'youtrack-pi-worker/1.0',
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (err) {
                reject(new Error(`响应解析失败: ${err.message}`));
              }
            } else if (res.statusCode === 401) {
              reject(new Error('认证失败，请检查 SUPERMAP_YOUTRACK_TOKEN'));
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
        }
      );
      req.on('error', (err) => reject(new Error(`网络错误: ${err.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });
      req.end();
    });
}

async function fetchTasks(rule, { httpClient = createHttpClient(), url, token }) {
  const apiUrl = new URL('/api/issues', url);
  apiUrl.searchParams.set('$top', '-1');
  apiUrl.searchParams.set('fields', 'id,idReadable,tags(id,name)');
  apiUrl.searchParams.set('query', buildQuery(rule));
  const data = await httpClient(apiUrl, { token });
  return (data || []).map((issue) => ({
    id: issue.id,
    idReadable: issue.idReadable,
    labels: (issue.tags || []).map((tag) => tag.name),
  }));
}

module.exports = { buildQuery, createHttpClient, fetchTasks };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 32 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
cd F:/liuxin/temp/temp
git add src/youTrack.js test/youTrack.test.js
git commit -m "feat: YouTrack 任务抓取（tag/assignee 查询）"
```

---

### Task 6: pi 执行器

**Files:**
- Create: `src/piRunner.js`
- Test: `test/piRunner.test.js`

**Interfaces:**
- Produces: `runPi(prompt, { cwd, piPath = 'pi', sessionDir, spawnFn = spawn, onChild }) → Promise<{ exitCode }>`
  - prompt 写入 `os.tmpdir()` 临时文件（文件名前缀 `pi-task-`）
  - `spawnFn(piPath, ['-p', '@' + tmpFile, '--session-dir', sessionDir], { cwd, stdio: 'inherit' })`
  - spawn 事件 `error` → reject；`exit` → resolve `{ exitCode: code ?? 1 }`
  - `onChild`（可选）回调接收 child 对象，供 main 在 SIGINT 时 kill
  - 执行完毕（含异常）后 `finally` 中同步删除临时文件
  - Windows（`process.platform === 'win32'`）下 spawn 加 `shell: true`，且临时文件路径参数用双引号包裹（`"@path"`、`"sessionDir"`），因为 `pi` 在 Windows 上是 .cmd 包装脚本，必须经 shell 启动

**实现细节（Windows shell 引号处理）：** args 构造为：

```js
const args = process.platform === 'win32'
  ? ['-p', `"@${tmpFile}"`, '--session-dir', `"${sessionDir}"`]
  : ['-p', `@${tmpFile}`, '--session-dir', sessionDir];
```

- [ ] **Step 1: 写失败测试 `test/piRunner.test.js`**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../src/piRunner.js'`

- [ ] **Step 3: 实现 `src/piRunner.js`**

```js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function runPi(prompt, { cwd, piPath = 'pi', sessionDir, spawnFn = spawn, onChild }) {
  const tmpFile = path.join(
    os.tmpdir(),
    `pi-task-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
  );
  fs.writeFileSync(tmpFile, prompt, 'utf8');
  try {
    const isWin = process.platform === 'win32';
    const args = isWin
      ? ['-p', `"@${tmpFile}"`, '--session-dir', `"${sessionDir}"`]
      : ['-p', `@${tmpFile}`, '--session-dir', sessionDir];
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawnFn(piPath, args, {
        cwd,
        stdio: 'inherit',
        ...(isWin ? { shell: true } : {}),
      });
      onChild?.(child);
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
    return { exitCode };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

module.exports = { runPi };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 37 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
cd F:/liuxin/temp/temp
git add src/piRunner.js test/piRunner.test.js
git commit -m "feat: pi 非交互执行器（临时文件 + --session-dir）"
```

---

### Task 7: 主循环核心（runCycle）

**Files:**
- Create: `src/main.js`（本任务只实现 runCycle/sleep/log/timestamp 并导出；main() 入口在 Task 8 补）
- Test: `test/main.test.js`

**Interfaces:**
- Consumes（来自前序任务）:
  - `filterTasks(tasks, labels, notLabels)`（Task 2）
  - `renderTemplate(content, { youtrackId })`（Task 3）
  - `fetchTasks(rule, { httpClient, url, token })`（Task 5）
  - `runPi(prompt, { cwd, piPath, sessionDir, onChild })`（Task 6）
- Produces:
  - `timestamp() → string`：`YYYY-MM-DD HH:mm:ss` 本地时间
  - `log(msg)`：`console.log('[时间戳] msg')`
  - `sleep(ms) → Promise`：可取消（`shouldStop` 返回 true 时提前 resolve，每 200ms 检查一次）
  - `runCycle({ config, deps, round }) → Promise`：一轮完整流程（见下）

**runCycle 行为：**
1. 记 `轮次 N 开始`
2. 每 200ms 检查 `deps.shouldStop?.()`，为 true 则立即返回（在每轮迭代、每任务迭代前检查）
3. 遍历 `config.rules`：抓取（`deps.fetchTasks` 失败记日志并 `continue`）→ `filterTasks` 本地过滤 → 无候选记日志 continue
4. 同轮去重：`Set` 记录已执行 `idReadable`，重复跳过
5. 每任务：读模板文件 → `renderTemplate` 替换 `{youtrack_id}` → 记开始日志 → `deps.runPi`（非零退出码仅记日志，不抛）→ 记完成日志
6. 全部结束后记 `轮次 N 结束，等待 X 秒`

**测试注入约定：** `deps` 形如 `{ fetchTasks, runPi, httpClient, youTrackUrl, token, cwd, piPath, shouldStop, onChild }`；测试传入真实 `filterTasks`/`renderTemplate`（纯函数已测），mock `fetchTasks`/`runPi`。

- [ ] **Step 1: 写失败测试 `test/main.test.js`**

```js
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
    sessionDir: path.join(dir, '.pi-sessions'),
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
    fetchTasks: async () => [
      { id: '1', idReadable: 'CS-1', labels: ['readyed'] },
      { id: '2', idReadable: 'CS-2', labels: ['readyed', 'done'] },
    ],
    runPi: async () => ({ exitCode: 0 }),
    httpClient: null,
    youTrackUrl: 'http://yt.ispeco.com:8099',
    token: 't',
    cwd: '.',
    piPath: 'pi',
    shouldStop: () => false,
    ...overrides,
  };
}

test('runCycle：按规则抓取、过滤、执行', async () => {
  const config = makeFixtureConfig();
  const ran = [];
  const deps = makeDeps({
    runPi: async (prompt, opts) => {
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
    runPi: async (p) => { prompt = p; return { exitCode: 0 }; },
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
    sessionDir: dir,
    rules: [
      { labels: ['a'], notLabels: [], promptTemplate: templatePath },
      { labels: ['b'], notLabels: [], promptTemplate: templatePath },
    ],
  };
  const ran = [];
  const deps = makeDeps({
    fetchTasks: async () => [{ id: '1', idReadable: 'CS-1', labels: ['a', 'b'] }],
    runPi: async (p) => { ran.push(p); return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.deepStrictEqual(ran, ['处理 CS-1']);
});

test('runCycle：无候选任务时不调用 runPi', async () => {
  const config = makeFixtureConfig();
  let calls = 0;
  const deps = makeDeps({
    fetchTasks: async () => [],
    runPi: async () => { calls++; return { exitCode: 0 }; },
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
    sessionDir: dir,
    rules: [
      { labels: ['a'], notLabels: [], promptTemplate: templatePath },
      { labels: ['b'], notLabels: [], promptTemplate: templatePath },
    ],
  };
  const ran = [];
  const deps = makeDeps({
    fetchTasks: async (rule) => {
      if (rule.labels[0] === 'a') throw new Error('网络错误: ECONNREFUSED');
      return [{ id: '1', idReadable: 'CS-1', labels: ['b'] }];
    },
    runPi: async (p) => { ran.push(p); return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.deepStrictEqual(ran, ['处理 CS-1']);
});

test('runCycle：runPi 非零退出码不中断循环', async () => {
  const config = makeFixtureConfig();
  const ran = [];
  const deps = makeDeps({
    fetchTasks: async () => [
      { id: '1', idReadable: 'CS-1', labels: ['readyed'] },
      { id: '2', idReadable: 'CS-2', labels: ['readyed'] },
    ],
    runPi: async (p) => {
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
    fetchTasks: async () => [{ id: '1', idReadable: 'CS-1', labels: ['readyed'] }],
    runPi: async () => { calls++; stopped = true; return { exitCode: 0 }; },
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
    sessionDir: dir,
    rules: [
      { labels: ['a'], notLabels: [], promptTemplate: templateA },
      { labels: ['b'], notLabels: [], promptTemplate: templateB },
    ],
  };
  const ran = [];
  const deps = makeDeps({
    fetchTasks: async (rule) => {
      if (rule.labels[0] === 'a') {
        fs.rmSync(templateA); // 模拟模板文件被删除
        return [{ id: '1', idReadable: 'CS-1', labels: ['a'] }];
      }
      return [{ id: '2', idReadable: 'CS-2', labels: ['b'] }];
    },
    runPi: async (p) => { ran.push(p); return { exitCode: 0 }; },
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../src/main.js'`

- [ ] **Step 3: 实现 `src/main.js`（runCycle 部分，main() 在 Task 8 补充）**

```js
const fs = require('node:fs');
const { filterTasks } = require('./filter.js');
const { renderTemplate } = require('./template.js');
const { fetchTasks } = require('./youTrack.js');
const { runPi } = require('./piRunner.js');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function sleep(ms, shouldStop) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, ms);
    const interval = setInterval(() => {
      if (shouldStop?.()) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve();
      }
    }, 200);
    interval.unref?.();
  });
}

async function runCycle({ config, deps, round }) {
  log(`轮次 ${round} 开始`);
  const processed = new Set();
  for (const rule of config.rules) {
    if (deps.shouldStop?.()) return;
    const labelDesc = rule.labels.join(',');
    let tasks;
    try {
      tasks = await deps.fetchTasks(rule, {
        httpClient: deps.httpClient,
        url: deps.youTrackUrl,
        token: deps.token,
      });
    } catch (err) {
      log(`[${labelDesc}] 抓取失败: ${err.message}`);
      continue;
    }
    const candidates = filterTasks(tasks, rule.labels, rule.notLabels);
    if (candidates.length === 0) {
      log(`[${labelDesc}] 无候选任务`);
      continue;
    }
    log(`[${labelDesc}] 抓取到 ${candidates.length} 个候选任务`);
    for (const task of candidates) {
      if (deps.shouldStop?.()) return;
      if (processed.has(task.idReadable)) continue;
      processed.add(task.idReadable);
      let template;
      try {
        template = fs.readFileSync(rule.promptTemplate, 'utf8');
      } catch (err) {
        log(`[${task.idReadable}] 模板读取失败: ${err.message}`);
        continue;
      }
      const prompt = renderTemplate(template, { youtrackId: task.idReadable });
      log(`[${task.idReadable}] 开始执行（模板: ${rule.promptTemplate}）`);
      const { exitCode } = await deps.runPi(prompt, {
        cwd: deps.cwd,
        piPath: deps.piPath,
        sessionDir: config.sessionDir,
        onChild: deps.onChild,
      });
      log(`[${task.idReadable}] 完成（退出码 ${exitCode}）`);
    }
  }
  log(`轮次 ${round} 结束，等待 ${config.intervalSeconds} 秒`);
}

module.exports = { timestamp, log, sleep, runCycle };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 47 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
cd F:/liuxin/temp/temp
git add src/main.js test/main.test.js
git commit -m "feat: 主循环核心 runCycle（三层循环 + 同轮去重）"
```

---

### Task 8: 主入口 main() + 示例配置 + 收尾

**Files:**
- Modify: `src/main.js`（追加 main() 入口）
- Create: `config.json`
- Create: `templates/analyze.md`

**Interfaces:**
- Consumes:
  - `loadConfig(configPath)`（Task 4）
  - `createHttpClient()`（Task 5）
  - `runCycle({ config, deps, round })`（Task 7）
- Produces: `main(argv = process.argv) → Promise`：CLI 入口（`node src/main.js [configPath]`，configPath 缺省 `config.json`）

**main() 行为：**
1. `configPath = path.resolve(argv[2] || 'config.json')`；`loadConfig` 失败打印 `配置错误: <msg>` 并 `process.exit(1)`
2. `SUPERMAP_YOUTRACK_TOKEN` 未设置：打印错误并 `process.exit(1)`（不输出值）
3. `YOUTRACK_URL` 缺省 `http://yt.ispeco.com:8099`
4. 组装 deps：`httpClient = createHttpClient()`、`fetchTasks`、`runPi`、`cwd = path.resolve(__dirname, '..')`、`piPath = 'pi'`、`youTrackUrl`、`token`
5. `currentChild` 变量 + `deps.onChild = (child) => { currentChild = child; }`
6. SIGINT handler：打印退出日志 → `currentChild?.kill()`（Windows 下额外 `spawnSync('taskkill', ['/pid', String(currentChild.pid), '/T', '/F'])` 杀进程树）→ 3 秒兜底 `setTimeout(() => process.exit(0), 3000).unref()`（不立即 exit，让 runPi 的 finally 清理临时文件、循环自然退出）
7. `while (running)`：`runCycle` 包 try/catch（异常记日志，本轮中止）→ `await sleep(intervalSeconds * 1000, () => !running)`；`running` 由 SIGINT 置 false
8. 循环退出后打印 `已退出` 并 `process.exit(0)`
9. `if (require.main === module) main();` 导出 `main`

**注意：** main() 依赖 process/SIGINT，不做单元测试（runCycle 已全覆盖）；本任务通过"配置错误路径"做集成验证（见 Step 5）。

- [ ] **Step 1: 在 `src/main.js` 追加 main()**

首先修改文件顶部 require 区（Task 7 实现后的顶部为 `const fs = require('node:fs');` + filter/template/youTrack/piRunner 四个 require），改为：

```js
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { filterTasks } = require('./filter.js');
const { renderTemplate } = require('./template.js');
const { fetchTasks, createHttpClient } = require('./youTrack.js');
const { runPi } = require('./piRunner.js');
const { loadConfig } = require('./config.js');
```

然后在 `module.exports = { timestamp, log, sleep, runCycle };` 之前插入 main() 函数本体，并把 module.exports 改为：

```js
async function main(argv = process.argv) {
  const configPath = path.resolve(argv[2] || 'config.json');
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`配置错误: ${err.message}`);
    process.exit(1);
  }
  const token = process.env.SUPERMAP_YOUTRACK_TOKEN;
  if (!token) {
    console.error('错误: 未设置 SUPERMAP_YOUTRACK_TOKEN 环境变量');
    process.exit(1);
  }
  const youTrackUrl = process.env.YOUTRACK_URL || 'http://yt.ispeco.com:8099';
  let running = true;
  let currentChild = null;
  const deps = {
    httpClient: createHttpClient(),
    fetchTasks,
    runPi,
    youTrackUrl,
    token,
    cwd: path.resolve(__dirname, '..'),
    piPath: 'pi',
    onChild: (child) => { currentChild = child; },
    shouldStop: () => !running,
  };
  process.on('SIGINT', () => {
    log('收到 Ctrl+C，正在退出...');
    running = false;
    if (currentChild) {
      currentChild.kill();
      if (process.platform === 'win32' && currentChild.pid) {
        spawnSync('taskkill', ['/pid', String(currentChild.pid), '/T', '/F']);
      }
    }
    setTimeout(() => process.exit(0), 3000).unref();
  });
  let round = 1;
  while (running) {
    try {
      await runCycle({ config, deps, round });
    } catch (err) {
      log(`本轮异常: ${err.message}`);
    }
    if (!running) break;
    await sleep(config.intervalSeconds * 1000, () => !running);
    round += 1;
  }
  log('已退出');
  process.exit(0);
}
```

把 module.exports 改为：

```js
module.exports = { timestamp, log, sleep, runCycle, main };
```

并补上 `if (require.main === module) { main(); }`（放在 module.exports 之后）。注意：main() 内使用的 `log`、`sleep`、`runCycle`、`fetchTasks`、`runPi` 来自 Task 7 已定义的模块作用域；`loadConfig`、`createHttpClient`、`path`、`spawnSync` 来自本步顶部新增的 require——**不要重复声明任何变量**。

- [ ] **Step 2: 运行全部测试确认无回归**

Run: `npm test`
Expected: 47 个测试全部 PASS

- [ ] **Step 3: 创建示例配置 `config.json`**

```json
{
  "intervalSeconds": 60,
  "sessionDir": "./.pi-sessions",
  "rules": [
    {
      "labels": ["readyed", "clearly"],
      "notLabels": ["done"],
      "assignee": "me",
      "promptTemplate": "templates/analyze.md"
    }
  ]
}
```

- [ ] **Step 4: 创建示例模板 `templates/analyze.md`**

```markdown
请分析并处理 YouTrack 任务 {youtrack_id}：

1. 使用 supermap-youtrack skill 读取任务 {youtrack_id} 的详情
2. 分析任务内容并给出处理结论
3. 处理完成后，给任务添加 done 标签（notLabels 中配置的标签），以便下一轮轮询自动排除
```

说明：本模板为示例，仅演示 `{youtrack_id}` 占位符用法，不硬编码任何脚本路径；执行时由 pi 模型通过 supermap-youtrack skill 的描述自行定位脚本。用户可按实际工作流修改模板内容。

- [ ] **Step 5: 集成验证配置错误路径**

Run: `cd F:/liuxin/temp/temp && node src/main.js missing-config.json 2>&1; echo "exit=$?"`
Expected: 输出 `配置错误: ...`（配置文件不存在），`exit=1`
（使用不存在的配置文件稳定触发"配置错误"分支，与 SUPERMAP_YOUTRACK_TOKEN 是否设置无关，不启动真实循环）

- [ ] **Step 6: 提交**

```bash
cd F:/liuxin/temp/temp
git add src/main.js config.json templates/analyze.md
git commit -m "feat: main 主入口（SIGINT 优雅退出）+ 示例配置与模板"
```

---

### Task 9: 端到端冒烟验证（可选，需真实环境）

**Files:** 无（仅验证）

- [ ] **Step 1: 设置环境变量并短间隔运行一轮**

```bash
cd F:/liuxin/temp/temp
SUPERMAP_YOUTRACK_TOKEN='<用户自行提供>' node src/main.js
```

- [ ] **Step 2: 观察行为**

Expected: 日志显示轮次开始 → 按标签抓取（若当前有匹配任务则逐个执行 pi）→ 等待 intervalSeconds → Ctrl+C 退出（`收到 Ctrl+C，正在退出...` → `已退出`）

- [ ] **Step 3: 确认 session 目录**

Expected: `F:/liuxin/temp/temp/.pi-sessions/` 下出现 pi 的 session 文件（JSONL）

- [ ] **Step 4: 确认 git 状态干净**

Run: `git status --short`
Expected: 无未提交的本次工作文件（用户文件仍显示 untracked 属正常）
