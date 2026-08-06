# promptTemplate 规则级占位符 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 promptTemplate 增加规则级占位符 `{labels}` / `{not_labels}`，替换值来自 config.json 规则的 labels/notLabels，运行时替换后再传给 Agent，改配置无需改模板。

**Architecture:** 显式扩展 `src/template.js` 的 `renderTemplate(content, { youtrackId, wikiUrl, labels, notLabels })` 签名，规则级参数存在即替换（含空字符串）；`src/main.js` runCycle 渲染处用 `rule.labels.join(', ')` / `rule.notLabels.join(', ')` 组装。任务级占位符行为不变。示例模板与 README 同步改用新占位符演示。

**Tech Stack:** Node.js（CommonJS，零依赖）、node:test。

## Global Constraints

- 零依赖：只允许 Node.js 内置模块（node:test、assert、fs、os、path）
- 与现有代码风格一致：CommonJS、`require`、中文错误消息/日志、`replaceAll`（Node ≥ 18）
- 提交纪律：只 `git add` 本任务产生的文件，绝不 `git add -A`（仓库有 .pi/、temp.zip 等未跟踪文件）
- 设计文档：`docs/superpowers/specs/2026-08-05-rule-placeholders-design.md`（已批准，实现以此为准）
- 测试框架：`node --test`（`npm test`），测试不访问真实服务

---

### Task 1: template.js 规则级占位符

**Files:**
- Modify: `src/template.js`
- Test: `test/template.test.js`

**Interfaces:**
- Consumes: 无（独立纯函数）
- Produces: `renderTemplate(content, { youtrackId, wikiUrl, labels, notLabels })` → string。任务级参数（youtrackId/wikiUrl）undefined/null 时不替换；规则级参数（labels/notLabels）undefined/null 时不替换，非空字符串（含空字符串 `''`）时替换。`labels`/`notLabels` 为已 join 好的字符串（join 由调用方 main.js 负责）

- [ ] **Step 1: 在 `test/template.test.js` 末尾追加失败测试**

```js
test('替换 {labels} 为逗号连接后的字符串', () => {
  assert.strictEqual(
    renderTemplate('任务须满足标签 {labels}', { labels: 'ready, explorer' }),
    '任务须满足标签 ready, explorer'
  );
});

test('替换 {not_labels} 为逗号连接后的字符串', () => {
  assert.strictEqual(
    renderTemplate('完成后打上 {not_labels} 标签', { notLabels: 'explored' }),
    '完成后打上 explored 标签'
  );
});

test('labels 为空字符串时替换为空', () => {
  assert.strictEqual(renderTemplate('标记 {labels}', { labels: '' }), '标记 ');
});

test('未提供 labels/notLabels 时保留原样', () => {
  assert.strictEqual(
    renderTemplate('打上 {not_labels} 与 {labels}', { youtrackId: 'CS-1' }),
    '打上 {not_labels} 与 {labels}'
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/template.test.js`
Expected: 新增 4 个用例 FAIL（`{labels}`/`{not_labels}` 未被替换，断言不匹配）；现有用例全部 PASS

- [ ] **Step 3: 实现 `src/template.js`**

```js
function renderTemplate(content, { youtrackId, wikiUrl, labels, notLabels } = {}) {
  let result = content;
  if (youtrackId !== undefined && youtrackId !== null) {
    result = result.replaceAll('{youtrack_id}', youtrackId);
  }
  if (wikiUrl !== undefined && wikiUrl !== null) {
    result = result.replaceAll('{wiki_url}', wikiUrl);
  }
  if (labels !== undefined && labels !== null) {
    result = result.replaceAll('{labels}', labels);
  }
  if (notLabels !== undefined && notLabels !== null) {
    result = result.replaceAll('{not_labels}', notLabels);
  }
  return result;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/template.test.js`
Expected: 全部 PASS（原有 9 个 + 新增 4 个）

- [ ] **Step 5: 提交**

```bash
git add src/template.js test/template.test.js
git commit -m "feat: renderTemplate 支持规则级占位符 {labels}/{not_labels}"
```

---

### Task 2: main.js runCycle 组装规则级值 + 集成测试

**Files:**
- Modify: `src/main.js`（runCycle 内 renderTemplate 调用处）
- Test: `test/main.test.js`

**Interfaces:**
- Consumes: `renderTemplate(content, { youtrackId, wikiUrl, labels, notLabels })`（Task 1）；`rule` 形状 `{ source, labels: string[], notLabels: string[], assignee?, promptTemplate }`（loadConfig 保证 notLabels 缺省 `[]`）
- Produces: 无新接口（runCycle 行为变更：渲染后的 prompt 含规则级占位符替换值）

- [ ] **Step 1: 在 `test/main.test.js` 末尾追加失败测试**

```js
test('runCycle：模板渲染规则级占位符 {labels}/{not_labels}', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
  const templatePath = path.join(dir, 'rule.md');
  fs.writeFileSync(templatePath, '任务须满足 {labels}，完成后打上 {not_labels}', 'utf8');
  const config = {
    intervalSeconds: 60,
    sessionDir: dir,
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
    runPi: async (p) => { prompt = p; return { exitCode: 0 }; },
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
    sessionDir: dir,
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
    runPi: async (p) => { prompt = p; return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.strictEqual(prompt, '完成后打上 ');
});
```

注意：第二个用例的 `notLabels: []` 需与第一个用例的规则定义区分——直接构造 config（不经 loadConfig）时规则对象需含 `notLabels` 字段（`[]`），因为 main.js 直接读 `rule.notLabels.join`。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/main.test.js`
Expected: 新增 2 个用例 FAIL（prompt 仍含字面量 `{labels}`/`{not_labels}`）；现有用例全部 PASS

- [ ] **Step 3: 实现 `src/main.js`**

将 runCycle 中 renderTemplate 调用改为：

```js
      const prompt = renderTemplate(template, {
        youtrackId: task.idReadable,
        wikiUrl: task.url,
        labels: rule.labels.join(', '),
        notLabels: rule.notLabels.join(', '),
      });
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/main.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: 全部 PASS（template、main、filter、config、sources、wiki、youTrack、piRunner、smoke）

- [ ] **Step 6: 提交**

```bash
git add src/main.js test/main.test.js
git commit -m "feat: runCycle 组装规则级占位符值 {labels}/{not_labels}"
```

---

### Task 3: 示例模板与 README 改用规则级占位符

**Files:**
- Modify: `templates/yt-explorer.md`
- Modify: `templates/wiki-exploer.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: 规则级占位符 `{not_labels}`（Task 1/2 已实现）
- Produces: 文档与示例模板演示新占位符用法

- [ ] **Step 1: 修改 `templates/yt-explorer.md`**

将 Output format 节中的：

```
***将内容输出到该 youtrack 任务的评论区，并为该任务打上 `explored` 的标签***：
```

改为：

```
***将内容输出到该 youtrack 任务的评论区，并为该任务打上 `{not_labels}` 的标签***：
```

- [ ] **Step 2: 修改 `templates/wiki-exploer.md`**

同样的替换（该文件末尾原文：`并为该任务打上 \`explored\` 的标签`，改为 `并为该任务打上 \`{not_labels}\` 的标签`）。

- [ ] **Step 3: 修改 `README.md`**

将「模板占位符」节：

```markdown
### 模板占位符

模板是 pi 的 prompt 文件，支持两个占位符，缺省不替换（原样保留）：

- `{youtrack_id}`：YouTrack 任务的 `idReadable`（如 `CS-1`）；wiki 任务下为页面 id
- `{wiki_url}`：Wiki 页面的完整 URL（仅 wiki 任务有值）
```

改为：

```markdown
### 模板占位符

模板是 pi 的 prompt 文件，支持四类占位符。任务级占位符缺省不替换（原样保留）；规则级占位符替换值来自规则配置，改 config.json 无需改模板：

- `{youtrack_id}`：YouTrack 任务的 `idReadable`（如 `CS-1`）；wiki 任务下为页面 id
- `{wiki_url}`：Wiki 页面的完整 URL（仅 wiki 任务有值）
- `{labels}`：规则配置 `labels` 的逗号连接（如 `ready, explorer`）
- `{not_labels}`：规则配置 `notLabels` 的逗号连接（未配置时替换为空字符串）
```

- [ ] **Step 4: 全量回归**

Run: `npm test`
Expected: 全部 PASS（模板文件与 README 不影响测试，确认无回归）

- [ ] **Step 5: 提交**

```bash
git add templates/yt-explorer.md templates/wiki-exploer.md README.md
git commit -m "docs: 示例模板与 README 改用规则级占位符 {not_labels}"
```

---

## 执行后注记（2026-08-05）

- Task 3 计划前提偏差：`templates/yt-explorer.md`、`templates/wiki-exploer.md` 在 base 上并非被跟踪文件（config.example.json 悬空引用它们），计划写"Modify"实际为首次纳入 git。最终审查发现后，经用户确认**不提交这两个模板**，撤销跟踪（保留工作区文件，含 `{not_labels}` 替换后的内容）；README 修改保留（commit 7753b69）。
