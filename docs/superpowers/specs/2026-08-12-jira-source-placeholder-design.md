# jira 任务来源与模板占位符泛化设计

日期：2026-08-12
状态：待用户审阅

## 背景与目标

1. **新增 jira 任务来源**：taskloop 目前只有 youtrack / wiki 两个来源，需要支持从 Supermap Jira 按标签抓取任务。
2. **模板占位符泛化**：`renderTemplate` 硬编码任务级占位符 `{youtrack_id}` / `{wiki_url}`，来源与占位符强耦合，新来源无法获得任务级占位符能力。本次与 jira 一起处理，改为来源注册表声明占位符。
3. **版本号规则缺失**：仓库经过十余次功能/修复提交，`package.json` version 始终为 0.1.0，未追踪任何变更。需在 AGENTS.md 建立版本号变更规则并立即生效。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| jira 筛选方式 | 沿用现有 `labels` / `notLabels` / `assignee` 字段，映射 JQL（方案 A），不新增 project/jql 字段 |
| 占位符形态 | 来源注册表声明占位符（方案 A）：`sources.js` 每个来源自带占位符→取值映射，`renderTemplate` 通用替换 |
| 占位符集合 | 对称补全：youtrack 加 `{youtrack_url}`、wiki 加 `{wiki_id}`；jira 提供 `{jira_id}` / `{jira_url}`；规则级 `{labels}` / `{not_labels}` 不变 |
| 版本策略 | SemVer + commit 类型映射（feat→minor、fix/refactor→patch、破坏性→major、文档/纯测试→不升），不打 git tag |
| 本次版本 | 本次改造为 feat：实施后 `0.1.0 → 0.2.0` |
| 认证/地址 | Bearer token（`SUPERMAP_JIRA_TOKEN`），默认 `https://jira.supermap.work`，`JIRA_URL` 可覆盖 |
| API 版本 | 使用 `/rest/api/2/search`（与 supermap-jira skill 一致） |

## 已验证的事实（2026-08-12 实测 jira.supermap.work）

- `labels IS NOT EMPTY` 正常返回，实例支持 labels 字段
- `labels = "2026M8-1"` 精确返回 6 个任务
- `labels = "x" AND labels NOT IN ("y")` 排除语法生效
- issue 带 `labels` 与 `assignee` 字段（如 ISVJ-12228 labels: ["2026M8-1"]）
- 结论：jira 完整支持按 label 过滤（含排除），无需按产品/项目过滤

## 设计

### 1. `src/jira.js`（新文件）

```js
const { createHttpClient } = require('./youTrack.js');

function escapeJql(value) {
  return value.replace(/"/g, '\\"');
}

function buildJql(rule) {
  const parts = [`labels IN (${rule.labels.map((l) => `"${escapeJql(l)}"`).join(', ')})`];
  if (rule.notLabels?.length) {
    parts.push(`labels NOT IN (${rule.notLabels.map((l) => `"${escapeJql(l)}"`).join(', ')})`);
  }
  if (rule.assignee) {
    parts.push(rule.assignee === 'me' ? 'assignee = currentUser()' : `assignee = "${escapeJql(rule.assignee)}"`);
  }
  return parts.join(' AND ');
}
```

- `fetchTasks(rule, { httpClient = createHttpClient('SUPERMAP_JIRA_TOKEN'), url, token })`：
  - GET `{url}/rest/api/2/search`，query 参数：`jql`（buildJql 结果）、`fields=key,summary,labels`、`maxResults=100`
  - 映射：`{ id: issue.id, idReadable: issue.key, title: issue.fields.summary, url: `${origin}/browse/${issue.key}`, labels: issue.fields.labels }`，空结果返回 `[]`
- 复用 `createHttpClient`：401/400 错误消息自动指向 `SUPERMAP_JIRA_TOKEN`；依赖注入便于单测 mock

### 2. `src/sources.js`

- 每个来源注册项新增 `placeholders`（占位符名 → `(task) => value`）：
  - youtrack：`{ youtrack_id: (t) => t.idReadable, youtrack_url: (t) => t.url }`（`{youtrack_id}` 行为保持不变）
  - wiki：`{ wiki_id: (t) => t.idReadable, wiki_url: (t) => t.url }`（`{wiki_url}` 行为保持不变）
  - jira：`{ jira_id: (t) => t.idReadable, jira_url: (t) => t.url }`
- 新增注册行：`jira: { fetchTasks: jiraFetchTasks, tokenEnv: 'SUPERMAP_JIRA_TOKEN', urlEnv: 'JIRA_URL', defaultUrl: 'https://jira.supermap.work', placeholders }`
- 新增导出 `buildPlaceholders(sourceName, task, rule)`：遍历该来源 `placeholders` 求值，再统一注入 `labels: rule.labels.join(', ')`、`not_labels: rule.notLabels.join(', ')`

### 3. `src/template.js`

- `renderTemplate(content, values = {})` 泛化：遍历 `values` 的 `{占位符名: 值}`（key 不带花括号），`undefined`/`null` 跳过（未提供时占位符原样保留，语义不变），通用 `replaceAll` 替换
- `renderTemplateFile(templatePath, placeholders)` 签名不变（读文件 + 展开 include + 渲染）
- 现有行为不变：`{youtrack_id}`、`{wiki_url}`、`{labels}`、`{not_labels}` 替换规则与之前一致，仅参数名由驼峰改为与占位符同名

### 4. `src/main.js`

- 渲染处一行改动：`renderTemplateFile(rule.promptTemplate, buildPlaceholders(rule.source, task, rule))`
- main 不再知道任何具体占位符；`{labels}`/`{not_labels}` 由 `buildPlaceholders` 统一注入

### 5. AGENTS.md 版本规则（新增到「项目约定」）

```
- 修改 src/ 下任何文件后，必须同步更新 package.json 的 version 字段
- 版本变更规则（SemVer + commit 类型）：
  · feat（新功能）→ minor：0.1.0 → 0.2.0
  · fix / refactor → patch：0.2.0 → 0.2.1
  · 破坏性变更 → major：升到 1.0.0 起
  · 仅改 docs/、README、test/（补用例）、模板 → 不升
- 不打 git tag
```

本次改造为 feat：实施计划包含 `package.json` version `0.1.0 → 0.2.0` 一步，规则落地即生效。

## 错误处理

全部复用现有机制，零新增：
- 401 → "认证失败，请检查 SUPERMAP_JIRA_TOKEN"（createHttpClient 按 tokenEnv 生成消息）
- 400 → "HTTP 400: 查询语法错误，请检查规则配置与标签转义"（JQL 语法错误同路径）
- 模板渲染失败 → 跳过该任务并记日志（main.js 现有逻辑）

## 测试

| 文件 | 改动 |
|---|---|
| `test/jira.test.js`（新） | buildJql 单测：多标签 / notLabels / assignee=me 与具名 / 双引号转义；fetchTasks mock httpClient：URL 拼装（jql 编码、fields、maxResults）、任务映射、空结果返回 [] |
| `test/sources.test.js` | SOURCE_KEYS 断言加 jira（现为精确数组 `['youtrack', 'wiki']`）；jira 注册项与各来源 placeholders 断言 |
| `test/template.test.js` | 参数名更新（youtrackId→youtrack_id 等，约 13 处）；新增通用替换、`{youtrack_url}`/`{wiki_id}` 补全、无值保留断言 |
| `test/main.test.js` | 现有 prompt 断言应保持通过（模板占位符不变），回归确认 |

## 文档

- `README.md`：占位符章节改为按来源的完整表；「扩展新来源」示例同步 placeholders 与 jira 注册行；jira 已注册说明
- `AGENTS.md`：占位符约定从"`{youtrack_id}`、`{wiki_url}`"改为按来源；新增版本规则
- `config.example.json`：加一条 jira 示例规则（source: "jira" + labels + promptTemplate）

## 模板改造边界

- 现有模板（yt-explorer.md / wiki-exploer.md / analyze.md 等）**无需改动**，旧占位符行为不变
- 新增占位符按需使用（如 jira 模板写 `{jira_id}`）；个人模板不提交（.gitignore 忽略）
