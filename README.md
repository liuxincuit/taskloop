# taskloop

定时从多个任务来源按标签抓取任务，交给 AI Agent（pi 等）非交互模式自动执行处理的循环 Worker。

零第三方依赖（仅 Node.js 内置模块），Node.js ≥ 18（需要 `String.prototype.replaceAll`）。

## 工作原理

1. 按固定间隔（`intervalSeconds`）循环执行每一轮
2. 每轮遍历 `config.json` 中的每条规则，从规则指定的来源（`source`）按标签抓取候选任务
3. 本地过滤：任务必须包含全部 `labels`，且不包含任何 `notLabels`
4. 对每个候选任务渲染 prompt 模板（模板可引用任务占位符），调用 `pi -p` 非交互执行
5. 同一轮内相同任务只执行一次；抓取失败、模板读取失败均记日志并继续，不中断整轮

## 支持的来源

| 来源 key | 系统 | 抓取方式 | 模板占位符 |
| --- | --- | --- | --- |
| `youtrack` | YouTrack | `/api/issues` 按标签（hashtag）与指派查询 | `{youtrack_id}` |
| `wiki` | Supermap Confluence Wiki | `/rest/api/search` 按创建者（creator）与标签（CQL）查询 | `{wiki_url}` |

来源与任务形状统一为：`{ id, idReadable, title, url, labels }`（`title`、`url` 可为空）。

### YouTrack 来源

- 查询：`#标签1 #标签2`（多标签是 OR 语义粗查，AND 精确匹配由本地 `filterTasks` 兜底），`assignee` 规则见下文
- 规则中的标签必须是 YouTrack 中已存在的标签，否则查询报 HTTP 400 语法错误
- `{youtrack_id}` 替换为任务的 `idReadable`（如 `CS-1`）

### Wiki 来源

- 查询：CQL `creator = currentUser() AND type = page AND label in (...)`，`includeArchivedSpaces=false`，最多 100 条
- 标签通过 `expand=content.metadata.labels` 随搜索结果带出；若实例不支持 expand，自动回退为逐页获取
- `{wiki_url}` 替换为页面地址（`https://<host>/pages/viewpage.action?pageId=<id>`）

## 快速开始

### 1. 环境要求

- Node.js ≥ 18
- `pi` 命令在 PATH 中可用

### 2. 配置环境变量

| 变量 | 必需性 | 说明 |
| --- | --- | --- |
| `SUPERMAP_YOUTRACK_TOKEN` | 使用 `youtrack` 规则时必需 | YouTrack API token |
| `SUPERMAP_WIKI_TOKEN` | 使用 `wiki` 规则时必需 | Confluence API token |
| `YOUTRACK_URL` | 可选 | 覆盖默认地址 `http://yt.ispeco.com:8099` |
| `WIKI_URL` | 可选 | 覆盖默认地址 `https://wiki.ispeco.com` |

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

Ctrl+C 会优雅退出：停止新轮次、终止正在执行的 pi 子进程（Windows 下强制结束进程树）。

## 配置详解

### config.json 顶层字段

| 字段 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `intervalSeconds` | 否 | `60` | 轮询间隔（正整数，秒） |
| `sessionDir` | 否 | 配置文件所在目录 | pi 会话保存目录（相对配置文件解析） |
| `rules` | 是 | — | 规则数组，非空 |

### 规则字段（`rules[]`）

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `source` | 否 | 来源 key，缺省 `youtrack`；非法值报错（`rules[i].source 必须是 "youtrack" 或 "wiki"`） |
| `labels` | 是 | 非空字符串数组；任务必须**全部**包含这些标签（AND） |
| `notLabels` | 否 | 字符串数组；任务包含任一标签即被排除 |
| `assignee` | 否 | 来源语义不同，见下 |
| `promptTemplate` | 是 | 模板文件路径（相对配置文件解析），文件必须存在 |

### assignee 语义

| 来源 | `me` 或缺省 | 具体用户名 |
| --- | --- | --- |
| `youtrack` | `assignee: me`（token 对应用户） | `assignee: {用户名}` |
| `wiki` | `creator = currentUser()`（token 对应账号） | `creator = "用户名"` |

### 模板占位符

模板是 pi 的 prompt 文件，支持四类占位符。任务级占位符缺省不替换（原样保留）；规则级占位符替换值来自规则配置，改 config.json 无需改模板：

- `{youtrack_id}`：YouTrack 任务的 `idReadable`（如 `CS-1`）；wiki 任务下为页面 id
- `{wiki_url}`：Wiki 页面的完整 URL（仅 wiki 任务有值）
- `{labels}`：规则配置 `labels` 的逗号连接（如 `ready, explorer`）
- `{not_labels}`：规则配置 `notLabels` 的逗号连接（未配置时替换为空字符串）

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

2. **在 `src/sources.js` 注册一行**：

   ```js
   const sources = {
     youtrack: { fetchTasks, tokenEnv: 'SUPERMAP_YOUTRACK_TOKEN', urlEnv: 'YOUTRACK_URL', defaultUrl: 'http://yt.ispeco.com:8099' },
     wiki: { fetchTasks: fetchWikiTasks, tokenEnv: 'SUPERMAP_WIKI_TOKEN', urlEnv: 'WIKI_URL', defaultUrl: 'https://wiki.ispeco.com' },
     jira: { fetchTasks: jiraFetchTasks, tokenEnv: 'SUPERMAP_JIRA_TOKEN', urlEnv: 'JIRA_URL', defaultUrl: 'https://jira.example.com' },
   };
   ```

   注册后自动获得：`config` 的 `source` 校验、`main` 的按来源分发、`resolveEnv` 的按需 token 校验、按来源的 HTTP client（错误消息指向对应 token 环境变量）。

## 测试

```bash
npm test
```

测试使用 `node:test`，HTTP 依赖通过注入的 mock `httpClient` 模拟，不访问真实服务。

## 目录结构

```
src/
  main.js        # 主循环、按来源分发、resolveEnv、信号处理
  sources.js     # 来源注册表（新增来源只改这里）
  config.js      # 配置加载与校验
  filter.js      # 本地标签过滤（AND labels / NOT notLabels）
  template.js    # prompt 模板渲染（占位符替换）
  youTrack.js    # YouTrack 抓取 + 通用 httpClient
  wiki.js        # Wiki 抓取（buildCql + fetchWikiTasks）
  piRunner.js    # pi 非交互执行（临时 prompt 文件 + spawn）
test/            # node:test 测试
templates/       # prompt 模板示例
```
