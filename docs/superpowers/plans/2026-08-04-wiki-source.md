# youtrack-pi-worker 增加 wiki 来源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 youtrack-pi-worker 增加第二个任务来源：从 Supermap Confluence Wiki 按创建者+标签抓取页面，并给 supermap-wiki skill 新增"页面打标签"和"页面加评论"两个能力。

**Architecture:** 完全对称扩展。本项目新增 `src/wiki.js`（buildCql + fetchWikiTasks，返回与 youTrack.js 相同形状），config.js 支持 `source` 字段（缺省 youtrack），main.js 按 source 分发抓取并渲染 `{wiki_url}` 占位符；filter/piRunner/主循环复用。supermap-wiki skill 新增 `manage_label.js`（list/add/remove 页面标签）和 `add_comment.js`（页面加评论）两个独立脚本 + SKILL.md 文档。

**Tech Stack:** Node.js（CommonJS，零依赖）、node:test、Confluence Server REST API（`/rest/api/search`、`/rest/api/content`）。

## Global Constraints

- 零依赖：只允许 Node.js 内置模块（https、http、fs、path、node:test）
- 与现有代码风格一致：CommonJS、`require`、中文错误消息、httpClient 依赖注入（便于单测 mock）
- 两个 git 仓库：项目仓库 `F:/liuxin/temp/temp`（master）；skill 目录 `D:/liuxin/sources/skills/skills/skills/supermap-wiki` 的 git 根实测在 `D:/liuxin/sources/skills/skills`（supermap-wiki 是子目录，**非独立仓库**；仓库根还有 .pi/ 等未跟踪文件），提交只 `git add` 本任务文件，勿 `git add -A`
- 提交纪律：只 `git add` 本任务产生的文件，绝不 `git add -A`
- 环境变量：`SUPERMAP_WIKI_TOKEN` 只判断是否设置，绝不输出值；检查用 `test -n "$VAR"` 方式
- 冒烟测试只能操作 pageId `130526896`（用户授权的个人临时 wiki 页面）
- 设计文档：`docs/superpowers/specs/2026-08-04-wiki-source-design.md`（已批准，实现以此为准）

---

### Task 1: src/wiki.js（buildCql + fetchWikiTasks）

**Files:**
- Create: `src/wiki.js`
- Modify: `src/youTrack.js`（`createHttpClient` 401 错误消息参数化）
- Test: `test/wiki.test.js`、`test/youTrack.test.js`

**实现说明（对 spec 的刻意简化，已按第九轮审查更正）:** spec 中"优先 search expand 带出标签，不支持才回退"策略在本实例可行（实测 `expand=content.metadata.labels` 有效）——实现为 expand 优先 + 回退逐页，与 spec 一致，不再简化。

另注（expand 行为·实测确认）：`search?expand=content.metadata.labels`（**content. 前缀必需**）在本实例有效——content 含 metadata.labels 并直接带出标签（实测 smoke-expand-probe 标签随 search 响应返回）；无 `content.` 前缀时 content 无 metadata 键（keys 为 id,type,status,title,restrictions,_links,_expandable）。实现按 spec"expand 优先 + 回退"：expand 未生效时逐页获取。

另注（`escapeCql` 的 `\"` 转义）：仅为防御性——本实例实测 `creator = "a\\"b"` 的 CQL 返回 200 空结果（审查方实测为 400 "Could not parse cql"，行为未确认）。含双引号的标签/用户名属边缘场景：若 CQL 解析失败会落入 400 分支输出"查询语法错误，请检查规则配置与标签转义"提示并 log + continue，属预期安全行为。

**Interfaces:**
- Produces:
  - `buildCql(rule)` → string。`rule` 形状 `{labels: string[], assignee?: string}`。assignee 缺省或 `"me"` → `creator = currentUser()`；其他 → `creator = "用户名"`（双引号转义为 `\"`）
  - `fetchWikiTasks(rule, { httpClient, url, token })` → `Promise<Array<{id, idReadable, title, url, labels}>>`。`httpClient(url, {token})` 签名与 `src/youTrack.js` 的 `createHttpClient` 一致

- [ ] **Step 1: 写失败测试 `test/wiki.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildCql, fetchWikiTasks } = require('../src/wiki.js');

test('buildCql：assignee 缺省用 currentUser', () => {
  assert.strictEqual(
    buildCql({ labels: ['ready'] }),
    'creator = currentUser() AND type = page AND label in ("ready")'
  );
});

test('buildCql：assignee 为 me 且多标签', () => {
  assert.strictEqual(
    buildCql({ labels: ['ready', 'explorer'], assignee: 'me' }),
    'creator = currentUser() AND type = page AND label in ("ready", "explorer")'
  );
});

test('buildCql：assignee 为具体用户名', () => {
  assert.strictEqual(
    buildCql({ labels: ['ready'], assignee: 'liuxin1' }),
    'creator = "liuxin1" AND type = page AND label in ("ready")'
  );
});

test('buildCql：标签含双引号时转义', () => {
  assert.strictEqual(
    buildCql({ labels: ['a"b'] }),
    'creator = currentUser() AND type = page AND label in ("a\\"b")'
  );
});

test('fetchWikiTasks：搜索后逐页获取标签并归一化', async () => {
  const calls = [];
  const httpClient = async (url) => {
    calls.push(url);
    if (url.pathname === '/rest/api/search') {
      return {
        results: [
          { content: { id: '111', title: '页面A', _links: { webui: '/pages/viewpage.action?pageId=111' } } },
          { content: { id: '222', title: '页面B' } },
        ],
      };
    }
    if (url.pathname === '/rest/api/content/111') {
      return { id: '111', metadata: { labels: { results: [{ name: 'ready' }, { name: 'explored' }] } } };
    }
    if (url.pathname === '/rest/api/content/222') {
      return { id: '222', metadata: { labels: { results: [] } } };
    }
    throw new Error(`unexpected pathname: ${url.pathname}`);
  };
  const result = await fetchWikiTasks(
    { labels: ['ready'], assignee: 'me' },
    { httpClient, url: 'https://wiki.ispeco.com', token: 't' }
  );
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[0].pathname, '/rest/api/search');
  assert.strictEqual(
    calls[0].searchParams.get('cql'),
    'creator = currentUser() AND type = page AND label in ("ready")'
  );
  assert.strictEqual(calls[0].searchParams.get('limit'), '100');
  assert.strictEqual(calls[1].pathname, '/rest/api/content/111');
  assert.strictEqual(calls[1].searchParams.get('expand'), 'metadata.labels');
  assert.deepStrictEqual(result, [
    { id: '111', idReadable: '111', title: '页面A', url: 'https://wiki.ispeco.com/pages/viewpage.action?pageId=111', labels: ['ready', 'explored'] },
    { id: '222', idReadable: '222', title: '页面B', url: 'https://wiki.ispeco.com/pages/viewpage.action?pageId=222', labels: [] },
  ]);
});

test('fetchWikiTasks：搜索结果为空', async () => {
  const httpClient = async () => ({ results: [] });
  const result = await fetchWikiTasks(
    { labels: ['ready'] },
    { httpClient, url: 'https://wiki.ispeco.com', token: 't' }
  );
  assert.deepStrictEqual(result, []);
});

test('fetchWikiTasks：搜索失败向上传播', async () => {
  const httpClient = async () => { throw new Error('HTTP 400'); };
  await assert.rejects(
    fetchWikiTasks({ labels: ['ready'] }, { httpClient, url: 'https://wiki.ispeco.com', token: 't' }),
    /HTTP 400/
  );
});

test('fetchWikiTasks：页面 URL 使用 url.origin 保留协议与端口', async () => {
  const httpClient = async (url) => {
    if (url.pathname === '/rest/api/search') {
      return { results: [{ content: { id: '111', title: 'A' } }] };
    }
    return { id: '111', metadata: { labels: { results: [] } } };
  };
  const result = await fetchWikiTasks(
    { labels: ['ready'] },
    { httpClient, url: 'http://wiki.ispeco.com:8080', token: 't' }
  );
  assert.strictEqual(result[0].url, 'http://wiki.ispeco.com:8080/pages/viewpage.action?pageId=111');
});

test('fetchWikiTasks：expand 生效时直接带出标签（不逐页）', async () => {
  const calls = [];
  const httpClient = async (url) => {
    calls.push(url);
    return {
      results: [
        { content: { id: '111', title: '页面A', metadata: { labels: { results: [{ name: 'ready' }, { name: 'explored' }] } } } },
      ],
    };
  };
  const result = await fetchWikiTasks(
    { labels: ['ready'] },
    { httpClient, url: 'https://wiki.ispeco.com', token: 't' }
  );
  assert.strictEqual(calls.length, 1); // 只调 search，expand 带出标签，不逐页
  assert.deepStrictEqual(result, [
    { id: '111', idReadable: '111', title: '页面A', url: 'https://wiki.ispeco.com/pages/viewpage.action?pageId=111', labels: ['ready', 'explored'] },
  ]);
});
```

- [ ] **Step 2: 追加 `test/youTrack.test.js` 的 401 参数化测试（文件末尾）**

```js
test('createHttpClient：401 消息使用 tokenEnvName 参数', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(401);
    res.end();
  });
  try {
    const client = createHttpClient('SUPERMAP_WIKI_TOKEN');
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(client(url, { token: 't' }), /SUPERMAP_WIKI_TOKEN/);
  } finally {
    await closeServer(server);
  }
});

test('createHttpClient：400 提示查询语法错误（spec 错误处理表）', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(400);
    res.end();
  });
  try {
    const client = createHttpClient();
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(client(url, { token: 't' }), /查询语法错误/);
  } finally {
    await closeServer(server);
  }
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd F:/liuxin/temp/temp && node --test test/wiki.test.js test/youTrack.test.js`
Expected: FAIL（wiki.js 模块不存在导致 wiki 测试全部失败；401 新测试期望 /SUPERMAP_WIKI_TOKEN/ 但旧消息仍是 YOUTRACK_TOKEN；400 新测试期望 /查询语法错误/ 但旧代码走通用 `HTTP 400` 消息）

- [ ] **Step 4: 实现 `src/youTrack.js` 的 createHttpClient 参数化**

将 `createHttpClient` 签名与 401 分支改为：

```js
function createHttpClient(tokenEnvName = 'SUPERMAP_YOUTRACK_TOKEN') {
  return (url, { token, timeoutMs = 30000 }) =>
    ...
            } else if (res.statusCode === 401) {
              reject(new Error(`认证失败，请检查 ${tokenEnvName}`));
            } else if (res.statusCode === 400) {
              reject(new Error(`HTTP 400: 查询语法错误，请检查规则配置与标签转义（${tokenEnvName}）`));
            } else {
```

无参调用行为不变（默认参数保持原消息），现有测试零破坏。

- [ ] **Step 5: 实现 `src/wiki.js`**

```js
const { createHttpClient } = require('./youTrack.js');

function escapeCql(value) {
  return value.replace(/"/g, '\\"');
}

function buildCql(rule) {
  const creator = !rule.assignee || rule.assignee === 'me'
    ? 'creator = currentUser()'
    : `creator = "${escapeCql(rule.assignee)}"`;
  const labels = rule.labels.map((label) => `"${escapeCql(label)}"`).join(', ');
  return `${creator} AND type = page AND label in (${labels})`;
}

async function fetchWikiTasks(rule, { httpClient = createHttpClient('SUPERMAP_WIKI_TOKEN'), url, token }) {
  const searchUrl = new URL('/rest/api/search', url);
  searchUrl.searchParams.set('cql', buildCql(rule));
  searchUrl.searchParams.set('limit', '100');
  searchUrl.searchParams.set('includeArchivedSpaces', 'false');
  searchUrl.searchParams.set('expand', 'content.metadata.labels');
  const data = await httpClient(searchUrl, { token });
  const pages = (data?.results || [])
    .map((result) => result?.content)
    .filter((content) => content && content.id);
  const expandWorks = pages.length > 0 && pages[0].metadata !== undefined;
  const tasks = [];
  for (const page of pages) {
    let labels = (page.metadata?.labels?.results || []).map((label) => label.name);
    if (!expandWorks) {
      // 回退：search expand 未生效（如其他实例无 content. 前缀支持）时逐页获取标签
      const detailUrl = new URL(`/rest/api/content/${page.id}`, url);
      detailUrl.searchParams.set('expand', 'metadata.labels');
      const detail = await httpClient(detailUrl, { token });
      labels = (detail?.metadata?.labels?.results || []).map((label) => label.name);
    }
    tasks.push({
      id: page.id,
      idReadable: page.id,
      title: page.title,
      url: `${searchUrl.origin}/pages/viewpage.action?pageId=${page.id}`,
      labels,
    });
  }
  return tasks;
}

module.exports = { buildCql, fetchWikiTasks };
```

注意：`createHttpClient` 从 `./youTrack.js` 导入复用（已导出），保持 httpClient 注入可单测。

- [ ] **Step 6: 运行测试确认通过**

Run: `cd F:/liuxin/temp/temp && node --test test/wiki.test.js test/youTrack.test.js`
Expected: PASS（wiki 8 个 + youTrack 新增 2 个：401 参数化 + 400 查询语法错误）

- [ ] **Step 7: 跑全量测试确认无回归**

Run: `cd F:/liuxin/temp/temp && npm test`
Expected: 全部 PASS

- [ ] **Step 8: 提交**

```bash
cd F:/liuxin/temp/temp
git add src/wiki.js test/wiki.test.js src/youTrack.js test/youTrack.test.js
git commit -m "feat: wiki 来源抓取（buildCql creator/label 查询 + fetchWikiTasks 逐页取标签）；createHttpClient 401 消息参数化"
```

---

### Task 2: 来源注册表 sources.js + config source 校验

**Files:**
- Create: `src/sources.js`
- Modify: `src/config.js`（rules.map 中校验与返回）
- Test: `test/config.test.js`、`test/sources.test.js`

**Interfaces:**
- Consumes: `fetchTasks`（youTrack.js 既有导出）、`fetchWikiTasks`（Task 1）
- Produces:
  - `sources`：注册表对象 `{ youtrack: {fetchTasks, tokenEnv, urlEnv, defaultUrl}, wiki: {...} }`
  - `SOURCE_KEYS`：`['youtrack', 'wiki']`
  - 规则对象新增 `source` 字段（缺省 `'youtrack'`），校验基于 `SOURCE_KEYS`

新增来源流程（将来 jira/github 等）：创建 `src/<name>.js` 导出同签名 `fetchTasks(rule, {httpClient, url, token})`，在 `sources.js` 注册一行（fetch 实现 + token 环境变量名 + URL 环境变量名 + 默认 URL）。config 校验与 main 分发自动生效，无需改其他代码。

- [ ] **Step 1: 写失败测试**

新建 `test/sources.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { sources, SOURCE_KEYS } = require('../src/sources.js');

test('注册表包含 youtrack 与 wiki 两个来源', () => {
  assert.deepStrictEqual(SOURCE_KEYS, ['youtrack', 'wiki']);
  assert.strictEqual(typeof sources.youtrack.fetchTasks, 'function');
  assert.strictEqual(typeof sources.wiki.fetchTasks, 'function');
  assert.strictEqual(sources.youtrack.tokenEnv, 'SUPERMAP_YOUTRACK_TOKEN');
  assert.strictEqual(sources.youtrack.defaultUrl, 'http://yt.ispeco.com:8099');
  assert.strictEqual(sources.wiki.tokenEnv, 'SUPERMAP_WIKI_TOKEN');
  assert.strictEqual(sources.wiki.defaultUrl, 'https://wiki.ispeco.com');
});
```

追加到 `test/config.test.js` 末尾：

```js
test('source 缺省为 youtrack', () => {
  const { configPath } = makeFixture();
  const result = loadConfig(configPath);
  assert.strictEqual(result.rules[0].source, 'youtrack');
});

test('source 为合法值 wiki', () => {
  const { configPath } = makeFixture({
    rules: [
      { source: 'wiki', labels: ['ready'], notLabels: ['explored'], promptTemplate: 'templates/analyze.md' },
    ],
  });
  const result = loadConfig(configPath);
  assert.strictEqual(result.rules[0].source, 'wiki');
  assert.deepStrictEqual(result.rules[0].labels, ['ready']);
  assert.deepStrictEqual(result.rules[0].notLabels, ['explored']);
});

test('source 为非法值时报错', () => {
  const { configPath } = makeFixture({
    rules: [
      { source: 'jira', labels: ['a'], promptTemplate: 'templates/analyze.md' },
    ],
  });
  assert.throws(() => loadConfig(configPath), /source/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd F:/liuxin/temp/temp && node --test test/sources.test.js test/config.test.js`
Expected: FAIL（sources.js 不存在；source 校验未实现）

- [ ] **Step 3: 实现**

新建 `src/sources.js`：

```js
const { fetchTasks } = require('./youTrack.js');
const { fetchWikiTasks } = require('./wiki.js');

// 新增来源：创建 src/<name>.js 导出 fetchTasks(rule, {httpClient, url, token})，
// 然后在此注册一行（fetch 实现 + token 环境变量名 + URL 环境变量名 + 默认 URL）
const sources = {
  youtrack: {
    fetchTasks,
    tokenEnv: 'SUPERMAP_YOUTRACK_TOKEN',
    urlEnv: 'YOUTRACK_URL',
    defaultUrl: 'http://yt.ispeco.com:8099',
  },
  wiki: {
    fetchTasks: fetchWikiTasks,
    tokenEnv: 'SUPERMAP_WIKI_TOKEN',
    urlEnv: 'WIKI_URL',
    defaultUrl: 'https://wiki.ispeco.com',
  },
};

const SOURCE_KEYS = Object.keys(sources);

module.exports = { sources, SOURCE_KEYS };
```

`src/config.js`：顶部 require 增加：

```js
const { SOURCE_KEYS } = require('./sources.js');
```

在 `rules[${i}]` 的 labels 校验之前（rules.map 回调内）加入：

```js
    if (rule.source !== undefined && !SOURCE_KEYS.includes(rule.source)) {
      throw new Error(`rules[${i}].source 必须是 ${SOURCE_KEYS.map((k) => `"${k}"`).join(' 或 ')}`);
    }
```

将 rules.map 的 return 改为：

```js
    return {
      source: rule.source ?? 'youtrack',
      labels: rule.labels,
      notLabels: rule.notLabels ?? [],
      assignee: rule.assignee,
      promptTemplate: templatePath,
    };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd F:/liuxin/temp/temp && node --test test/sources.test.js test/config.test.js`
Expected: PASS

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `cd F:/liuxin/temp/temp && npm test`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
cd F:/liuxin/temp/temp
git add src/sources.js src/config.js test/sources.test.js test/config.test.js
git commit -m "feat: 来源注册表 sources.js（新增来源只需注册一行），config 校验基于注册表 key"
```

---

### Task 3: template.js 占位符泛化（{wiki_url}）

**Files:**
- Modify: `src/template.js`
- Test: `test/template.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `renderTemplate(content, { youtrackId?, wikiUrl? })` —— 参数缺省时不替换对应占位符；现有调用 `renderTemplate(content, { youtrackId })` 完全兼容

- [ ] **Step 1: 写失败测试（追加到 `test/template.test.js`）**

在文件末尾追加：

```js
test('替换 {wiki_url} 为页面 URL', () => {
  assert.strictEqual(
    renderTemplate('读取页面 {wiki_url}', { wikiUrl: 'https://wiki.ispeco.com/pages/viewpage.action?pageId=111' }),
    '读取页面 https://wiki.ispeco.com/pages/viewpage.action?pageId=111'
  );
});

test('两种占位符同时替换', () => {
  assert.strictEqual(
    renderTemplate('任务 {youtrack_id} 页面 {wiki_url}', { youtrackId: 'CS-1', wikiUrl: 'http://w' }),
    '任务 CS-1 页面 http://w'
  );
});

test('wikiUrl 未提供时不替换 {wiki_url}', () => {
  assert.strictEqual(renderTemplate('{wiki_url}', { youtrackId: 'CS-1' }), '{wiki_url}');
});

test('youtrackId 未提供时不替换 {youtrack_id}', () => {
  assert.strictEqual(renderTemplate('{youtrack_id}', { wikiUrl: 'http://w' }), '{youtrack_id}');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd F:/liuxin/temp/temp && node --test test/template.test.js`
Expected: FAIL（`{wiki_url}` 未被替换）

- [ ] **Step 3: 实现（修改 `src/template.js` 整体替换）**

```js
function renderTemplate(content, { youtrackId, wikiUrl } = {}) {
  let result = content;
  if (youtrackId !== undefined && youtrackId !== null) {
    result = result.replaceAll('{youtrack_id}', youtrackId);
  }
  if (wikiUrl !== undefined && wikiUrl !== null) {
    result = result.replaceAll('{wiki_url}', wikiUrl);
  }
  return result;
}

module.exports = { renderTemplate };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd F:/liuxin/temp/temp && node --test test/template.test.js`
Expected: PASS（8 个测试）

- [ ] **Step 5: 提交**

```bash
cd F:/liuxin/temp/temp
git add src/template.js test/template.test.js
git commit -m "feat: 模板占位符泛化，支持 {wiki_url}"
```

---

### Task 4: main.js 注册表分发与按来源校验 token

**Files:**
- Modify: `src/main.js`
- Test: `test/main.test.js`

**Interfaces:**
- Consumes: `sources`、`SOURCE_KEYS`（Task 2）、`renderTemplate(content, {youtrackId, wikiUrl})`（Task 3）、规则 `source` 字段（Task 2）
- Produces:
  - `resolveEnv(config, env = process.env)` → `{urls: {[source]: string}, tokens: {[source]: string}}`；只对配置中实际使用的来源要求 token，缺失时抛错
  - `runCycle` 的 deps：`sources`（注册表）、`urls`、`tokens`（均按来源名索引）

- [ ] **Step 1: 重写 `makeDeps` 并追加测试（`test/main.test.js`）**

将文件顶部的 `makeDeps` 整体替换为：

```js
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
    runPi: async () => ({ exitCode: 0 }),
    httpClient: null,
    cwd: '.',
    piPath: 'pi',
    shouldStop: () => false,
    ...overrides,
  };
}
```

六个既有测试的 `fetchTasks` override 逐一变换（其余代码不变）：

```js
// 'runCycle：同轮多个 rule 抓到同一任务只执行一次'
fetchTasks: async () => [{ id: '1', idReadable: 'CS-1', labels: ['a', 'b'] }],
// 改为：
sources: {
  youtrack: { fetchTasks: async () => [{ id: '1', idReadable: 'CS-1', labels: ['a', 'b'] }] },
  wiki: { fetchTasks: async () => [] },
},

// 'runCycle：无候选任务时不调用 runPi'
fetchTasks: async () => [],
// 改为：
sources: {
  youtrack: { fetchTasks: async () => [] },
  wiki: { fetchTasks: async () => [] },
},

// 'runCycle：抓取失败记日志并继续其他规则'
fetchTasks: async (rule) => {
  if (rule.labels[0] === 'a') throw new Error('网络错误: ECONNREFUSED');
  return [{ id: '1', idReadable: 'CS-1', labels: ['b'] }];
},
// 改为：
sources: {
  youtrack: { fetchTasks: async (rule) => {
    if (rule.labels[0] === 'a') throw new Error('网络错误: ECONNREFUSED');
    return [{ id: '1', idReadable: 'CS-1', labels: ['b'] }];
  } },
  wiki: { fetchTasks: async () => [] },
},

// 'runCycle：runPi 非零退出码不中断循环'
fetchTasks: async () => [
  { id: '1', idReadable: 'CS-1', labels: ['readyed'] },
  { id: '2', idReadable: 'CS-2', labels: ['readyed'] },
],
// 改为：
sources: {
  youtrack: { fetchTasks: async () => [
    { id: '1', idReadable: 'CS-1', labels: ['readyed'] },
    { id: '2', idReadable: 'CS-2', labels: ['readyed'] },
  ] },
  wiki: { fetchTasks: async () => [] },
},

// 'runCycle：shouldStop 时提前返回'
fetchTasks: async () => [{ id: '1', idReadable: 'CS-1', labels: ['readyed'] }],
// 改为：
sources: {
  youtrack: { fetchTasks: async () => [{ id: '1', idReadable: 'CS-1', labels: ['readyed'] }] },
  wiki: { fetchTasks: async () => [] },
},

// 'runCycle：模板读取失败时跳过该任务继续'
fetchTasks: async (rule) => {
  if (rule.labels[0] === 'a') {
    fs.rmSync(templateA);
    return [{ id: '1', idReadable: 'CS-1', labels: ['a'] }];
  }
  return [{ id: '2', idReadable: 'CS-2', labels: ['b'] }];
},
// 改为：
sources: {
  youtrack: { fetchTasks: async (rule) => {
    if (rule.labels[0] === 'a') {
      fs.rmSync(templateA);
      return [{ id: '1', idReadable: 'CS-1', labels: ['a'] }];
    }
    return [{ id: '2', idReadable: 'CS-2', labels: ['b'] }];
  } },
  wiki: { fetchTasks: async () => [] },
},
```

在文件末尾追加测试：

```js
const { resolveEnv } = require('../src/main.js'); // runCycle 已由文件顶部导入

test('runCycle：wiki 规则从注册表取 fetch 并渲染 {wiki_url}', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
  const templatePath = path.join(dir, 'wiki.md');
  fs.writeFileSync(templatePath, '读取页面 {wiki_url}', 'utf8');
  const config = {
    intervalSeconds: 60,
    sessionDir: dir,
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
    runPi: async (prompt) => { ran.push(prompt); return { exitCode: 0 }; },
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd F:/liuxin/temp/temp && node --test test/main.test.js`
Expected: FAIL（`resolveEnv` 未定义；runCycle 仍读 deps.fetchTasks 等旧字段）

- [ ] **Step 3: 实现（修改 `src/main.js`）**

a) 顶部 require 改为两行（替换原 `const { fetchTasks, createHttpClient } = require('./youTrack.js');`——`fetchTasks` 已由 sources 注册表引用，main.js 不再直接使用）：

```js
const { createHttpClient } = require('./youTrack.js');
const { sources, SOURCE_KEYS } = require('./sources.js');
```

b) `runCycle` 中抓取改为（找到现有 `tasks = await deps.fetchTasks(...)` 处替换）：

```js
    const sourceName = rule.source ?? 'youtrack'; // loadConfig 已保证存在；兜底缺省兼容直接构造 config 的调用（测试）
    const source = deps.sources[sourceName];
    let tasks;
    try {
      tasks = await source.fetchTasks(rule, {
        httpClient: deps.httpClient?.[sourceName], // 按来源取 client：401/400 消息指向对应来源的 tokenEnv；可选链使 mock 传 null 得 undefined、各来源 fetch 默认参数生效
        url: deps.urls[sourceName],
        token: deps.tokens[sourceName],
      });
    } catch (err) {
      log(`[${labelDesc}] 抓取失败: ${err.message}`);
      continue;
    }
```

c) 渲染处（找到 `renderTemplate(template, { youtrackId: task.idReadable })` 处替换）：

```js
      const prompt = renderTemplate(template, {
        youtrackId: task.idReadable,
        wikiUrl: task.url,
      });
```

d) 新增 `resolveEnv` 函数（放在 `runCycle` 之前）：

```js
function resolveEnv(config, env = process.env) {
  const usedSources = new Set(config.rules.map((rule) => rule.source ?? 'youtrack')); // 与 runCycle 的兜底一致
  const urls = {};
  const tokens = {};
  for (const name of SOURCE_KEYS) {
    urls[name] = env[sources[name].urlEnv] || sources[name].defaultUrl;
    if (usedSources.has(name)) {
      const token = env[sources[name].tokenEnv];
      if (!token) {
        throw new Error(`未设置 ${sources[name].tokenEnv} 环境变量`);
      }
      tokens[name] = token;
    }
  }
  return { urls, tokens };
}
```

`main()` 中替换原有的 token 读取与 youTrackUrl 部分：

```js
  let env;
  try {
    env = resolveEnv(config);
  } catch (err) {
    console.error(`环境错误: ${err.message}`);
    process.exit(1);
  }
```

deps 对象改为：

```js
  const deps = {
    // 按来源创建 client：401/400 消息指向对应来源的 token 环境变量（spec 错误处理表：wiki 401 提示检查 SUPERMAP_WIKI_TOKEN）。
    // 不能用共享单一 client——那会覆盖 wiki.js 默认参数，导致生产路径 wiki 401 误导指向 YOUTRACK_TOKEN
    httpClient: Object.fromEntries(
      SOURCE_KEYS.map((name) => [name, createHttpClient(sources[name].tokenEnv)])
    ),
    sources,
    runPi,
    urls: env.urls,
    tokens: env.tokens,
    cwd: path.resolve(__dirname, '..'),
    piPath: 'pi',
    onChild: (child) => { currentChild = child; },
    shouldStop: () => !running,
  };
```

module.exports 增加 `resolveEnv`：

```js
module.exports = { timestamp, log, sleep, runCycle, resolveEnv, main };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd F:/liuxin/temp/temp && node --test test/main.test.js`
Expected: PASS

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `cd F:/liuxin/temp/temp && npm test`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
cd F:/liuxin/temp/temp
git add src/main.js test/main.test.js
git commit -m "feat: 主循环按来源注册表分发，resolveEnv 按使用来源校验 token"
```

---

### Task 5: supermap-wiki skill 新增 manage_label.js

**Files:**
- Create: `D:/liuxin/sources/skills/skills/skills/supermap-wiki/scripts/manage_label.js`

**Interfaces:**
- Produces: CLI 脚本，命令：
  - `node scripts/manage_label.js list <pageId>` —— 列出页面标签（每行一个）
  - `node scripts/manage_label.js add <pageId> <标签名>` —— 加标签（已存在则跳过并提示）
  - `node scripts/manage_label.js remove <pageId> <标签名>` —— 删标签（不存在则提示）
  - 环境变量 `SUPERMAP_WIKI_TOKEN`，缺失时退出码 1 并提示
  - 标签名只取单个参数（`args[2]`）：Confluence 标签不允许空格，与 add_comment.js 的 `args.slice(1).join(' ')`（评论可含空格）不同是有意为之

- [ ] **Step 1: 实现脚本 `scripts/manage_label.js`**

参照 `search_wiki.js` 的 getToken / makeRequest 模式（Bearer token、timeout 30000、`rejectUnauthorized: false`，错误消息为英文、与 skill 现有脚本一致）：

```js
#!/usr/bin/env node
/**
 * Supermap Wiki Label Manager Script
 *
 * Manages labels on a wiki page: list, add, remove.
 * Environment: SUPERMAP_WIKI_TOKEN
 */

const https = require('https');

const WIKI_BASE_URL = 'wiki.ispeco.com';

function getToken() {
    const token = process.env.SUPERMAP_WIKI_TOKEN;
    if (!token) {
        console.error('Error: SUPERMAP_WIKI_TOKEN environment variable is not set.');
        process.exit(1);
    }
    return token;
}

function makeRequest(path, token, method = 'GET', postData = null) {
    return new Promise((resolve, reject) => {
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'User-Agent': 'Supermap-Wiki-ManageLabel/1.0'
        };
        if (postData) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(postData);
        }
        const req = https.request({
            hostname: WIKI_BASE_URL,
            path: path,
            method: method,
            headers: headers,
            timeout: 30000,
            rejectUnauthorized: false
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(data ? JSON.parse(data) : null);
                    } catch (e) {
                        resolve(data);
                    }
                } else if (res.statusCode === 401) {
                    reject(new Error('Authentication failed. Please check your SUPERMAP_WIKI_TOKEN.'));
                } else if (res.statusCode === 403) {
                    reject(new Error('Access forbidden. You may not have permission to edit this page.'));
                } else if (res.statusCode === 404) {
                    reject(new Error('Page not found. Please check the pageId.'));
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                }
            });
        });
        req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        if (postData) req.write(postData);
        req.end();
    });
}

async function getLabels(pageId, token) {
    const data = await makeRequest(`/rest/api/content/${pageId}?expand=metadata.labels`, token);
    return (data?.metadata?.labels?.results || [])
        .map((label) => label.name);
}

async function listLabels(pageId, token) {
    const labels = await getLabels(pageId, token);
    if (labels.length === 0) {
        console.log('(无标签)');
    } else {
        for (const name of labels) {
            console.log(name);
        }
    }
}

async function addLabel(pageId, name, token) {
    const existing = await getLabels(pageId, token);
    if (existing.includes(name)) {
        console.log(`Label "${name}" already exists on page ${pageId}. Nothing to do.`);
        return;
    }
    await makeRequest(
        `/rest/api/content/${pageId}/label`,
        token,
        'POST',
        JSON.stringify([{ prefix: 'global', name: name }])  // 标签数组或单对象 {prefix,name} 本实例实测均 200；{"labels":[...]} 包装格式、字符串、空对象实测 400 "Could not parse Labels"，勿用
    );
    console.log(`Label added to page ${pageId}: ${name}`);
}

async function removeLabel(pageId, name, token) {
    const existing = await getLabels(pageId, token);
    if (!existing.includes(name)) {
        console.log(`Page ${pageId} does not have label "${name}". Nothing to remove.`);
        return;
    }
    await makeRequest(`/rest/api/content/${pageId}/label?name=${encodeURIComponent(name)}`, token, 'DELETE');
    console.log(`Label removed from page ${pageId}: ${name}`);
}

function printHelp() {
    console.log(`Supermap Wiki Label Manager

Usage:
  node scripts/manage_label.js list <pageId>              列出页面标签
  node scripts/manage_label.js add <pageId> <标签名>     给页面添加标签
  node scripts/manage_label.js remove <pageId> <标签名>  移除页面标签

Examples:
  node scripts/manage_label.js list 130526896
  node scripts/manage_label.js add 130526896 explored
  node scripts/manage_label.js remove 130526896 explored

Environment:
  SUPERMAP_WIKI_TOKEN  - Required. Your wiki API token.
`);
}

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--help' || args[0] === '-h') {
        printHelp();
        process.exit(0);
    }
    if (args.length < 2) {
        printHelp();
        process.exit(1);
    }
    const command = args[0];
    const pageId = args[1];
    const name = args[2];
    const token = getToken();
    try {
        if (command === 'list') {
            await listLabels(pageId, token);
        } else if (command === 'add') {
            if (!name) throw new Error('Missing label name. Usage: add <pageId> <标签名>');
            await addLabel(pageId, name, token);
        } else if (command === 'remove') {
            if (!name) throw new Error('Missing label name. Usage: remove <pageId> <标签名>');
            await removeLabel(pageId, name, token);
        } else {
            printHelp();
            process.exit(1);
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(`Unexpected error: ${err.message}`);
    process.exit(1);
});
```

- [ ] **Step 2: 语法检查**

Run: `cd D:/liuxin/sources/skills/skills/skills/supermap-wiki && node --check scripts/manage_label.js`
Expected: 无输出（语法 OK）

- [ ] **Step 3: 提交（skill 仓库）**

```bash
cd D:/liuxin/sources/skills/skills/skills/supermap-wiki
git add scripts/manage_label.js
git commit -m "feat: wiki 页面标签管理脚本（list/add/remove，幂等）"
```

---

### Task 6: supermap-wiki skill 新增 add_comment.js

**Files:**
- Create: `D:/liuxin/sources/skills/skills/skills/supermap-wiki/scripts/add_comment.js`

**Interfaces:**
- Produces: CLI 脚本：
  - `node scripts/add_comment.js <pageId> <评论文本或文件路径>` —— 给页面加评论
  - 文本参数若为存在的文件路径则读取文件内容作为评论；文本转 storage（XML 转义，段落换行转 `<p>`）
  - 文件路径判断是设计权衡：评论文本恰好与现有文件同名时会被误读为文件（概率低；SKILL.md 的"### 说明"已向用户说明该行为）
  - 环境变量 `SUPERMAP_WIKI_TOKEN`，缺失时退出码 1

- [ ] **Step 1: 实现脚本 `scripts/add_comment.js`**

参照 `write_wiki.js` 的 token 检查与 `search_wiki.js` 的请求模式：

```js
#!/usr/bin/env node
/**
 * Supermap Wiki Add Comment Script
 *
 * Adds a comment to a wiki page.
 * Environment: SUPERMAP_WIKI_TOKEN
 */

const https = require('https');
const fs = require('fs');

const WIKI_BASE_URL = 'wiki.ispeco.com';

function getToken() {
    const token = process.env.SUPERMAP_WIKI_TOKEN;
    if (!token) {
        console.error('Error: SUPERMAP_WIKI_TOKEN environment variable is not set.');
        process.exit(1);
    }
    return token;
}

const HELP_TEXT = `Supermap Wiki Add Comment

Usage:
  node scripts/add_comment.js <pageId> <评论文本或文件路径>

Examples:
  node scripts/add_comment.js 130526896 "任务已完成，详见评论"
  node scripts/add_comment.js 130526896 ./result.md

Environment:
  SUPERMAP_WIKI_TOKEN  - Required. Your wiki API token.
`;

function escapeXml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textToStorage(text) {
    const paragraphs = text
        .replace(/\r\n/g, '\n')
        .split(/\n\s*\n/)
        .map((p) => escapeXml(p).replace(/\n/g, '<br/>').trim())
        .filter((p) => p.length > 0);
    return paragraphs.map((p) => `<p>${p}</p>`).join('');
}

function addComment(pageId, content, token) {
    return new Promise((resolve, reject) => {
        const storageValue = textToStorage(content);
        const postData = JSON.stringify({
            type: 'comment',
            container: { id: pageId, type: 'page' },
            body: {
                storage: {
                    value: storageValue,
                    representation: 'storage'
                }
            }
        });
        const req = https.request({
            hostname: WIKI_BASE_URL,
            path: '/rest/api/content',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Supermap-Wiki-AddComment/1.0'
            },
            timeout: 30000,
            rejectUnauthorized: false
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                } else if (res.statusCode === 401) {
                    reject(new Error('Authentication failed. Please check your SUPERMAP_WIKI_TOKEN.'));
                } else if (res.statusCode === 403) {
                    reject(new Error('Access forbidden. You may not have permission to comment on this page.'));
                } else if (res.statusCode === 404) {
                    reject(new Error('Page not found. Please check the pageId.'));
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                }
            });
        });
        req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(postData);
        req.end();
    });
}

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--help' || args[0] === '-h') {
        console.log(HELP_TEXT);
        process.exit(0);
    }
    if (args.length < 2) {
        console.log(HELP_TEXT);
        process.exit(1);
    }
    const pageId = args[0];
    const input = args.slice(1).join(' ');
    const token = getToken();

    let content = input;
    if (fs.existsSync(input) && fs.statSync(input).isFile()) {
        try {
            content = fs.readFileSync(input, 'utf8');
        } catch (err) {
            console.error(`Error: Cannot read content file: ${input}`);
            process.exit(1);
        }
    }
    if (!content.trim()) {
        console.error('Error: Comment content is empty.');
        process.exit(1);
    }

    try {
        const result = await addComment(pageId, content, token);
        console.log(`Comment added to page ${pageId} successfully.`);
        if (result && result.id) {
            console.log(`Comment ID: ${result.id}`);
        }
    } catch (err) {
        console.error(`Failed to add comment: ${err.message}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(`Unexpected error: ${err.message}`);
    process.exit(1);
});
```

- [ ] **Step 2: 多行输入快速验证（零副作用）**

Run: `cd D:/liuxin/sources/skills/skills/skills/supermap-wiki && node -e "const fs=require('fs');const src=fs.readFileSync('scripts/add_comment.js','utf8');eval(src.match(/function escapeXml[\s\S]*?\n\}/)[0] + src.match(/function textToStorage\(text\) \{[\s\S]*?\n\}/)[0]);console.log(JSON.stringify(textToStorage('第一行\\n第二行\\n\\n第三段')))"`
Expected: 输出 `"<p>第一行<br/>第二行</p><p>第三段</p>"`（`<br/>` 未被转义，段内换行正确）

- [ ] **Step 3: 语法检查**

Run: `cd D:/liuxin/sources/skills/skills/skills/supermap-wiki && node --check scripts/add_comment.js`
Expected: 无输出（语法 OK）

- [ ] **Step 4: 提交（skill 仓库）**

```bash
cd D:/liuxin/sources/skills/skills/skills/supermap-wiki
git add scripts/add_comment.js
git commit -m "feat: wiki 页面评论脚本（文本/文件参数，storage 转换）"
```

---

### Task 7: supermap-wiki skill 更新 SKILL.md 文档

**Files:**
- Modify: `D:/liuxin/sources/skills/skills/skills/supermap-wiki/SKILL.md`

- [ ] **Step 1: 更新 frontmatter description 并新增两个章节**

a) 将 SKILL.md 顶部 frontmatter 的 description 改为：

```yaml
description: 完整操作 Supermap Confluence Wiki，支持搜索、读取、写入、标签管理、评论功能。搜索文档查找信息，读取页面内容（含图片、评论、递归引用），创建新页面或更新现有页面（可指定模板），管理页面标签，给页面添加评论。
```

b) 插入位置：在"## 写入 Wiki 页面"与"## 前置条件"之间**已有**的 `---` 分隔线**之后**插入以下内容。插入内容**以 `---` 结尾**、**不以 `---` 开头**——最终结构为：`写入章节` `---` `## 管理页面标签` ... `---` `## 给页面添加评论` ... `---` `## 前置条件`，各章节间恰好一个分隔线（原 `---` 分隔写入章节与首个新章节，插入内容的收尾 `---` 分隔末尾新章节与前置条件）：

````markdown
## 管理页面标签

给 wiki 页面添加/移除/查看标签。标签是全局共享元数据，对所有人可见；给页面打标签会改变页面的可见状态，请确认这是预期的操作。

### 执行脚本

```bash
# 列出页面标签
node scripts/manage_label.js list <pageId>

# 给页面添加标签（已存在则跳过，幂等）
node scripts/manage_label.js add <pageId> <标签名>

# 移除页面标签（不存在则提示）
node scripts/manage_label.js remove <pageId> <标签名>
```

### 示例

```bash
node scripts/manage_label.js list 130526896
node scripts/manage_label.js add 130526896 explored
node scripts/manage_label.js remove 130526896 explored
```

### 输出格式

- list: 每行一个标签名；无标签时输出 `(无标签)`
- add: `Label added to page {pageId}: {标签名}`；已存在时提示 Nothing to do
- remove: `Label removed from page {pageId}: {标签名}`；不存在时提示 Nothing to remove

### 错误处理

- 与现有脚本一致：缺 token / 401 / 403 / 404 / 网络错误 / 超时均输出对应提示并以退出码 1 退出

---

## 给页面添加评论

给 wiki 页面添加一条评论。评论对所有人可见，常用于回写处理结果、留痕。

### 执行脚本

```bash
node scripts/add_comment.js <pageId> <评论文本或文件路径>
```

### 示例

```bash
node scripts/add_comment.js 130526896 "任务已完成，详见评论"
node scripts/add_comment.js 130526896 ./result.md
```

### 说明

- 文本参数如果是一个存在的文件路径，则读取文件内容作为评论
- 评论内容自动转义并转换为 Confluence storage 格式（段落换行转 `<p>`）
- 输出: `Comment added to page {pageId} successfully.` 及 `Comment ID: {id}`

### 错误处理

- 与现有脚本一致：缺 token / 401 / 403 / 404 / 网络错误 / 超时均输出对应提示并以退出码 1 退出

---
````

- [ ] **Step 2: 检查文档渲染**

Run: `cd D:/liuxin/sources/skills/skills/skills/supermap-wiki && grep -c "manage_label\|add_comment" SKILL.md`
Expected: 输出大于 0

- [ ] **Step 3: 提交（skill 仓库）**

```bash
cd D:/liuxin/sources/skills/skills/skills/supermap-wiki
git add SKILL.md
git commit -m "docs: SKILL.md 补充页面标签管理与评论能力说明"
```

---

### Task 8: 真实冒烟（操作仅限 pageId 130526896）

**Files:**
- 无（临时命令，不落库）

**实现说明（对 spec 的刻意简化）:** spec 冒烟计划第 2 条为"配一条临时 wiki 规则真实跑一轮"（含 spawn pi 完整链路）；本任务改为 node -e 直接调用 `fetchWikiTasks` 验证抓取层。原因：spawn pi 执行依赖真实模型输出、无法断言闭环且耗时长；pi 执行链路已在既有 youtrack 冒烟验证过，抓取层才是本任务新增部分。

**前置条件：** 环境变量 `SUPERMAP_WIKI_TOKEN` 已设置（只检查设置与否，不输出值）：

```bash
test -n "$SUPERMAP_WIKI_TOKEN" && echo "token set" || echo "token MISSING"
```

Expected: `token set`

- [ ] **Step 1: 冒烟 manage_label（加→查→删→查）**

```bash
cd D:/liuxin/sources/skills/skills/skills/supermap-wiki
node scripts/manage_label.js add 130526896 smoke-test
node scripts/manage_label.js list 130526896
node scripts/manage_label.js remove 130526896 smoke-test
node scripts/manage_label.js list 130526896
```

Expected:
- add 输出 `Label added to page 130526896: smoke-test`
- list 第二次出现 `smoke-test`
- remove 输出 `Label removed from page 130526896: smoke-test`
- 最终 list 不再包含 `smoke-test`（残留原有标签属正常）

- [ ] **Step 2: 冒烟 add_comment（加→读验证）**

```bash
cd D:/liuxin/sources/skills/skills/skills/supermap-wiki
node scripts/add_comment.js 130526896 "smoke test comment from wiki-source plan"
node scripts/read_wiki.js 130526896 --no-images --depth 0 | grep -A3 "smoke test comment"
```

Expected: add 输出成功与 Comment ID；read 输出中包含 `smoke test comment from wiki-source plan`

注：该冒烟评论会残留在页面 130526896（评论无删除命令，属预期残留；页面已获用户授权）

- [ ] **Step 3: 冒烟 fetchWikiTasks（真实抓取链路）**

前提：`assignee: 'me'` 会生成 `creator = currentUser()`，要求页面 130526896 由 `SUPERMAP_WIKI_TOKEN` 对应账号创建（该页面为用户个人页面，通常满足）；若抓取结果为空，将下面命令中的 `assignee: 'me'` 换成页面实际创建者的用户名（如 `assignee: 'liuxin1'`）重试。

**索引延迟注意（实测）**：打标签后 Confluence 搜索索引异步更新——实测立即 search 返回 totalSize=0，约 25 秒后返回 1。因此 add 标签后必须 `sleep 30` 再执行 fetch 验证；若 fetch 结果为空，先等 30 秒重试，不要误判为实现 bug。

给测试页面打一个临时抓取标签，用脚本直接验证抓取（不跑完整 worker，避免 spawn pi）：

```bash
cd D:/liuxin/sources/skills/skills/skills/supermap-wiki
node scripts/manage_label.js add 130526896 smoke-ready
sleep 30   # 等待搜索索引更新（实测索引延迟约 25 秒，不等待会假失败）

cd F:/liuxin/temp/temp
node -e "
const { fetchWikiTasks } = require('./src/wiki.js');
(async () => {
  const tasks = await fetchWikiTasks(
    { labels: ['smoke-ready'], assignee: 'me' },
    { url: 'https://wiki.ispeco.com', token: process.env.SUPERMAP_WIKI_TOKEN }
  );
  console.log(JSON.stringify(tasks, null, 2));
})();
"
```

Expected: 输出数组包含 `{ id: '130526896', idReadable: '130526896', title: ..., labels: ['smoke-ready', ...] }`

清理：

```bash
cd D:/liuxin/sources/skills/skills/skills/supermap-wiki
node scripts/manage_label.js remove 130526896 smoke-ready
```

- [ ] **Step 4: 回归确认**

Run: `cd F:/liuxin/temp/temp && npm test`
Expected: 全部 PASS（项目测试不受冒烟影响）

- [ ] **Step 5: 向用户汇报冒烟结果**

汇报内容：manage_label 加/查/删结果、add_comment 结果、fetchWikiTasks 抓到的页面与标签；无失败项才可声称完成。

---

## Self-Review 记录

**1. Spec 覆盖**：核心需求 1-5 对应 Task 2/4、Task 1、Task 5、Task 6、Task 1-4。
**2. 占位符**：无 TBD/TODO，所有代码块完整。
**3. 类型一致性**：`fetchWikiTasks(rule, {httpClient, url, token})` 在 Task 1 定义、Task 2 注册、Task 4 消费，签名一致；`sources`/`SOURCE_KEYS` 在 Task 2 定义，Task 4 的 runCycle 分发与 resolveEnv 遍历消费一致；`renderTemplate(content, {youtrackId, wikiUrl})` 在 Task 3 定义、Task 4 消费一致；`resolveEnv` 在 Task 4 定义并导出，测试同步引用；`createHttpClient(tokenEnvName)` 在 Task 1 参数化（默认参数兼容现有调用），Task 1 测试覆盖 401 消息。

**架构调整（2026-08-04）**：按用户要求将"if else 判断 source"改为来源注册表——新增 `src/sources.js`（source → {fetchTasks, tokenEnv, urlEnv, defaultUrl}），config 校验基于 `SOURCE_KEYS`，main 按注册表分发，resolveEnv 只对使用到的来源要求 token（仅 wiki 规则时不再要求 youtrack token）。Task 2 改为创建注册表 + config 校验，Task 4 改为注册表分发；新增来源（jira/github 等）= 新模块 + 注册一行，无需改分发代码。

**审查修复记录（2026-08-04）**：外部审查发现 5 条问题，全部已并入计划——
1. Task 6 textToStorage 转义顺序（先 replace 后 escapeXml 会把 `<br/>` 转义为字面文本）→ 已修复为先转义后插入标签，并新增多行验证步骤
2. Task 1 复用 createHttpClient 导致 wiki 401 消息误导指向 YOUTRACK_TOKEN → createHttpClient 增加 tokenEnvName 参数（默认值不变），wiki.js 传入 `'SUPERMAP_WIKI_TOKEN'`，新增对应测试
3. Task 1 页面 URL 硬编码 `https://${url.host}` → 改用 `url.origin`（保留协议/端口），新增测试
4. Task 8 冒烟隐含 `assignee: 'me'` 要求页面为 token 账号创建 → 补充前提说明与备选方案
5. spec"优先 search expand"被简化为总是逐页 → 在 Task 1 注明为刻意偏离（确定性优先），未改实现
轻微项：Task 5"中文错误消息"描述与 skill 英文脚本不符已修正；Self-Review 引导语矛盾已删除；Task 7 补 frontmatter description 同步；Task 4 重复 require 已清理。

**审查修复记录（2026-08-04 第二轮，均为致命/有效问题）**：
1. Task 4 runCycle 无 source 兜底 → 改为 `deps.sources[rule.source ?? 'youtrack']`。原因：loadConfig 保证只在生产路径成立，现有测试直接构造 config 不走 loadConfig，`deps.sources[undefined]` 会抛 TypeError 被 catch 吞掉导致至少 7 个现有测试失败；"缺省 source 走 youtrack"测试在崩溃路径下是假阳性
2. Task 6 Step 2 验证命令 ReferenceError → 同时提取 `escapeXml` 与 `textToStorage` 两个函数再 eval（textToStorage 依赖 escapeXml）
3. Task 1 400 错误未覆盖 spec 错误处理表 → createHttpClient 400 分支加"查询语法错误，请检查规则配置与标签转义"提示 + 新增测试
4. Task 5/6 脚本 `--help` 退出码错误（退出码 1）→ `--help`/`-h` 退出码 0，仅无参数时 1
5. Task 4 保留未使用的 `fetchTasks` require → 只保留 `createHttpClient`
6. Task 8 冒烟显式传默认 `createHttpClient()`（401 消息指向 YOUTRACK_TOKEN）→ 省略参数走 `fetchWikiTasks` 默认 `createHttpClient('SUPERMAP_WIKI_TOKEN')`

**审查修复记录（2026-08-04 第三轮）**：
1. Task 1 Step 6 期望数字未同步（Step 2 新增 401+400 两个测试，Step 6 仍写"新增 1 个"）→ 改为"youTrack 新增 2 个"
2. Task 4 兜底只做了一半（sources 兜底但 url/token 仍用 rule.source）→ 提取 `sourceName = rule.source ?? 'youtrack'` 统一索引三处
3. Task 4 六个既有测试的 override 变换只给 1 个示例 → 逐一给出全部 6 个的完整变换（机械变换但避免执行者推断）
4. Task 7 插入内容以 `---` 开头与 SKILL.md 已有分隔线重复 → 去掉开头 `---` 并注明原因
5. Task 5 标签名单 token 与 add_comment 风格不一致 → 注明为有意为之（Confluence 标签不允许空格）

**审查修复记录（2026-08-04 第四轮）**：
1. Task 8 冒烟方式偏离 spec 但未注记 → 补"刻意简化"说明（node -e 验证抓取层，不 spawn pi：依赖真实模型输出无法断言闭环）
2. Task 7 新章节未提错误处理（spec 架构表要求含错误处理）→ 补"### 错误处理：与现有脚本一致"小节
3. Task 6 add_comment.js：help 文本两份重复 → 提取 `HELP_TEXT` 常量；空评论无前置校验 → 增加 `!content.trim()` 拦截
4. Task 4 resolveEnv 无 source 兜底（与 runCycle 不对称）→ `rule.source ?? 'youtrack'`
5. Task 8 冒烟评论无清理步骤 → 注明为预期残留（评论无删除命令，页面已获授权）
极小项（includeArchivedSpaces 未断言、mock _links.webui 冗余、limit=100 无分页）经评估无需修改：参数已在实现中、冗余无害、分页 YAGNI。

**审查修复记录（2026-08-04 第五轮）**：
1. 【致命】Task 1 实现 `url.origin` 在字符串上返回 undefined（url 参数在所有调用路径都是字符串，origin 是 URL 对象属性）→ 改用函数内已有的 `searchUrl.origin`（URL 对象，已验证）；测试断言正确无需改
2. Task 4 Step 3a require 改法不完整（执行者需自行拼出 youTrack.js 的 require 行）→ 明确写出两行完整 require
3. Task 4 Step 3d `let env` 建议改 const —— **不采纳**：const 必须在声明时初始化，try 块内赋值会导致 SyntaxError，`let` 是正确写法
4. Task 6 文件路径误判（评论文本恰好与现有文件同名）→ 设计权衡已接受；SKILL.md 的"### 说明"已向用户说明文件参数行为，补注记确认
5. includeArchivedSpaces 未在测试断言 —— 同意不改（第四轮已评估，search_wiki.js 有先例）

**审查修复记录（2026-08-04 第七轮）**：
1. 【中·实测确认】Task 8 Step 3 冒烟会因标签索引延迟假失败（实测：打标签后立即 search totalSize=0，约 25 秒后 1）→ add 与 fetch 之间加 `sleep 30` 并注明原因
2. 【低·实测确认】"重复打标签会报错"与实际不符（重复 POST 同一标签实测返回 200）→ 修正描述：幂等检查价值是避免重复请求，而非规避报错
3. 【低】`\"` 转义行为未确认（本机实测 creator 含 `\"` 的 CQL 返回 200 空结果，与审查方实测 400 不一致）→ 注明为防御性；含引号标签属边缘场景，失败落入 400 分支安全提示
4. 【实测新增发现】Task 5 label body 数组格式在本实例实测 400（"Could not parse Labels"），单个对象格式 200 → 修正 addLabel 实现与 spec 描述，防止冒烟/真实使用失败

**审查修复记录（2026-08-04 第八轮）**：
1. 【R1 必改】main 生产路径 wiki 401 消息误导：Task 4 显式传共享 `deps.httpClient = createHttpClient()`（默认 YOUTRACK_TOKEN），覆盖 fetchWikiTasks 默认参数 → 改为按来源创建 client 映射 `Object.fromEntries(SOURCE_KEYS.map(name => [name, createHttpClient(sources[name].tokenEnv)]))`，runCycle 用 `deps.httpClient?.[sourceName]`（可选链：mock 传 null 得 undefined，各来源 fetch 默认参数生效，现有测试零破坏）
2. 【F1 事实修正·更正第七轮第 4 条】Task 5 注释"数组格式 400"归因错误——第七轮结论是验证脚本二次序列化 bug 所致（req 收到字符串又 JSON.stringify 一次）；实测对象数组 `[{prefix,name}]` 200、单对象 200，`{"labels":[...]}` 包装、字符串、空对象 400 → 注释与 spec 已修正
3. 【F2 事实修正】skill 非独立仓库：git 根实测在 `D:/liuxin/sources/skills/skills` → Global Constraints 修正
4. 【I1】search expand 实测无 metadata 键（keys: id,type,status,title,restrictions,_links,_expandable）→ 注记补充"逐页是唯一可行路径"
5. 【I2】冒烟前提实测满足：页面 createdBy=liuxin1，`creator = currentUser()` 命中 totalSize=1 → 前提改为已确认，备选保留
6. 【N1】textToStorage 对 `\r\n` 残留 → 开头 `replace(/\r\n/g, '\n')` 归一化
7. 【N2】getLabels 写法 → 可选链风格

**审查修复记录（2026-08-04 第九轮）**：
1. 【重要·实测更正第八轮 I1 结论】search expand 前缀问题：实测 `expand=content.metadata.labels`（content. 前缀必需）在本实例**有效**——content 含 metadata.labels 并直接带出标签（smoke-expand-probe 实测）；无 `content.` 前缀才无 metadata 键。第八轮 I1"expand 不可用"结论错误（当时搜索空结果误判）。spec"expand 优先 + 回退"策略可行 → Task 1 实现改为 expand 优先 + 回退逐页（与 spec 一致），新增 expand 生效测试（calls.length === 1），注记更正
2. 【正文修复】第八轮 R1 修复只写进 Self-Review 记录、正文未应用（编辑回滚）→ Task 4 Step 3b 改为 `deps.httpClient?.[sourceName]`、Step 3d 改为按来源 client 映射 `Object.fromEntries(SOURCE_KEYS.map(name => [name, createHttpClient(sources[name].tokenEnv)]))`，与修复记录一致
3. 【轻微】400 消息在共享 client 上对 youtrack 也提示 wiki 措辞 → 400 消息加 `（${tokenEnvName}）` 标注来源，两种来源各自的 400 都指向对应 token 环境变量
4. 【轻微】Task 7 插入结构：插入内容无首尾 `---` 导致"给页面添加评论"与"## 前置条件"之间无分隔 → 插入位置明确为"已有 `---` 之后"，插入内容以 `---` 结尾（章节间恰好一个分隔线）；add_comment 章节补"### 错误处理"小节

**审查修复记录（2026-08-04 第六轮）**：
1. 【阻断·实测确认】Task 6 评论端点 `POST /rest/api/content/{id}/comment` 在该实例（nginx 反代的老版本 Confluence Server）返回 404 `null for uri`。本机实测复现：子资源端点 404、通用端点 `POST /rest/api/content` 200（评论 231510275，已删）、`DELETE /rest/api/content/{commentId}` 204。Task 6 改用通用端点 + `container.type: "page"`，并注明禁止"优化回"子资源端点
2. Task 4 '缺省 source 仍走注册表 youtrack' 测试假阳性（只做负面断言，实现前 TypeError 被吞时也通过）→ 增加 `youtrackCalled === 1` 正面断言
3. resolveEnv 的 urlEnv 覆盖分支无测试 → 新增 'urlEnv 环境变量覆盖默认 URL' 测试
4. Task 1 Step 3 失败预期未提 400 测试的失败方式 → 描述补全（401/400 两个新测试各自的失败原因）
