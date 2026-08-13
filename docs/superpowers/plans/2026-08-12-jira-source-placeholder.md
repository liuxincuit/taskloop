# jira 来源与占位符泛化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 jira 任务来源（按标签抓取），同时把模板占位符从硬编码改为来源注册表声明（对称补全占位符），并建立版本号变更规则（本次 0.1.0 → 0.2.0）。

**Architecture:** 来源注册表驱动——`sources.js` 每个来源自带 `placeholders` 映射（占位符名 → task 取值函数），`buildPlaceholders(sourceName, task, rule)` 组装占位符值表；`template.js` 的 `renderTemplate` 泛化为通用替换（不再知道任何具体占位符）；`main.js` 渲染处改为按来源组装。jira 抓取复用 `createHttpClient` 依赖注入。

**Tech Stack:** Node.js 内置模块（node:http/https/fs/path）、node:test + node:assert、CommonJS。零第三方依赖。

## Global Constraints

- 零第三方依赖：只允许 Node 内置模块，禁止 npm install
- CommonJS：`require` / `module.exports`，不写 ESM
- 中文错误消息（src/ 校验错误消息被 test/ 正则断言，改措辞会挂测试）
- 新来源遵循注册表模式：`src/<name>.js` 导出 `fetchTasks(rule, {httpClient, url, token})`，在 `src/sources.js` 注册
- 测试用 node:test + node:assert（`npm test` 自动发现 test/*.test.js），全绿才能 commit
- commit 用 conventional 风格（feat:/fix:/refactor:/docs:/chore:）
- 版本规则（本次起生效）：完成一项改造的收尾提交按改造性质升 `package.json` version（feat→minor、fix/refactor→patch、破坏性→major）；仅改 docs/test/模板不升；本次改造完成后 `0.1.0 → 0.2.0`，中间提交不升
- 任务占位符无值时不替换（原样保留）；规则级 `{labels}`、`{not_labels}` 与来源无关，所有来源统一注入

---

### Task 1: jira 任务来源抓取（src/jira.js）

**Files:**
- Create: `test/jira.test.js`
- Create: `src/jira.js`

**Interfaces:**
- Consumes: `src/youTrack.js` 的 `createHttpClient(tokenEnvName)`（返回 `(url, {token, timeoutMs}) => Promise<JSON>`，GET only，401/400 错误消息指向 tokenEnvName）
- Produces: `buildJql(rule)` → JQL 字符串；`fetchTasks(rule, { httpClient, url, token })` → `[{ id, idReadable, title, url, labels }]`（规则结构 `{ labels, notLabels, assignee }`）

- [ ] **Step 1: 写失败测试**

创建 `test/jira.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildJql, fetchTasks } = require('../src/jira.js');

test('buildJql：多标签生成 labels IN', () => {
  assert.strictEqual(
    buildJql({ labels: ['ready', 'explorer'] }),
    'labels IN ("ready", "explorer")'
  );
});

test('buildJql：notLabels 生成 labels NOT IN', () => {
  assert.strictEqual(
    buildJql({ labels: ['ready'], notLabels: ['explored', 'done'] }),
    'labels IN ("ready") AND labels NOT IN ("explored", "done")'
  );
});

test('buildJql：assignee 为 me 映射 currentUser', () => {
  assert.strictEqual(
    buildJql({ labels: ['ready'], assignee: 'me' }),
    'labels IN ("ready") AND assignee = currentUser()'
  );
});

test('buildJql：具名 assignee', () => {
  assert.strictEqual(
    buildJql({ labels: ['ready'], assignee: 'zhangsan' }),
    'labels IN ("ready") AND assignee = "zhangsan"'
  );
});

test('buildJql：标签内双引号转义', () => {
  assert.strictEqual(
    buildJql({ labels: ['he said "hi"'] }),
    'labels IN ("he said \\"hi\\"")'
  );
});

test('fetchTasks：拼装 search URL 并映射任务', async () => {
  const calls = [];
  const httpClient = async (url, opts) => {
    calls.push({ url: url.toString(), opts });
    return {
      issues: [
        { id: '10001', key: 'ISVJ-12228', fields: { summary: '五星缺陷', labels: ['2026M8-1'] } },
      ],
    };
  };
  const tasks = await fetchTasks(
    { labels: ['2026M8-1'] },
    { httpClient, url: 'https://jira.supermap.work', token: 't' }
  );
  const u = new URL(calls[0].url);
  assert.strictEqual(u.pathname, '/rest/api/2/search');
  assert.strictEqual(u.searchParams.get('jql'), 'labels IN ("2026M8-1")');
  assert.strictEqual(u.searchParams.get('fields'), 'key,summary,labels');
  assert.strictEqual(u.searchParams.get('maxResults'), '100');
  assert.deepStrictEqual(tasks, [{
    id: '10001',
    idReadable: 'ISVJ-12228',
    title: '五星缺陷',
    url: 'https://jira.supermap.work/browse/ISVJ-12228',
    labels: ['2026M8-1'],
  }]);
});

test('fetchTasks：空结果返回空数组', async () => {
  const tasks = await fetchTasks(
    { labels: ['x'] },
    { httpClient: async () => ({}), url: 'https://jira.supermap.work', token: 't' }
  );
  assert.deepStrictEqual(tasks, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/jira.test.js`
Expected: FAIL，`Cannot find module '../src/jira.js'`

- [ ] **Step 3: 实现 src/jira.js**

创建 `src/jira.js`：

```js
const { createHttpClient } = require('./youTrack.js');

function escapeJql(value) {
  return value.replace(/"/g, '\\"');
}

function buildJql(rule) {
  const parts = [`labels IN (${rule.labels.map((l) => `"${escapeJql(l)}"`).join(', ')})`];
  if (rule.notLabels && rule.notLabels.length > 0) {
    parts.push(`labels NOT IN (${rule.notLabels.map((l) => `"${escapeJql(l)}"`).join(', ')})`);
  }
  if (rule.assignee) {
    parts.push(rule.assignee === 'me' ? 'assignee = currentUser()' : `assignee = "${escapeJql(rule.assignee)}"`);
  }
  return parts.join(' AND ');
}

async function fetchTasks(rule, { httpClient = createHttpClient('SUPERMAP_JIRA_TOKEN'), url, token }) {
  const searchUrl = new URL('/rest/api/2/search', url);
  searchUrl.searchParams.set('jql', buildJql(rule));
  searchUrl.searchParams.set('fields', 'key,summary,labels');
  searchUrl.searchParams.set('maxResults', '100');
  const data = await httpClient(searchUrl, { token });
  return (data?.issues || []).map((issue) => ({
    id: issue.id,
    idReadable: issue.key,
    title: issue.fields?.summary,
    url: `${searchUrl.origin}/browse/${issue.key}`,
    labels: issue.fields?.labels || [],
  }));
}

module.exports = { buildJql, fetchTasks };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/jira.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: 现有测试全部通过（新文件不影响现有行为）

- [ ] **Step 6: Commit**

```bash
git add src/jira.js test/jira.test.js
git commit -m "feat: 新增 jira 任务来源抓取（buildJql + fetchTasks）"
```

---

### Task 2: 来源注册表声明占位符并注册 jira

**Files:**
- Modify: `src/sources.js`（三个来源加 placeholders、jira 注册行、导出 buildPlaceholders）
- Modify: `test/sources.test.js`（SOURCE_KEYS 加 jira、注册项与 placeholders 断言、buildPlaceholders 断言）
- Modify: `test/config.test.js:133-139`（"source 为非法值"用例把 `source: 'jira'` 改为 `source: 'github'`，因为 jira 注册后不再是非法值）

**Interfaces:**
- Consumes: Task 1 的 `src/jira.js` `fetchTasks`
- Produces: `buildPlaceholders(sourceName, task, rule)` → `{ [占位符名]: string }`（key 不带花括号，含统一注入的 `labels`、`not_labels`）；`sources[<name>].placeholders`（占位符名 → `(task) => value`）

- [ ] **Step 1: 改测试（预期失败）**

更新 `test/sources.test.js` 全文为：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { sources, SOURCE_KEYS, buildPlaceholders } = require('../src/sources.js');

test('注册表包含 youtrack、wiki、jira 三个来源', () => {
  assert.deepStrictEqual(SOURCE_KEYS, ['youtrack', 'wiki', 'jira']);
  assert.strictEqual(typeof sources.youtrack.fetchTasks, 'function');
  assert.strictEqual(typeof sources.wiki.fetchTasks, 'function');
  assert.strictEqual(typeof sources.jira.fetchTasks, 'function');
  assert.strictEqual(sources.youtrack.tokenEnv, 'SUPERMAP_YOUTRACK_TOKEN');
  assert.strictEqual(sources.youtrack.defaultUrl, 'http://yt.ispeco.com:8099');
  assert.strictEqual(sources.wiki.tokenEnv, 'SUPERMAP_WIKI_TOKEN');
  assert.strictEqual(sources.wiki.defaultUrl, 'https://wiki.ispeco.com');
  assert.strictEqual(sources.jira.tokenEnv, 'SUPERMAP_JIRA_TOKEN');
  assert.strictEqual(sources.jira.urlEnv, 'JIRA_URL');
  assert.strictEqual(sources.jira.defaultUrl, 'https://jira.supermap.work');
});

test('占位符声明：youtrack 提供 id 与 url', () => {
  const task = { idReadable: 'CS-1', url: 'http://yt' };
  assert.strictEqual(sources.youtrack.placeholders.youtrack_id(task), 'CS-1');
  assert.strictEqual(sources.youtrack.placeholders.youtrack_url(task), 'http://yt');
});

test('占位符声明：wiki 提供 id 与 url', () => {
  const task = { idReadable: '123', url: 'http://w' };
  assert.strictEqual(sources.wiki.placeholders.wiki_id(task), '123');
  assert.strictEqual(sources.wiki.placeholders.wiki_url(task), 'http://w');
});

test('占位符声明：jira 提供 id 与 url', () => {
  const task = { idReadable: 'ISVJ-1', url: 'http://j' };
  assert.strictEqual(sources.jira.placeholders.jira_id(task), 'ISVJ-1');
  assert.strictEqual(sources.jira.placeholders.jira_url(task), 'http://j');
});

test('buildPlaceholders：来源占位符 + 规则级占位符', () => {
  const rule = { labels: ['a', 'b'], notLabels: ['c'] };
  const task = { idReadable: 'ISVJ-1', url: 'http://j' };
  assert.deepStrictEqual(buildPlaceholders('jira', task, rule), {
    jira_id: 'ISVJ-1',
    jira_url: 'http://j',
    labels: 'a, b',
    not_labels: 'c',
  });
});

test('buildPlaceholders：notLabels 为空时 not_labels 为空字符串', () => {
  const rule = { labels: ['a'], notLabels: [] };
  const task = { idReadable: 'CS-1', url: 'http://yt' };
  assert.deepStrictEqual(buildPlaceholders('youtrack', task, rule), {
    youtrack_id: 'CS-1',
    youtrack_url: 'http://yt',
    labels: 'a',
    not_labels: '',
  });
});
```

同时把 `test/config.test.js` 的"source 为非法值时报错"用例中 `source: 'jira'` 改为 `source: 'github'`（该用例断言 `/source/` 报错，其他不变）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sources.test.js test/config.test.js`
Expected: FAIL（`SOURCE_KEYS` 断言不符；config 用例 jira 未注册仍抛错但 sources 用例已失败）

- [ ] **Step 3: 实现 src/sources.js**

更新 `src/sources.js` 全文为：

```js
const { fetchTasks } = require('./youTrack.js');
const { fetchWikiTasks } = require('./wiki.js');
const { fetchTasks: fetchJiraTasks } = require('./jira.js');

// 新增来源：创建 src/<name>.js 导出 fetchTasks(rule, {httpClient, url, token})，
// 然后在此注册一行（fetch 实现 + token 环境变量名 + URL 环境变量名 + 默认 URL + placeholders）
const sources = {
  youtrack: {
    fetchTasks,
    tokenEnv: 'SUPERMAP_YOUTRACK_TOKEN',
    urlEnv: 'YOUTRACK_URL',
    defaultUrl: 'http://yt.ispeco.com:8099',
    placeholders: {
      youtrack_id: (task) => task.idReadable,
      youtrack_url: (task) => task.url,
    },
  },
  wiki: {
    fetchTasks: fetchWikiTasks,
    tokenEnv: 'SUPERMAP_WIKI_TOKEN',
    urlEnv: 'WIKI_URL',
    defaultUrl: 'https://wiki.ispeco.com',
    placeholders: {
      wiki_id: (task) => task.idReadable,
      wiki_url: (task) => task.url,
    },
  },
  jira: {
    fetchTasks: fetchJiraTasks,
    tokenEnv: 'SUPERMAP_JIRA_TOKEN',
    urlEnv: 'JIRA_URL',
    defaultUrl: 'https://jira.supermap.work',
    placeholders: {
      jira_id: (task) => task.idReadable,
      jira_url: (task) => task.url,
    },
  },
};

const SOURCE_KEYS = Object.keys(sources);

// 按来源组装占位符值表：来源占位符 + 规则级占位符（labels / not_labels）
function buildPlaceholders(sourceName, task, rule) {
  const map = {};
  for (const [name, fn] of Object.entries(sources[sourceName].placeholders)) {
    map[name] = fn(task);
  }
  map.labels = rule.labels.join(', ');
  map.not_labels = rule.notLabels.join(', ');
  return map;
}

module.exports = { sources, SOURCE_KEYS, buildPlaceholders };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/sources.test.js test/config.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: 全部通过（main 仍用旧 renderTemplate 参数，行为未变）

- [ ] **Step 6: Commit**

```bash
git add src/sources.js test/sources.test.js test/config.test.js
git commit -m "feat: 来源注册表声明占位符并注册 jira 来源"
```

---

### Task 3: renderTemplate 泛化 + main 按来源组装

**Files:**
- Modify: `src/template.js:48-62`（renderTemplate 泛化）
- Modify: `src/main.js`（import buildPlaceholders；渲染处一行）
- Modify: `test/template.test.js`（参数名更新 + 新增断言）

**Interfaces:**
- Consumes: Task 2 的 `buildPlaceholders(sourceName, task, rule)`
- Produces: `renderTemplate(content, values)`（values 为 `{ [占位符名]: string }`，key 不带花括号，undefined/null 跳过）；`renderTemplateFile(templatePath, placeholders)` 签名不变

- [ ] **Step 1: 改测试（预期失败）**

`test/template.test.js` 采用**最小修改**而非全文替换：原有 include 相关用例（`expandIncludes` / `renderTemplateFile`，文件后半部分）**全部保留**，只做两处参数名同步（见下）。占位符相关用例（文件前半部分）逐项修改参数名并新增断言。修改后的占位符用例部分如下（`测试名`与原有保持一致，仅参数名变化）：

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, expandIncludes, renderTemplateFile } = require('../src/template.js');

test('替换 {youtrack_id} 为 idReadable', () => {
  assert.strictEqual(
    renderTemplate('请处理任务 {youtrack_id}', { youtrack_id: 'CS-1234' }),
    '请处理任务 CS-1234'
  );
});

test('替换 {youtrack_url}', () => {
  assert.strictEqual(
    renderTemplate('任务链接 {youtrack_url}', { youtrack_url: 'http://yt/issue/CS-1' }),
    '任务链接 http://yt/issue/CS-1'
  );
});

test('替换 {wiki_id}', () => {
  assert.strictEqual(
    renderTemplate('页面 id {wiki_id}', { wiki_id: '123' }),
    '页面 id 123'
  );
});

test('多处占位符全部替换', () => {
  assert.strictEqual(
    renderTemplate('{youtrack_id} 和 {youtrack_id}', { youtrack_id: 'CS-1' }),
    'CS-1 和 CS-1'
  );
});

test('无占位符时原样返回', () => {
  const content = '没有占位符的文本';
  assert.strictEqual(renderTemplate(content, { youtrack_id: 'CS-1' }), content);
});

test('入参内容不被修改', () => {
  const content = '任务 {youtrack_id}';
  renderTemplate(content, { youtrack_id: 'CS-1' });
  assert.strictEqual(content, '任务 {youtrack_id}');
});

test('替换 {wiki_url} 为页面 URL', () => {
  assert.strictEqual(
    renderTemplate('读取页面 {wiki_url}', { wiki_url: 'https://wiki.ispeco.com/pages/viewpage.action?pageId=111' }),
    '读取页面 https://wiki.ispeco.com/pages/viewpage.action?pageId=111'
  );
});

test('多种占位符同时替换', () => {
  assert.strictEqual(
    renderTemplate('任务 {youtrack_id} 页面 {wiki_url}', { youtrack_id: 'CS-1', wiki_url: 'http://w' }),
    '任务 CS-1 页面 http://w'
  );
});

test('wikiUrl 未提供时不替换 {wiki_url}', () => {
  assert.strictEqual(renderTemplate('{wiki_url}', { youtrack_id: 'CS-1' }), '{wiki_url}');
});

test('youtrackId 未提供时不替换 {youtrack_id}', () => {
  assert.strictEqual(renderTemplate('{youtrack_id}', { wiki_url: 'http://w' }), '{youtrack_id}');
});

test('未提供的占位符原样保留（通用机制）', () => {
  assert.strictEqual(renderTemplate('{jira_id}', {}), '{jira_id}');
});

test('通用占位符替换', () => {
  assert.strictEqual(renderTemplate('{a} 和 {b}', { a: '1', b: '2' }), '1 和 2');
});

test('替换 {labels} 为逗号连接后的字符串', () => {
  assert.strictEqual(
    renderTemplate('任务须满足标签 {labels}', { labels: 'ready, explorer' }),
    '任务须满足标签 ready, explorer'
  );
});

test('替换 {not_labels}', () => {
  assert.strictEqual(
    renderTemplate('完成后打上 {not_labels} 标签', { not_labels: 'explored' }),
    '完成后打上 explored 标签'
  );
});

test('labels 为空字符串时替换为空', () => {
  assert.strictEqual(renderTemplate('标记 {labels}', { labels: '' }), '标记 ');
});

test('未提供时 {not_labels} 与 {labels} 原样保留', () => {
  assert.strictEqual(renderTemplate('打上 {not_labels} 与 {labels}', { youtrack_id: 'CS-1' }), '打上 {not_labels} 与 {labels}');
});
```

（以上为占位符用例部分的最终形态。**原有 include 用例（文件后半部分 13 个）全部保留、不改结构**，仅两处参数名同步：`expandIncludes：展开后片段内占位符可被 renderTemplate 替换` 的 `{ notLabels: 'explored' }` 改为 `{ not_labels: 'explored' }`；`renderTemplateFile：读文件 + include + 占位符全链路` 的 `{ youtrackId: 'CS-1', notLabels: 'explored' }` 改为 `{ youtrack_id: 'CS-1', not_labels: 'explored' }`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/template.test.js`
Expected: FAIL（旧实现解构 `youtrackId` 等 key，新参数名不匹配）

- [ ] **Step 3: 改 src/template.js 与 src/main.js**

`src/template.js` 中 `renderTemplate` 改为：

```js
function renderTemplate(content, values = {}) {
  let result = content;
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) {
      result = result.replaceAll(`{${name}}`, value);
    }
  }
  return result;
}
```

其余（`expandIncludes`、`renderTemplateFile`、导出）不变。

`src/main.js`：
- 第 4 行 import 改为：`const { sources, SOURCE_KEYS, buildPlaceholders } = require('./sources.js');`
- 渲染处（约 86 行）改为：

```js
prompt = renderTemplateFile(rule.promptTemplate, buildPlaceholders(sourceName, task, rule));
```

`sourceName` 为该循环前已定义的变量（`rule.source ?? 'youtrack'`），无需新增。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/template.test.js test/sources.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 全量回归（重点 main.test.js）**

Run: `npm test`
Expected: 全部通过——main.test.js 的 prompt 断言（如 `'处理任务 CS-1'`）依赖模板 `{youtrack_id}` 与 `buildPlaceholders('youtrack', task, rule)` 的 `youtrack_id` 值，行为不变；`{labels}`/`{not_labels}` 断言同理

- [ ] **Step 6: Commit**

```bash
git add src/template.js src/main.js test/template.test.js
git commit -m "refactor: renderTemplate 泛化为通用占位符替换，main 按来源组装占位符"
```

---

### Task 4: 文档、版本规则与版本号收尾

**Files:**
- Modify: `README.md`（来源表 17-20 行加 jira 行；占位符章节 133-138 行改按来源列表；「扩展新来源」示例同步）
- Modify: `AGENTS.md`（占位符约定更新；新增版本规则）
- Modify: `config.example.json`（加 jira 示例规则）
- Modify: `package.json`（version `0.1.0` → `0.2.0`）

**Interfaces:** 无代码接口；本任务不产生 src/ 改动，按版本规则 B 在收尾提交升版本。

- [ ] **Step 1: 更新 README.md**

1. 来源表（约 17-20 行）加一行：

```markdown
| `jira` | Supermap Jira | `/rest/api/2/search` 按标签（JQL `labels IN`）与指派查询 | `{jira_id}`、`{jira_url}` |
```

2. 「模板占位符」章节（约 133-138 行）改为：

```markdown
模板是所选 agent 的 prompt 文件，支持两类占位符。任务级占位符按来源由注册表声明（下表），缺省不替换（原样保留）；规则级占位符替换值来自规则配置，改 config.json 无需改模板：

任务级（按来源）：

- youtrack：`{youtrack_id}`（如 `CS-1`）、`{youtrack_url}`
- wiki：`{wiki_id}`（页面 id）、`{wiki_url}`（页面完整 URL）
- jira：`{jira_id}`（issue key，如 `ISVJ-12228`）、`{jira_url}`（browse 链接）

规则级（所有来源）：

- `{labels}`：规则 `labels` 的逗号连接
- `{not_labels}`：规则 `notLabels` 的逗号连接（未配置时替换为空字符串）
```

3. 「扩展新来源」示例（约 155-180 行）的注册示例同步为含 `placeholders` 字段的形态（参考 `src/sources.js` 实际代码）。

- [ ] **Step 2: 更新 AGENTS.md**

「项目约定」下新增版本规则，并更新占位符约定：

```markdown
- 版本号：修改 src/ 代码后，在该次改造的收尾提交按改造性质升 package.json version——feat（新功能）→ minor（0.1.0 → 0.2.0）、fix/refactor → patch、破坏性变更 → major；仅改 docs/、README、test/（补用例）、模板不升；不打 git tag
- 模板占位符：任务级占位符由来源注册表声明（youtrack: {youtrack_id}/{youtrack_url}；wiki: {wiki_id}/{wiki_url}；jira: {jira_id}/{jira_url}），无值时原样保留；规则级 {labels}、{not_labels} 替换自规则配置
```

（原占位符约定行替换为上述第二行。）

- [ ] **Step 3: 更新 config.example.json**

在 rules 数组末尾加：

```json
    {
      "source": "jira",
      "labels": ["taskloop"],
      "notLabels": ["explored"],
      "assignee": "me",
      "promptTemplate": "templates/analyze.md"
    }
```

- [ ] **Step 4: 全量回归**

Run: `npm test`
Expected: 全部通过

- [ ] **Step 5: 提交文档（不升版本）**

```bash
git add README.md AGENTS.md config.example.json
git commit -m "docs: 同步 jira 来源与占位符文档，新增版本号变更规则"
```

- [ ] **Step 6: 升级版本号（本次改造收尾，feat → minor）**

`package.json` 中 `"version": "0.1.0"` 改为 `"version": "0.2.0"`。

- [ ] **Step 7: 确认测试仍通过**

Run: `npm test`
Expected: 全部通过

- [ ] **Step 8: 提交版本号**

```bash
git add package.json
git commit -m "chore: 版本号升至 0.2.0（jira 来源与占位符泛化）"
```

---

## Self-Review

- **Spec 覆盖**：jira.js（Task 1）✓；sources.js placeholders + jira 注册 + buildPlaceholders（Task 2）✓；template 泛化 + main 切换（Task 3）✓；版本规则 + 0.2.0 + README/AGENTS.md/config.example.json（Task 4）✓；config.test.js 的 jira 非法值用例迁移（Task 2 Step 1）✓；错误处理复用 createHttpClient 无需改动 ✓
- **占位符扫描**：无 TBD/TODO；每个任务含完整代码与验证命令
- **类型一致性**：`buildPlaceholders(sourceName, task, rule)`、`renderTemplate(content, values)`、`fetchTasks(rule, {httpClient, url, token})` 在 Task 1-3 间签名一致；values key 统一不带花括号
- **中间态安全**：Task 1 纯新模块；Task 2 后 main 仍用旧参数（行为不变）；Task 3 的 template 与 main 同步切换于同一 commit
- **Task 3 测试改动为最小修改**：保留原文件全部 include 用例（13 个），仅改占位符用例参数名 + 新增断言（pre-flight 修正，避免全文替换误删用例）
