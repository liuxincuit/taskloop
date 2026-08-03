# youtrack-pi-worker 增加 wiki 来源设计

日期：2026-08-04
状态：已批准（用户逐节确认）

## 背景与目标

现有 youtrack-pi-worker 只支持从 YouTrack 按标签抓取任务。本次增加第二个来源：从 Supermap Confluence Wiki 按"创建者 + 标签"抓取页面作为任务。

wiki 页面的任务流转机制与 YouTrack 对称：抓取 → pi 执行模板 → 模型给页面打完成标签（如 `explored`）+ 把结果回写到页面评论区（共享通道，用户可见，后续 Agent 可读）。

## 核心需求

1. 任务来源扩展：规则增加 `source: "youtrack" | "wiki"`，缺省 `youtrack`，现有配置零迁移
2. wiki 任务 = 指定创建者（默认当前用户）创建的、带指定标签的页面，跨空间
3. 完成标记 = 给页面打标签（标签名由规则 notLabels / 模板决定，如 `explored`）；副作用（标签对共享页面可见）由使用该流程的人承担
4. 处理结果回写页面评论区（新增能力，独立于打标签）
5. 抓取、过滤、去重、主循环复用现有结构与模式

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 任务定义 | 指定创建者创建的 wiki 页面（跨空间），带指定标签 |
| 抓取条件 | CQL `creator = currentUser() AND type = page AND label in (...)` |
| 过滤语义 | 与 YouTrack 一致：查询层 label OR 缩小范围，本地 filterTasks 做 AND + notLabels 排除 |
| 完成标记 | 给页面打标签，标签名由规则/模板决定；不修改现有脚本 |
| 副作用接受 | 标签对共享页面可见，谁使用这套流程谁承担后果 |
| 配置结构 | rules 加 `source` 字段，缺省 youtrack；**不新增字段**，wiki 规则复用 labels/notLabels/assignee/promptTemplate（assignee 语义 = 创建者 creator） |
| 模板占位符 | `{wiki_url}` = 页面 URL（如 `https://wiki.ispeco.com/pages/viewpage.action?pageId=xxx`） |
| 回写机制 | 新增"加评论"能力，处理结果写回页面评论区；加评论与打标签是两个独立的新增能力 |
| 能力归属 | 两个新能力（manage_label.js / add_comment.js）新增到 supermap-wiki skill，模型在 pi 会话内调用；脚本只负责轮询 |
| 同轮去重 | main.js 的 processed Set 按 idReadable（wiki 用 pageId）去重，跨规则同一页面只执行一次 |
| 来源扩展机制 | 来源注册表 `src/sources.js`：source → {fetchTasks, tokenEnv, urlEnv, defaultUrl}；新增来源 = 新模块 + 注册一行，main.js/config.js 无 if else |

## 架构与组件

### supermap-wiki skill（D:\liuxin\sources\skills\skills\skills\supermap-wiki\）

| 文件 | 改动 |
|---|---|
| `scripts/manage_label.js` | 新增：页面标签管理（list / add / remove） |
| `scripts/add_comment.js` | 新增：页面加评论 |
| `SKILL.md` | 修改：补充两个新能力的命令、参数、输出格式、错误处理 |

### 本项目（F:/liuxin/temp/temp）

| 文件 | 改动 |
|---|---|
| `src/wiki.js` | 新增：`buildCql` + `fetchWikiTasks`，返回 `{id, idReadable, labels}` 形状 |
| `src/sources.js` | 新增：来源注册表 `{youtrack, wiki}`，每项含 `fetchTasks`、`tokenEnv`、`urlEnv`、`defaultUrl` |
| `src/config.js` | 修改：规则解析 `source` 字段（缺省 youtrack），非法值报错；校验基于注册表 `SOURCE_KEYS`；其余字段校验两种来源共用 |
| `src/main.js` | 修改：按注册表分发抓取；只对配置中实际使用的来源要求 token 环境变量，URL 缺省值来自注册表 |
| `src/template.js` | 修改：占位符泛化，同时替换 `{youtrack_id}` 与 `{wiki_url}` |
| `test/wiki.test.js` | 新增：buildCql / fetchWikiTasks 单测 |
| `test/config.test.js` 等 | 修改：source 校验、占位符、分发测试 |

不改动：filter.js、piRunner.js、主循环结构、`SUPERMAP_YOUTRACK_TOKEN` 语义。

## 配置格式

```jsonc
{
  "intervalSeconds": 60,
  "sessionDir": "./.pi-sessions",
  "rules": [
    {
      "source": "youtrack",        // 可选，缺省 "youtrack"
      "labels": ["ready", "explorer"],
      "notLabels": ["explored"],
      "assignee": "me",
      "promptTemplate": "templates/yt-explorer.md"
    },
    {
      "source": "wiki",            // wiki 规则
      "labels": ["ready"],
      "notLabels": ["explored"],
      "assignee": "me",            // wiki 语义：creator = currentUser()
      "promptTemplate": "templates/wiki-explorer.md"
    }
  ]
}
```

字段说明（wiki 规则）：
- `assignee: "me"` → CQL `creator = currentUser()`（token 对应账号）
- `assignee: "用户名"` → CQL `creator = "用户名"`
- `labels` → CQL `label in ("l1", "l2", ...)`，AND 由 filterTasks 本地兜底
- `notLabels` → 本地过滤，不进 CQL
- `promptTemplate` → 模板中 `{wiki_url}` 替换为页面 URL

## wiki 抓取细节

`buildCql(rule)`：

```
creator = currentUser() AND type = page AND label in ("ready", "explorer")
```

- CQL 字符串值用双引号包裹，值内含引号需转义
- 抓取流程：
  1. `GET {WIKI_URL}/rest/api/search?cql=...&limit=...&expand=...` 搜索页面
  2. 获取页面标签列表：优先 search expand 直接带出；若 Server 版本不支持则回退逐页 `GET /rest/api/content/{pageId}?expand=metadata.labels`（任务页面数量少，N+1 可接受）
  3. 归一化为 `{id: pageId, idReadable: pageId, labels: [标签名]}`
  4. 交给现有 `filterTasks` 做 AND + notLabels 过滤
  5. 通过过滤的页面进入 pi 执行：模板渲染 `{wiki_url}`，模型用现有 `read_wiki.js` 读取页面

## 新增能力设计

### manage_label.js

```
node scripts/manage_label.js list <pageId>              列出页面标签
node scripts/manage_label.js add <pageId> <标签名>     加标签
node scripts/manage_label.js remove <pageId> <标签名>  删标签
```

- API：`GET /rest/api/content/{id}?expand=metadata.labels`；`POST /rest/api/content/{id}/label`（body 为标签数组 `[{"prefix": "global", "name": "..."}]` 或单标签对象 `{"prefix": "global", "name": "..."}`，本实例实测两种格式均 200；`{"labels":[...]}` 包装格式、字符串、空对象实测 400 "Could not parse Labels"，勿用）；`DELETE /rest/api/content/{id}/label?name=...`
- 幂等：add 前先 list 检查，已有则跳过（本实例实测重复 POST 同一标签返回 200 不报错；幂等检查的价值是避免重复请求与保持输出稳定，而非规避报错）
- 环境变量：`SUPERMAP_WIKI_TOKEN`

### add_comment.js

```
node scripts/add_comment.js <pageId> <评论文本或文件路径>
```

- **端点（实测确认）**：必须用通用端点 `POST /rest/api/content`，body `{type: "comment", container: {id, type: "page"}, body: {storage: {value, representation: "storage"}}}`。**不要**用子资源端点 `/rest/api/content/{id}/comment`——该实例（nginx 反代的老版本 Confluence Server）实测返回 404 `null for uri`；通用端点实测 200。删除评论用 `DELETE /rest/api/content/{commentId}`（实测 204）
- 文本处理：XML 转义 + 按段落/换行转 `<p>` storage 格式（不做完整 markdown 转换，保持简单）
- 环境变量：`SUPERMAP_WIKI_TOKEN`

## 数据流

```
主循环 runCycle
  └─ rule.source 从注册表取 fetch 实现（如 "wiki" → fetchWikiTasks）
       └─ fetchWikiTasks(rule, {httpClient, url: urls.wiki, token: tokens.wiki})
            ├─ buildCql → GET /rest/api/search
            └─ 归一化 {id: pageId, idReadable: pageId, labels}
       └─ filterTasks(任务, rule.labels, rule.notLabels)   # 复用
       └─ renderTemplate(模板, {wikiUrl: 页面URL})          # 复用，占位符泛化
       └─ runPi(prompt)                                    # 复用
            └─ pi 会话内模型按模板指示：
                 ├─ read_wiki.js 读取页面
                 └─ manage_label.js add <pageId> explored  # 完成标记
                 └─ add_comment.js <pageId> 结果            # 共享通道
```

youtrack 与 wiki 规则在 rules 数组中按顺序串行混排执行。

## 错误处理

| 场景 | 行为 |
|---|---|
| wiki 抓取失败（网络/超时/HTTP） | log + continue 下一规则，不中断整轮 |
| 401 | 提示检查 `SUPERMAP_WIKI_TOKEN` |
| 400（CQL 语法错误） | 提示检查规则配置与标签转义 |
| 有 wiki 规则但未设置 token | 启动时报错退出 |
| 打标签/加评论失败 | 发生在 pi 会话内，模型按模板指示处理；脚本输出清晰错误 |

## 测试计划

node:test 零依赖，mock httpClient 注入：

| 文件 | 覆盖 |
|---|---|
| `test/wiki.test.js`（新增） | buildCql（me/具体用户名、单/多标签、特殊字符转义）；fetchWikiTasks（响应解析、标签提取、错误分支） |
| `test/config.test.js`（更新） | source 缺省、合法值、非法值报错 |
| `test/template.test.js`（更新） | `{wiki_url}` 替换；两种占位符互不干扰 |
| `test/main.test.js`（更新） | source 分发（mock 两种 fetch）、wiki 规则缺 token 启动失败 |

## 冒烟计划（需用户确认后执行）

1. skill 新脚本：用真实 token 对用户指定页面打标签/加评论验证
2. 项目抓取：配一条临时 wiki 规则真实跑一轮，验证抓到用户的页面

## 范围外（YAGNI）

- 多空间过滤字段（用多条规则表达，一条规则一个 assignee 条件）
- 页面标题/内容关键词过滤
- 评论深度解析用于去重（去重只靠标签）
- write_wiki.js 的完整 markdown 转换能力复用到评论
