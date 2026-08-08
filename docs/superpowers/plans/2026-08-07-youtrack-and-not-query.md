# YouTrack 服务端精确 AND/NOT 查询 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `buildQuery` 从 hashtag OR 粗查（`#a #b`）改为服务端精确 AND/NOT（`tag: {a} AND tag: {b} AND tag: -{c}`），本地 `filterTasks` 保留兜底。

**Architecture:** 只改 `src/youTrack.js` 的 `buildQuery` 输出格式（单函数），同步更新 `test/youTrack.test.js` 断言与 README 查询描述。数据流（fetchTasks → filterTasks → runPi）与来源注册表不动。

**Tech Stack:** Node.js ≥ 18（仅内置模块），node:test 单测。

## Global Constraints

- 只改 `src/youTrack.js`、`test/youTrack.test.js`、`README.md` 三个文件
- 不动 `filterTasks`、`wiki.js`、`sources.js`、`config.js`、`main.js`
- 不加配置开关、不加新抽象
- 负号必须写在花括号外（`tag: -{x}`）；禁止 `tag: {-x}`（实测 HTTP 400）
- 标签必须真实存在，否则查询 HTTP 400（沿用现有 createHttpClient 400 错误消息，README 已说明）
- 连接符统一为 ` AND `（大写）

---

### Task 1: buildQuery 输出改为 `tag: {x} AND ...` 精确 AND/NOT

**Files:**
- Modify: `src/youTrack.js`（buildQuery 函数）
- Test: `test/youTrack.test.js`

**Interfaces:**
- Consumes: 现有 `rule` 对象 `{ labels: string[], notLabels?: string[], assignee?: string }`
- Produces: `buildQuery(rule) => string`，格式 `tag: {a} AND tag: {b} AND tag: -{c} AND assignee: me`；labels 为空数组时返回 `''`

- [ ] **Step 1: 更新测试——改现有断言并新增 notLabels 用例**

将 `test/youTrack.test.js` 中以下断言整体替换：

```js
test('buildQuery：多个 labels 生成 tag AND 查询', () => {
  assert.strictEqual(buildQuery({ labels: ['readyed', 'clearly'] }),
    'tag: {readyed} AND tag: {clearly}');
});

test('buildQuery：assignee 为 me', () => {
  assert.strictEqual(
    buildQuery({ labels: ['readyed'], assignee: 'me' }),
    'tag: {readyed} AND assignee: me'
  );
});

test('buildQuery：assignee 为 login', () => {
  assert.strictEqual(
    buildQuery({ labels: ['readyed'], assignee: 'liuxin' }),
    'tag: {readyed} AND assignee: {liuxin}'
  );
});

test('buildQuery：无 assignee', () => {
  assert.strictEqual(buildQuery({ labels: ['readyed'] }), 'tag: {readyed}');
});

test('buildQuery：notLabels 生成排除段', () => {
  assert.strictEqual(
    buildQuery({ labels: ['a', 'b'], notLabels: ['c'] }),
    'tag: {a} AND tag: {b} AND tag: -{c}'
  );
});

test('buildQuery：多个 notLabels 各生成一个排除段', () => {
  assert.strictEqual(
    buildQuery({ labels: ['a'], notLabels: ['c', 'd'] }),
    'tag: {a} AND tag: -{c} AND tag: -{d}'
  );
});

test('buildQuery：空 notLabels 不生成排除段', () => {
  assert.strictEqual(buildQuery({ labels: ['a'], notLabels: [] }), 'tag: {a}');
});
```

同时更新 `fetchTasks：请求 URL 与返回结构映射` 中的 query 断言：

```js
  assert.strictEqual(calls[0].searchParams.get('query'), 'tag: {readyed} AND assignee: me');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test 2>&1 | grep -E "buildQuery|fetchTasks：请求 URL" | head -20`
Expected: buildQuery 相关用例 FAIL（输出仍为 `#readyed #clearly`，断言期望 `tag: {readyed} AND ...`）

- [ ] **Step 3: 实现 buildQuery**

将 `src/youTrack.js` 中 buildQuery 整体替换为：

```js
function buildQuery(rule) {
  // 服务端精确查询：`tag: {x}` 是 AND 语义（hashtag 空格分隔是 OR），
  // `tag: -{x}`（负号在花括号外）排除标签；负号在花括号内（tag: {-x}）会报 HTTP 400。
  const parts = rule.labels.map((label) => `tag: {${label}}`);
  for (const label of rule.notLabels || []) {
    parts.push(`tag: -{${label}}`);
  }
  if (rule.assignee) {
    parts.push(rule.assignee === 'me' ? 'assignee: me' : `assignee: {${rule.assignee}}`);
  }
  return parts.join(' AND ');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 80 + 3 新增 = 83 个用例全部 PASS（原 4 个 buildQuery 断言被替换为 7 个，净增 3）

- [ ] **Step 5: Commit**

```bash
git add src/youTrack.js test/youTrack.test.js
git commit -m "feat: buildQuery 改为服务端精确 AND/NOT（tag: {x} AND tag: -{x}）"
```

---

### Task 2: README 查询描述更新

**Files:**
- Modify: `README.md:26`（YouTrack 来源查询描述）

- [ ] **Step 1: 更新第 26 行**

将：

```markdown
- 查询：`#标签1 #标签2`（多标签是 OR 语义粗查，AND 精确匹配由本地 `filterTasks` 兜底），`assignee` 规则见下文
```

替换为：

```markdown
- 查询：`tag: {标签1} AND tag: {标签2} AND tag: -{排除标签}`（服务端精确 AND/NOT；`tag: -{x}` 的负号必须在花括号外），本地 `filterTasks` 仍兜底，`assignee` 规则见下文
```

- [ ] **Step 2: 通读 README 确认无其他 hashtag 描述残留**

Run: `rg -n "hashtag|#标签|OR 语义" README.md`
Expected: 无输出（README.md:19 表格中"按标签（hashtag）与指派查询"字样可保留，如不放心可改为"按标签与指派查询"）

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 更新 YouTrack 服务端精确 AND/NOT 查询描述"
```

---

### Task 3: 真实实例冒烟验证

**Files:** 无（临时脚本，验证后删除）

- [ ] **Step 1: 用现有 config 规则验证精确查询**

Run（git bash，需 SUPERMAP_YOUTRACK_TOKEN）：

```bash
cd /f/liuxin/temp/temp && node -e "
const { fetchTasks } = require('./src/youTrack.js');
(async () => {
  const rule = { labels: ['liuxinfc-ready', 'liuxinfc-explorer'], notLabels: ['liuxinfc-explored'], assignee: 'me' };
  const tasks = await fetchTasks(rule, { url: new URL('http://yt.ispeco.com:8099'), token: process.env.SUPERMAP_YOUTRACK_TOKEN });
  console.log('查询:', require('./src/youTrack.js').buildQuery(rule));
  console.log('返回', tasks.length, '条:', tasks.map(t => t.idReadable + '[' + t.labels.join(',') + ']').join(' '));
})();
"
```

Expected: 查询为 `tag: {liuxinfc-ready} AND tag: {liuxinfc-explorer} AND tag: -{liuxinfc-explored} AND assignee: me`，返回 1 条 `CS-5514[liuxinfc-ready,liuxinfc-explorer]`（改造前为 6 条）

- [ ] **Step 2: 顺带验证含空格标签的负向形式**

Run:

```bash
cd /f/liuxin/temp/temp && node -e "
const { createHttpClient } = require('./src/youTrack.js');
(async () => {
  const client = createHttpClient();
  const url = new URL('http://yt.ispeco.com:8099/api/issues');
  url.searchParams.set('query', 'tag: {alpha  10.1} AND tag: -{alpha  10.1}');
  try {
    await client(url, { token: process.env.SUPERMAP_YOUTRACK_TOKEN });
    console.log('含空格标签的 tag: -{x} 语法有效');
  } catch (e) { console.log('失败:', e.message); }
})();
"
```

Expected: 输出"含空格标签的 tag: -{x} 语法有效"或明确的 400 错误消息（记录结果即可，不阻塞本任务）

- [ ] **Step 3: 验证本地过滤兜底仍生效**

Run:

```bash
cd /f/liuxin/temp/temp && node -e "
const { fetchTasks } = require('./src/youTrack.js');
const { filterTasks } = require('./src/filter.js');
(async () => {
  const rule = { labels: ['liuxinfc-ready', 'liuxinfc-explorer'], notLabels: ['liuxinfc-explored'], assignee: 'me' };
  const tasks = await fetchTasks(rule, { url: new URL('http://yt.ispeco.com:8099'), token: process.env.SUPERMAP_YOUTRACK_TOKEN });
  console.log('本地过滤后:', filterTasks(tasks, rule.labels, rule.notLabels).map(t => t.idReadable).join(','));
})();
"
```

Expected: 输出 `本地过滤后: CS-5514`（与服务端一致）

- [ ] **Step 4: 提交说明（如冒烟发现问题则回 Task 1 修复）**

如全部通过，无需提交（无代码改动）。如有偏差，回到对应 Task 修复后重新跑 `npm test`。

---

## Self-Review 记录

- **Spec 覆盖**：buildQuery 输出变化 → Task 1；filterTasks 保留兜底 → Task 1/3（未改动，仅验证）；测试更新 → Task 1；README → Task 2；冒烟验证 → Task 3；含空格标签负向 → Task 3 Step 2
- **占位符扫描**：所有步骤含具体代码与预期输出，无 TBD
- **类型一致性**：buildQuery 签名不变（`rule` 入参、字符串返回），测试断言与实现格式逐字符一致（`tag: {x} AND tag: {y}`）
