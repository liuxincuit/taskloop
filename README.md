# taskloop

定时从多个任务来源按标签抓取任务，交给 AI Agent（pi / claude）非交互模式自动执行处理的循环 Worker。

零第三方依赖（仅 Node.js 内置模块），Node.js ≥ 18（需要 `String.prototype.replaceAll`）。

## 工作原理

1. 按固定间隔（`intervalSeconds`）循环执行每一轮
2. 每轮遍历 `config.json` 中的每条规则，从规则指定的来源（`source`）按标签抓取候选任务
3. 本地过滤：任务必须包含全部 `labels`，且不包含任何 `notLabels`
4. 对每个候选任务渲染 prompt 模板（模板可引用任务占位符），调用所选 agent（`config.json` 顶层 `agent` 字段，缺省 pi）非交互执行
5. 同一轮内相同任务只执行一次；抓取失败、模板读取失败均记日志并继续，不中断整轮

## 支持的来源

| 来源 key | 系统 | 抓取方式 | 模板占位符 |
| --- | --- | --- | --- |
| `youtrack` | YouTrack | `/api/issues` 按标签与指派查询 | `{youtrack_id}`、`{youtrack_url}` |
| `wiki` | Supermap Confluence Wiki | `/rest/api/search` 按创建者（creator）与标签（CQL）查询 | `{wiki_id}`、`{wiki_url}` |
| `jira` | Supermap Jira | `/rest/api/2/search` 按标签（JQL `labels IN`）与指派查询 | `{jira_id}`、`{jira_url}` |

来源与任务形状统一为：`{ id, idReadable, title, url, labels }`（`title`、`url` 可为空）。

### YouTrack 来源

- 查询：`tag: {标签1} AND tag: {标签2} AND tag: -{排除标签}`（服务端精确 AND/NOT；`tag: -{x}` 的负号必须在花括号外），本地 `filterTasks` 仍兜底，`assignee` 规则见下文
- 规则中的标签必须是 YouTrack 中已存在的标签，否则查询报 HTTP 400 语法错误
- `{youtrack_id}` 替换为任务的 `idReadable`（如 `CS-1`）

### Wiki 来源

- 查询：CQL `creator = currentUser() AND type = page AND label in (...)`，`includeArchivedSpaces=false`，最多 100 条
- 标签通过 `expand=content.metadata.labels` 随搜索结果带出；若实例不支持 expand，自动回退为逐页获取
- `{wiki_url}` 替换为页面地址（`https://<host>/pages/viewpage.action?pageId=<id>`）

### Jira 来源

- 查询：JQL `labels IN (...) [AND labels NOT IN (...)] [AND assignee = currentUser() | assignee = "用户名"]`，最多 100 条
- `{jira_id}` 替换为 issue key（如 `ISVJ-12228`）；`{jira_url}` 为 browse 链接（`https://<host>/browse/<key>`）

## 快速开始

### 1. 环境要求

- Node.js ≥ 18
- 所用 agent 的命令在 PATH 中可用：`pi`（缺省）或 `claude`

### 2. 配置环境变量

| 变量 | 必需性 | 说明 |
| --- | --- | --- |
| `SUPERMAP_YOUTRACK_TOKEN` | 使用 `youtrack` 规则时必需 | YouTrack API token |
| `SUPERMAP_WIKI_TOKEN` | 使用 `wiki` 规则时必需 | Confluence API token |
| `SUPERMAP_JIRA_TOKEN` | 使用 `jira` 规则时必需 | Jira API token |
| `YOUTRACK_URL` | 可选 | 覆盖默认地址 `http://yt.ispeco.com:8099` |
| `WIKI_URL` | 可选 | 覆盖默认地址 `https://wiki.ispeco.com` |
| `JIRA_URL` | 可选 | 覆盖默认地址 `https://jira.supermap.work` |

只对配置中实际使用到的来源要求 token：只配 wiki 规则时无需设置 `SUPERMAP_YOUTRACK_TOKEN`，反之亦然。token 缺失时启动即报错退出（`环境错误: 未设置 ...`）。

### 3. 创建本地配置

复制示例配置为 `config.json`（已被 .gitignore 忽略，不会提交）：

```bash
cp config.example.json config.json
```

然后按需修改 `config.json`。完整字段说明见下文「配置详解」。

### 4. 运行

```bash
node src/main.js                 # 使用默认 config.json
node src/main.js /path/to/my-config.json
```

Ctrl+C 会优雅退出：停止新轮次、终止正在执行的 agent 子进程（Windows 下强制结束进程树）。

## 配置详解

### config.json 顶层字段

| 字段 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `intervalSeconds` | 否 | `60` | 轮询间隔（正整数，秒） |
| `agent` | 否 | `pi` | 执行 agent 的注册表 key，目前 `pi` / `claude`；非法值启动报错并列出合法值 |
| `rules` | 是 | — | 规则数组，非空 |

### agent 专属配置块

顶层 `{agent}` 命名的对象（如 `pi`、`claude`）存放该 agent 的专属配置，只允许注册表声明的字段，出现未声明字段启动报错：

#### `pi` 块

| 字段 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `sessionDir` | 否 | config 文件所在目录 | pi 会话保存目录（相对配置文件解析） |
| `path` | 否 | `pi` | pi 可执行文件命令名或完整路径 |

```json
{
  "agent": "pi",
  "pi": { "sessionDir": "./.pi-sessions", "path": "pi" }
}
```

#### `claude` 块

| 字段 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `path` | 否 | `claude` | claude 可执行文件命令名或完整路径 |

```json
{
  "agent": "claude",
  "claude": { "path": "claude" }
}
```

切换 agent 只需改 `agent` 字段并重写对应配置块。

### 规则字段（`rules[]`）

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `source` | 否 | 来源 key，缺省 `youtrack`；非法值报错（`rules[i].source 必须是 "youtrack" 或 "wiki" 或 "jira"`） |
| `labels` | 是 | 非空字符串数组；任务必须**全部**包含这些标签（AND） |
| `notLabels` | 否 | 字符串数组；任务包含任一标签即被排除 |
| `assignee` | 否 | 来源语义不同，见下 |
| `promptTemplate` | 是 | 模板文件路径（相对配置文件解析），文件必须存在 |

### assignee 语义

| 来源 | `me` 或缺省 | 具体用户名 |
| --- | --- | --- |
| `youtrack` | `assignee: me`（token 对应用户） | `assignee: {用户名}` |
| `wiki` | `creator = currentUser()`（token 对应账号） | `creator = "用户名"` |
| `jira` | `assignee = currentUser()`（token 对应账号） | `assignee = "用户名"` |

### 模板占位符

模板是所选 agent 的 prompt 文件，支持两类占位符。任务级占位符按来源由注册表声明（下表），缺省不替换（原样保留）；规则级占位符替换值来自规则配置，改 config.json 无需改模板：

任务级（按来源）：

- youtrack：`{youtrack_id}`（如 `CS-1`）、`{youtrack_url}`
- wiki：`{wiki_id}`（页面 id）、`{wiki_url}`（页面完整 URL）
- jira：`{jira_id}`（issue key，如 `ISVJ-12228`）、`{jira_url}`（browse 链接）

规则级（所有来源）：

- `{labels}`：规则 `labels` 的逗号连接
- `{not_labels}`：规则 `notLabels` 的逗号连接（未配置时替换为空字符串）

### 模板片段复用（include）

模板支持 `{{include:相对路径}}` 指令在渲染时引入其他文件的内容，公共内容（如产品路径表、统一回复格式）只需维护一份，避免各模板复制粘贴后不同步：

- 路径相对**当前文件所在目录**解析（主模板相对模板目录；片段内再 include 相对片段所在目录），支持嵌套
- 展开发生在占位符替换之前，片段内可以正常使用上述占位符
- 循环引用、片段文件不存在会在渲染时报错，该任务被跳过并记日志
- 用法示例见 `templates/example-workflow.md`；片段文件建议放在 `templates/parts/` 下

> 注意：`templates/*` 已被 .gitignore 忽略，新增片段目录/文件需在 .gitignore 中取消忽略（如 `!templates/parts/`）。

## 扩展新来源

新增来源（如 Jira、GitHub）只需两步，分发与校验自动生效，无需改动其他代码：

1. **创建 `src/<name>.js`**，导出与现有来源同签名的抓取函数：

   ```js
   // src/jira.js
   const { createHttpClient } = require('./youTrack.js');

   async function fetchTasks(rule, { httpClient = createHttpClient('SUPERMAP_JIRA_TOKEN'), url, token }) {
     // 返回 [{ id, idReadable, title?, url?, labels }]
     // rule 包含 { labels, notLabels, assignee, promptTemplate, source }
   }

   module.exports = { fetchTasks };
   ```

   `httpClient` 通过依赖注入传入（未传时用默认 client），便于单测 mock；401/400 错误消息会指向你传入的 token 环境变量名。

2. **在 `src/sources.js` 注册一行**（注册项含 `placeholders`，声明该来源的任务级占位符）：

   ```js
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
       fetchTasks: jiraFetchTasks,
       tokenEnv: 'SUPERMAP_JIRA_TOKEN',
       urlEnv: 'JIRA_URL',
       defaultUrl: 'https://jira.supermap.work',
       placeholders: {
         jira_id: (task) => task.idReadable,
         jira_url: (task) => task.url,
       },
     },
   };
   ```

   注册后自动获得：`config` 的 `source` 校验、`main` 的按来源分发、`resolveEnv` 的按需 token 校验、按来源的 HTTP client（错误消息指向对应 token 环境变量）、任务级占位符（`placeholders` 字段，模板渲染时按来源替换）。

## 扩展新 Agent

与「扩展新来源」同理，新增 agent 只需两步，校验与分发自动生效，无需改动其他代码：

1. **创建 `src/<name>.js`**，导出与现有适配器同签名的纯函数：

   ```js
   // src/myagent.js
   function buildMyagentArgs(prompt, { tmpFile, cwd, agentConfig }) {
     return {
       cmd: agentConfig.path ?? 'myagent',
       args: ['-p', prompt],   // 具体参数以该 CLI 的非交互用法为准
     };
   }
   module.exports = { buildMyagentArgs };
   ```

   适配器只负责「prompt → spawn 参数」的映射，纯函数、不 spawn、不碰文件系统；临时文件写入、退出码、Ctrl+C 杀进程、win32 引号处理均由通用执行层（`src/agentRunner.js`）统一负责。

   返回值为 `{ cmd, args }`；若该 CLI 的 prompt 经 stdin 读取（如 claude），返回 `{ cmd, args, stdin: true }`——通用层会把 prompt 写入子进程 stdin（win32 下比内联 argv 更稳，避免 prompt 被 shell 引号拆坏）。

2. **在 `src/agents.js` 注册一行**，声明专属配置项：

   ```js
   const agents = {
     pi: { buildArgs: buildPiArgs, optionKeys: ['sessionDir', 'path'] },
     claude: { buildArgs: buildClaudeArgs, optionKeys: ['path'] },
     myagent: { buildArgs: buildMyagentArgs, optionKeys: ['path'] },
   };
   ```

   注册后自动获得：`config` 的 `agent` 校验（错误消息列出合法值）、`{agent}` 配置块 key 校验（只允许 `optionKeys` 声明的字段）、`main` 按 agent 分发、通用执行层。config 用法：

   ```json
   { "agent": "myagent", "myagent": { "path": "myagent" } }
   ```

## 测试

```bash
npm test
```

测试使用 `node:test`，HTTP 依赖通过注入的 mock `httpClient` 模拟，不访问真实服务。

## 目录结构

```
src/
  main.js         # 主循环、按来源分发、resolveEnv、信号处理
  sources.js      # 来源注册表（新增来源只改这里）
  config.js       # 配置加载与校验
  filter.js       # 本地标签过滤（AND labels / NOT notLabels）
  template.js     # prompt 模板渲染（占位符替换）
  youTrack.js     # YouTrack 抓取 + 通用 httpClient
  wiki.js         # Wiki 抓取（buildCql + fetchWikiTasks）
  jira.js         # Jira 抓取（buildJql + fetchTasks）
  agents.js       # Agent 注册表（新增 agent 只改这里）
  agentRunner.js  # 通用执行层（临时文件、spawn、退出码、win32 引号）
  piRunner.js     # pi 适配器（纯函数，prompt → spawn 参数映射）
  claudeRunner.js # claude 适配器（纯函数，prompt 经 stdin 传入）
test/             # node:test 测试
templates/        # prompt 模板示例
templates/parts/ # 模板公共片段（include 复用）
```
