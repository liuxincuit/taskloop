# YouTrack 任务循环执行器（youtrack-pi-worker）设计

日期：2026-08-04
状态：已批准（用户逐节确认）

## 背景与目标

编写一个常驻 Node 脚本：定时从 YouTrack 按 label 抓取任务，通过 pi 非交互模式（`pi -p`）逐个执行，prompt 来自模板文件（替换 `{youtrack_id}` 占位符）。脚本为 while 循环，Ctrl+C 退出。

## 核心需求

1. 最外层循环：定时轮询，间隔可配置（默认 60 秒），间隔从**本轮全部任务执行完成**开始计时（非固定调度）
2. 中层循环：遍历配置中的规则数组，每条规则包含 `labels`、`notLabels`、`promptTemplate`
3. 内层循环：按规则的 labels 从 YouTrack 抓取任务并过滤（**AND 语义**：须同时拥有全部 labels；**排除语义**：拥有任一 notLabel 即剔除），逐任务串行调用 pi 执行
4. 任务列表仅包含 id（idReadable）和 label
5. `labels`、`notLabels`、`promptTemplate`、循环间隔全部配置化，不硬编码

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| include label 语义 | AND（同时拥有全部 labels 才入选） |
| 重复执行处理 | 靠标签机制去重：pi 的 prompt 指示模型执行完任务后打 notLabel 标签（如 done），下一轮自动排除；脚本不写回 YouTrack |
| `{youtrack_id}` | 替换为 idReadable（如 `CS-1234`） |
| 解决人过滤 | 配置化：规则可选 `assignee` 字段（`me`=token 所有者或用户 login），缺省不按解决人过滤 |
| 任务执行方式 | 串行（一次一个 pi 子进程） |
| prompt 传入方式 | 写入临时文件，`pi -p @临时文件`（避免命令行长度限制与特殊字符转义） |
| 配置文件格式 | JSON 顶层对象 `{ intervalSeconds, rules: [...] }` |
| 测试框架 | Node 内置 `node:test`，零依赖 |

## 目录结构

```
F:/liuxin/temp/temp/
├── config.json              # 配置（间隔 + 规则数组）
├── templates/analyze.md     # 示例 prompt 模板（含 {youtrack_id}）
├── src/
│   ├── config.js            # 读配置 + 校验
│   ├── filter.js            # 纯函数 label 过滤
│   ├── template.js          # 纯函数占位符替换
│   ├── youTrack.js          # 抓取任务（HTTP 客户端注入）
│   ├── piRunner.js          # 临时文件 + spawn pi -p
│   └── main.js              # 三层循环 + SIGINT + 日志
├── test/
│   ├── filter.test.js
│   ├── template.test.js
│   ├── youTrack.test.js
│   ├── piRunner.test.js
│   ├── config.test.js
│   └── main.test.js
└── package.json             # 仅 scripts（"test": "node --test"），零依赖
```

## 配置格式

```jsonc
{
  "intervalSeconds": 60,          // 循环间隔，从本轮全部执行完开始计时
  "sessionDir": "./.pi-sessions", // 可选：pi 会话保存目录；缺省为 config.json 同级目录
  "rules": [
    {
      "labels": ["readyed", "clearly"],     // 必须同时拥有（AND）
      "notLabels": ["done"],                // 拥有任一即排除
      "assignee": "me",                     // 可选：解决人过滤，"me"=token 所有者，或用户 login（如 "liuxin"）；缺省不按解决人过滤
      "promptTemplate": "templates/analyze.md"  // 相对 config.json 所在目录
    }
  ]
}
```

YouTrack URL/Token 走环境变量（沿用现有 skill 约定）：
- `SUPERMAP_YOUTRACK_TOKEN`（必需，Bearer Token）
- `YOUTRACK_URL`（可选，默认 `http://yt.ispeco.com:8099`）

## 组件职责与接口

### src/config.js
`loadConfig(path) → { intervalSeconds, sessionDir, rules }`
- 校验：rules 非空数组、每项 labels 非空、promptTemplate 文件存在、assignee 为字符串（可选）
- `sessionDir` 可选；缺省为 config.json 所在目录（绝对路径）
- 失败时启动即报错退出（exit 1）

### src/filter.js
`filterTasks(tasks, labels, notLabels) → tasks`（纯函数）
- `task.labels` 包含全部 `labels`（AND），且不含任何 `notLabels`
- 标签匹配大小写敏感（与 YouTrack 行为一致）

### src/template.js
`renderTemplate(content, { youtrackId }) → string`（纯函数）
- 将所有 `{youtrack_id}` 替换为 youtrackId（idReadable）
- 模板文件本身不被修改

### src/youTrack.js
`fetchTasks(rule, { httpClient, url, token }) → [{ id, idReadable, labels }]`
- `GET /api/issues?query=#{label} #{label}...&fields=id,idReadable,tags(id,name)`
- 若规则配置了 `assignee`，查询追加 `assignee: me`（token 所有者）或 `assignee: {login}`（如 `liuxin`）
- 查询层面只用 labels（+可选 assignee）缩小范围，notLabels 过滤在本地 filter 完成
- 返回结构仅含 id、idReadable、labels

### src/piRunner.js
`runPi(prompt, { cwd, piPath, sessionDir }) → { exitCode }`
1. prompt 写入 `os.tmpdir()` 临时文件（文件名含唯一标识：pid+时间戳+随机数）
2. `spawn(pi, ["-p", "@" + 临时文件, "--session-dir", sessionDir], { cwd, stdio: "inherit" })`
- `cwd` 由 main.js 传入（脚本所在目录，即 `__dirname` 的上级），使 pi 能读取项目上下文与 skill
- `piPath` 缺省为 `"pi"`（走 PATH 查找），允许测试注入 mock
- `sessionDir` 由 main.js 传入：默认 config.json 所在目录，可用配置 `sessionDir` 覆盖；pi 会在该目录下按任务 cwd 保存 session（目录不存在时 pi 自动创建），便于日后排查
3. 返回退出码；非零视为任务失败（记日志，不中断循环）
4. 执行后删除临时文件；SIGINT 时清理残留

### src/main.js
三层循环 + SIGINT + 日志（见数据流）。

## 数据流（一轮 = 一次 while 迭代）

```
[开始一轮] 记日志 "轮次 N 开始"
  └→ for each rule:
        ├→ fetchTasks(rule)            # 抓取 + 本地过滤，得到候选任务
        ├→ 跳过本轮已执行过的 idReadable（同轮去重 Set）
        ├→ for each task（串行）:
        │     ├→ 读 promptTemplate 文件内容
        │     ├→ renderTemplate → 替换 {youtrack_id} = task.idReadable
        │     ├→ runPi(prompt)         # pi 输出继承终端
        │     └→ 记日志 "[CS-1234] 完成 (退出码 0)"
        └→ 无任务时记日志 "[rule] 无候选任务"
  └→ 记日志 "轮次 N 结束，等待 60 秒"
  └→ await sleep(intervalSeconds)
```

## 错误处理

| 场景 | 行为 |
|---|---|
| 配置缺失/字段非法/模板文件不存在 | 启动时报错退出（exit 1） |
| `SUPERMAP_YOUTRACK_TOKEN` 未设置 | 启动时提示并退出（不输出值） |
| 抓取失败（网络/401/403/超时） | 记错误日志，跳过该 rule，继续其他 rule；下一轮自动重试 |
| 单任务 pi 执行失败（非零退出码） | 记日志（含退出码），继续下一个任务 |
| 模板文件读取失败 | 记日志，跳过该任务 |
| Ctrl+C（SIGINT） | ① kill 正在运行的 pi 子进程 → ② 清理临时文件 → ③ 打印退出信息 → exit 0 |
| 意外异常 | 顶层 try/catch 记日志，本轮中止，等待 interval 后下一轮继续 |

设计原则：长驻进程，单点故障不终止进程；仅配置错误与 token 缺失这类永久性问题启动即退。

## 日志格式

```
[2026-08-03 17:30:00] 轮次 1 开始
[2026-08-03 17:30:01] [readyed,clearly] 抓取到 3 个候选任务
[2026-08-03 17:30:01] [CS-1234] 开始执行（模板: templates/analyze.md）
...pi 输出...
[2026-08-03 17:30:45] [CS-1234] 完成（退出码 0）
[2026-08-03 17:30:46] [CS-1234] 完成（退出码 1）← 失败但继续
[2026-08-03 17:30:50] 轮次 1 结束，等待 60 秒
```

## 测试设计

`node --test` 运行，全部单测，不发起真实 HTTP、不 spawn 真实 pi；外部依赖通过参数注入 mock。

| 测试文件 | 覆盖内容 |
|---|---|
| `test/filter.test.js` | AND 语义、notLabel 排除、空任务/空标签边界、大小写敏感 |
| `test/template.test.js` | 占位符替换、多处替换、无占位符原样返回、模板不被修改 |
| `test/youTrack.test.js` | mock httpClient：请求 URL 含 tag 查询与 fields 参数、assignee 配置时追加 `assignee: me`/`assignee: {login}` 查询、返回结构映射、401/网络错误异常 |
| `test/piRunner.test.js` | mock spawn：命令为 `pi -p @临时文件 --session-dir <dir>`、临时文件内容为替换后 prompt、退出码返回、临时文件清理、非零退出码不抛异常 |
| `test/config.test.js` | 合法配置解析、缺字段/空 rules/模板缺失报错、intervalSeconds 缺省处理 |
| `test/main.test.js` | 注入全部 mock，验证一轮流程：按 rule 顺序执行、同轮去重、全部完成后 sleep(interval)、零任务跳过 |

## 验证标准

1. 代码中不硬编码 labels、notLabels、promptTemplate、循环间隔（全部来自 config.json）
2. `npm test` 全部通过（测试验证通过后才可报告完成）
