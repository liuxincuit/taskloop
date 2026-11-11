# taskloop

定时从多个任务来源按标签抓取任务，交给 AI Agent（基于 pi SDK，在进程内运行）自动执行处理的循环 Worker，带 Web 控制台。

依赖 `@earendil-works/pi-coding-agent`（pi SDK），Node.js ≥ 18。不需要在 PATH 里安装 `pi` 或 `claude`。

## 工作原理

1. 按固定间隔（`intervalSeconds`）循环执行每一轮
2. 每轮遍历 `config.json` 中的每条规则，从规则指定的来源（`source`）按标签抓取候选任务
3. 本地过滤：任务必须包含全部 `labels`，且不包含任何 `notLabels`
4. 对每个候选任务渲染 prompt 模板（模板可引用任务占位符），在当前进程内创建 pi 会话执行
5. 同一轮内相同任务只执行一次；抓取失败、模板读取失败均记日志并继续，不中断整轮

## 支持的来源

| 来源 key | 系统 | 抓取方式 | 模板占位符 |
| --- | --- | --- | --- |
| `youtrack` | YouTrack | `/api/issues` 按标签与指派查询 | `{youtrack_id}`、`{youtrack_url}` |
| `wiki` | Supermap Confluence Wiki | `/rest/api/search` 按创建者（creator）与标签（CQL）查询 | `{wiki_id}`、`{wiki_url}` |
| `jira` | Supermap Jira | `/rest/api/2/search` 按标签（JQL `labels IN`）与指派查询 | `{jira_id}`、`{jira_url}` |
| `scrum` | Supermap Scrum | `/rest/api/2/search` 按标签（JQL `labels IN`）与指派查询 | `{scrum_id}`、`{scrum_url}` |

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

### Scrum 来源

- Scrum（scrum.supermap.work）是 Jira Server 内核，查询、字段与链接格式与 Jira 来源一致，实现上复用 `jira.js`
- 查询：JQL `labels IN (...) [AND labels NOT IN (...)] [AND assignee = currentUser() | assignee = "用户名"]`，最多 100 条
- `{scrum_id}` 替换为 issue key（如 `ISVS-1165`）；`{scrum_url}` 为 browse 链接（`https://<host>/browse/<key>`）

## 快速开始

### 1. 环境要求

- Node.js ≥ 18
- 模型凭据：由 `envFile` 指向的 `KEY=VALUE` 文件提供，或使用 pi 已保存的凭据（`~/.pi/agent/auth.json`）

不需要在 PATH 中存在 `pi` / `claude` 命令行——SDK 直接在当前进程内运行。

### 2. 配置环境变量

| 变量 | 必需性 | 说明 |
| --- | --- | --- |
| `SUPERMAP_YOUTRACK_TOKEN` | 使用 `youtrack` 规则时必需 | YouTrack API token |
| `SUPERMAP_WIKI_TOKEN` | 使用 `wiki` 规则时必需 | Confluence API token |
| `SUPERMAP_JIRA_TOKEN` | 使用 `jira` 规则时必需 | Jira API token |
| `SUPERMAP_SCRUM_TOKEN` | 使用 `scrum` 规则时必需 | Scrum API token |
| `YOUTRACK_URL` | 可选 | 覆盖默认地址 `http://yt.ispeco.com:8099` |
| `WIKI_URL` | 可选 | 覆盖默认地址 `https://wiki.ispeco.com` |
| `JIRA_URL` | 可选 | 覆盖默认地址 `https://jira.supermap.work` |
| `SCRUM_URL` | 可选 | 覆盖默认地址 `https://scrum.supermap.work` |

只对配置中实际使用到的来源要求 token：只配 wiki 规则时无需设置 `SUPERMAP_YOUTRACK_TOKEN`，反之亦然。token 缺失时启动即报错退出（`环境错误: 未设置 ...`）。

token 也可以不放进环境变量，而是在 `config.json` 顶层通过 `envFile` 字段指定一个 `KEY=VALUE` 格式的文件（支持 `#` 注释、空行、引号，与 pi 的 `~/.pi/agent/.env` 一致）：

```json
{ "envFile": "~/.pi/agent/.env" }
```

路径支持 `~` 展开为 home 目录，其余相对 `config.json` 所在目录解析。env 文件的值只补充不覆盖已有环境变量（显式设置的环境变量优先）；显式配置了 `envFile` 但文件不存在时启动报错退出（`环境错误: 无法读取 env 文件 ...`），未配置 `envFile` 时行为与直接设置环境变量一致。

### 3. 初始化配置

不带参数启动时会自动在 `~/.taskloop/config.json` 生成一份可直接运行的默认配置（同时复制一份模板到 `~/.taskloop/templates/analyze.md`）。

要基于示例手写配置，复制 `config.example.json` 到 `~/.taskloop/config.json` 后按需修改。完整字段说明见下文「配置详解」。

### 4. 运行

两种入口共用同一套循环实现：

```bash
node src/server.js               # 页面模式（推荐）：默认 http://127.0.0.1:4789/
node src/main.js                 # 纯命令行模式，只跑循环不开页面
node src/main.js /path/to/my-config.json   # 指定其他配置文件
```

页面模式启动后循环处于**停止**状态，在页面上点「启动」才开始轮询；命令行模式启动即开始轮询。

页面服务只监听 `127.0.0.1`，不会暴露给局域网。端口默认 4789，可用环境变量 `TASKLOOP_PORT` 覆盖。

Ctrl+C 会优雅退出：不再开始新轮次，并中止正在执行的任务（协作式中止，不是杀进程）。

### 运行目录

所有状态集中在 `~/.taskloop/`：

| 路径 | 内容 |
| --- | --- |
| `config.json` | 配置（默认位置） |
| `state.json` | 循环状态、任务历史、日志环形缓冲 |
| `logs/` | 预留的日志目录 |
| `sessions/` | agent 会话文件（完整对话在这里，状态文件只存路径） |
| `workdir/` | agent 执行命令、读写文件的默认工作目录 |
| `templates/` | 首次启动时复制的默认模板 |

重启后页面会恢复历史记录；进程被硬杀时正在执行的任务会被标为「已中断」。

## 配置详解

### config.json 顶层字段

| 字段 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `intervalSeconds` | 否 | `60` | 轮询间隔（正整数，秒） |
| `model` | 否 | — | 模型，写法为 `provider/modelId` 或只写 `modelId`；留空使用 pi 设置中的默认模型。多个提供方存在同名模型时必须写全 `provider/modelId`，否则启动报错 |
| `thinking` | 否 | — | 推理强度：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`；留空使用 pi 设置中的默认值 |
| `workdir` | 否 | `~/.taskloop/workdir` | agent 执行命令、读写文件的工作目录；`~` 展开，其余相对 config 文件目录解析；不存在时自动创建 |
| `sessionDir` | 否 | `~/.taskloop/sessions` | agent 会话文件目录；不存在时自动创建 |
| `envFile` | 否 | — | 环境变量文件路径（`KEY=VALUE` 格式），`~` 展开为 home 目录，其余相对 config 文件目录解析；仅补充不覆盖已有环境变量；文件不存在启动报错 |
| `rules` | 是 | — | 规则数组，非空 |

配置默认位于 `~/.taskloop/config.json`，不带参数启动时读取该路径；也支持 `node src/main.js /path/to/config.json` 指定其他文件。

```json
{
  "intervalSeconds": 60,
  "model": "opencode-go/deepseek-v4.1-flash",
  "thinking": "max",
  "workdir": "~/.taskloop/workdir",
  "sessionDir": "~/.taskloop/sessions",
  "envFile": "~/.pi/agent/.env",
  "rules": [
    {
      "source": "youtrack",
      "labels": ["ready"],
      "notLabels": ["done"],
      "assignee": "me",
      "promptTemplate": "templates/analyze.md"
    }
  ]
}
```

> 旧版本的 `agent` 字段与 `pi` / `claude` 配置块已移除：现在固定使用 pi SDK，不再调用外部命令行。出现这些字段时启动会报错并提示改法——把 `model` 与 `thinking` 移到配置顶层。

### 规则字段（`rules[]`）

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `source` | 否 | 来源 key，缺省 `youtrack`；非法值报错（`rules[i].source 必须是 "youtrack" 或 "wiki" 或 "jira" 或 "scrum"`） |
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
| `scrum` | `assignee = currentUser()`（token 对应账号） | `assignee = "用户名"` |

### 模板占位符

模板是所选 agent 的 prompt 文件，支持两类占位符。任务级占位符按来源由注册表声明（下表），缺省不替换（原样保留）；规则级占位符替换值来自规则配置，改 config.json 无需改模板：

任务级（按来源）：

- youtrack：`{youtrack_id}`（如 `CS-1`）、`{youtrack_url}`
- wiki：`{wiki_id}`（页面 id）、`{wiki_url}`（页面完整 URL）
- jira：`{jira_id}`（issue key，如 `ISVJ-12228`）、`{jira_url}`（browse 链接）
- scrum：`{scrum_id}`（issue key，如 `ISVS-1165`）、`{scrum_url}`（browse 链接）

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

## 从 0.4.x 迁移

1.0.0 是破坏性变更：执行层从「调用外部命令行」换成「进程内 pi SDK」，配置结构随之拍平。旧配置不会再被接受，启动时会报错并指向这一节。

| 旧结构 | 新结构 |
| --- | --- |
| `"agent": "pi"`| 删除（固定使用 pi SDK） |
| `"pi": { "thinking": "max", "model": "x" }` | 提升到顶层 `"thinking": "max"`、`"model": "x"` |
| `"pi": { "sessionDir": "./.pi-sessions" }` | 提升到顶层 `"sessionDir"` |
| `"pi": { "path": ... }`、`"args": [...]` | 删除（不再调用命令行） |
| （无） | 新增 `"workdir"`：agent 执行命令的工作目录 |

改写示例：

```json
{
  "intervalSeconds": 60,
  "agent": "pi",
  "pi": { "sessionDir": "./.pi-sessions", "thinking": "max", "model": "deepseek-v4-flash" },
  "rules": [
    { "source": "youtrack", "labels": ["ready"], "promptTemplate": "templates/analyze.md" }
  ]
}
```

改成：

```json
{
  "intervalSeconds": 60,
  "thinking": "max",
  "model": "deepseek-v4-flash",
  "sessionDir": "~/.taskloop/sessions",
  "workdir": "~/.taskloop/workdir",
  "rules": [
    { "source": "youtrack", "labels": ["ready"], "promptTemplate": "templates/analyze.md" }
  ]
}
```

其他变化：

- 配置默认位置从「当前目录的 `config.json`」改为 `~/.taskloop/config.json`（仍可用命令行参数指定其他路径）
- 模型凭据不再依赖「pi 已登录」：可以用 `envFile` 提供，也可以继续用 `~/.pi/agent/auth.json` 里已保存的凭据
- `pi` 不再需要在 PATH 中；`claude` 后端已删除，需要换模型时改 `model` 字段
- 页面能编辑配置，但表单保存后需要重启循环才生效

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
   const { fetchTasks } = require('./youTrack.js');
   const { fetchWikiTasks } = require('./wiki.js');
   const { fetchTasks: fetchJiraTasks } = require('./jira.js');
   const { fetchTasks: fetchScrumTasks } = require('./scrum.js');

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
     scrum: {
       fetchTasks: fetchScrumTasks,
       tokenEnv: 'SUPERMAP_SCRUM_TOKEN',
       urlEnv: 'SCRUM_URL',
       defaultUrl: 'https://scrum.supermap.work',
       placeholders: {
         scrum_id: (task) => task.idReadable,
         scrum_url: (task) => task.url,
       },
     },
   };
   ```

   注册后自动获得：`config` 的 `source` 校验、`main` 的按来源分发、`resolveEnv` 的按需 token 校验、按来源的 HTTP client（错误消息指向对应 token 环境变量）、任务级占位符（`placeholders` 字段，模板渲染时按来源替换）。

## 测试

```bash
npm test
```

测试使用 `node:test`。HTTP 依赖通过注入的 mock `httpClient` 模拟，SDK 会话通过注入的 `createSession` 替身模拟，不访问真实服务、不调用真实模型。

## 目录结构

```
src/
  main.js         # 纯命令行入口（只跑循环，不开页面）
  server.js       # 页面模式入口（HTTP 服务 + 静态资源 + SSE）
  routes.js       # 接口路由（状态快照 / 事件流 / 启停 / 配置读写）
  worker.js       # 轮询循环与生命周期（start / stop / wake / snapshot）
  sessionRunner.js# pi SDK 执行层（会话创建、事件采集、中止、结果判定）
  state.js        # 运行状态与任务历史落盘
  sources.js      # 来源注册表（新增来源只改这里）
  config.js       # 配置读取、校验与路径解析
  filter.js       # 本地标签过滤（AND labels / NOT notLabels）
  template.js     # prompt 模板渲染（占位符替换）
  env.js          # env 文件解析
  youTrack.js     # YouTrack 抓取 + 通用 httpClient
  wiki.js         # Wiki 抓取（buildCql + fetchWikiTasks）
  jira.js         # Jira 抓取（buildJql + fetchTasks）
  scrum.js        # Scrum 抓取（复用 jira.js 的 JQL 与映射）
  ui/             # 页面（index.html + style.css + app.js，无构建、无外部资源）
test/             # node:test 测试
docs/prototype/   # 设计原型与截图
templates/        # prompt 模板示例
templates/parts/ # 模板公共片段（include 复用）
```

### 层次约束

新增任务来源时只改 `src/sources.js`（详见「扩展新来源」）：

- `worker.js` 不感知具体来源，`rule.source` 的所有处理都经注册表分发
- 页面表单的来源下拉从 `GET /api/config` 的 `options.sources` 读取，新增来源后自动出现在页面上
- 来源的 `tokenEnv` / `urlEnv` / `defaultUrl` 也由注册表提供，启动时的 token 校验同样自动生效
