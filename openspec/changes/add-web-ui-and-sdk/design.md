# Design

## Context

参见 `proposal.md` 的 Why。设计需要面对的既有约束：

- `src/main.js` 把三件事绑在一起：进程生命周期、轮询循环、信号处理。`while (running)` 直接跑在 `main()` 里，`SIGINT` handler 里同时做三件事（置标志、杀当前子进程、`taskkill /T /F` 杀进程树）。
- 执行层是 `spawn` 子进程：`src/agentRunner.js` 写临时 prompt 文件、在 win32 下给非 flag 参数包引号、通过 `onChild` 回调把 child 交给 `main.js` 以便信号处理。这些复杂度全部来自"agent 是个外部进程"这一前提。
- `src/config.js` 返回的对象里路径字段已经被解析为绝对路径，且 agent 配置块通过 `buildMappedArgs` 被任意映射成 CLI 参数。
- 测试基线是 180 个用例全绿，其中 `agentRunner` / `piRunner` / `claudeRunner` / `args` 四个测试文件直接测 CLI 参数生成。

pi SDK 提供了 `createAgentSession()`、`session.subscribe()`、`session.abort()`、`session.dispose()`，以及在 `dist/core/resource-loader.js` 内部通过 `DefaultPackageManager` 解析设置文件包列表的资源发现能力。

## Goals / Non-Goals

**Goals**

- 循环可以脱离进程生死被反复启停，且停止能中止正在执行的 agent 任务。
- 页面能在 3 秒内回答"它现在在做什么、卡在哪"。
- 通过表单修改配置而不丢失用户手写的内容。
- 重启后仍能看到之前跑了什么。

**Non-Goals**

- 不做多实例管理。一个用户目录对应一个循环。
- 不做用户权限系统。页面仅监听回环地址，不开登录。
- 不做页面内填写模型 API key。凭据仍走环境变量文件。
- 不改任务来源的抓取逻辑（`youTrack.js` / `wiki.js` / `jira.js` / `scrum.js` / `sources.js` / `filter.js` / `template.js` 全部保持不动）。
- 不做项目信任的自动授予。

## Decisions

### 决策 1：同进程而非 fork 子进程

**选择**：Web 服务与轮询循环在同一个 Node 进程内，`src/worker.js` 暴露 `start()` / `stop()` / `wake()` / `snapshot()`。

**替代方案**：`child_process.fork` 启 `src/main.js` 子进程，通过 IPC 交换事件，用 `silent: true` 让 agent 输出流回父进程。

**理由**：fork 方案的全部价值在于隔离和"杀得干净"。切到 SDK 之后这两点都消失了——agent 不再是子进程，`session.abort()` 比 `taskkill /T /F` 精确得多。fork 反而要额外引入 IPC 协议、stdout 行序解析、以及 Windows 上 `kill('SIGINT')` 不触发 handler 的坑。

**代价**：agent 通过 bash 工具派生的孙进程仍属于本进程树，跑飞了会连带页面一起挂。接受，并在 Risks 里记录。

### 决策 2：只保留 SDK 后端，删除 CLI 路径

**选择**：删除 `claudeRunner.js`、`piRunner.js`、`args.js`、`agents.js`、`agentRunner.js`。执行层收敛为单个 `src/sessionRunner.js`。

**替代方案**：注册表保留两种 backend 类型（`kind: 'sdk'` / `kind: 'cli'`），pi 走 SDK，claude 继续 spawn。

**理由**：这次改造的价值是"进程内结构化事件 + 协作式中止"，这套抽象只对进程内 agent 成立。为一个 CLI 后端在注册表里加 kind 分叉，会让页面的事件适配、失败判定、停止语义都变成两套。产物定位是"任何装有 node 的机器上启动"，额外背一个必须有外部二进制的后端与目标冲突。

**代价**：能力缩减，`permissionMode` 之类 claude 专属参数不再可用。这类诉求改由模型选择满足。

### 决策 3：config 拍平（无 `agent` 字段）

**选择**：顶层直接是 `intervalSeconds` / `model` / `thinking` / `workdir` / `sessionDir` / `envFile` / `rules`。

**替代方案**：保留 `agent: "pi"` 加 `pi: {...}` 嵌套块。

**理由**：拍平是决策 4（表单化）的前提。表单没法渲染一个"任意 key 会被转成 CLI 参数"的动态块。拍平后每个字段的类型和合法值都能枚举，`model` 来自模型运行时、`thinking` 是固定枚举、`rules[].source` 来自来源注册表、`rules[].promptTemplate` 来自目录扫描。

**代价**：将来若真要支持第二个 SDK agent，需要重新引入分组字段。判断：加字段的成本远低于长期维护一个只有单条岔路的注册表。

### 决策 4：表单基于原始 JSON 往返

**选择**：页面读取配置时用 `JSON.parse(fs.readFileSync())` 的原始对象；保存时把表单改动合并回这个原始对象再写盘。校验单独调用 `validateConfig(raw, configDir)`。

**替代方案**：直接用 `loadConfig()` 的返回值渲染表单，保存时 `JSON.stringify(loadConfig结果)`。

**理由**：`loadConfig()` 的输出里 `promptTemplate`、`envFile`、`sessionDir`、`workdir` 都已被解析为绝对路径。用它渲染再保存，会把用户写的 `./templates/x.md` 永久固化成 `D:\code\taskloop\templates\x.md`，换机器或换目录即失效。同时它丢弃表单不认识的字段。

**代价**：`src/config.js` 必须拆成两段——`readRawConfig(path)`（读文件 + JSON 解析 + 顶层类型检查）与 `validateConfig(raw, configDir)`（字段校验 + 路径解析）。这是一次真实的接口变更，`test/config.test.js` 会跟着动。

### 决策 5：每个任务一个 session，结果不用退出码

**选择**：每个候选任务创建新 session，结束即 `dispose()`。成功与否依据会话结束状态与错误对象判定，成功时保存 `getLastAssistantText()`。

**替代方案**：复用单个 session 处理整轮任务。

**理由**：复用会让前一个任务的对话成为后一个任务的上下文，等价于让 agent 在别人的工作记忆里干活。跨任务污染在无人值守场景里几乎必然导致误改。

**代价**：每个任务都要重新做一次资源发现（技能、扩展、包），有固定开销。接受，因为任务本身是分钟级的。

### 决策 6：进度 L3 且文本增量合并

**选择**：展示系统事件、工具调用、agent 文本流三层。文本增量按时间窗合并后再推送给页面。

**替代方案**：只展示工具调用（L2）；或逐条推送每个文本增量。

**理由**：SDK 的文本增量是逐 token 的，一个任务可产生数万条。逐条推送会让浏览器主线程饱和、日志暴涨。合并到约 100ms 一批，既保留"在打字"的观感，又把事件量压到可处理范围。

### 决策 7：SSE 而非 WebSocket

**选择**：`GET /api/events` 作为服务器推送事件流。

**理由**：`node:http` 原生支持，浏览器自带重连语义，且数据流是单向的（服务器 → 页面）。WebSocket 需要手写帧协议，零依赖约束下成本远高于收益。

**代价**：页面到服务器仍走普通 POST，这是 SSE 的常规形态，不是缺陷。

### 决策 8：状态落盘只存索引，对话复用 SDK 会话文件

**选择**：`~/.taskloop/state.json` 保存循环状态、任务元数据、日志环形缓冲。agent 对话全文不写入状态文件，改为记录会话文件路径。

**理由**：SDK 的会话管理器本来就把每个任务的完整对话写成 JSONL。重复存一份会让状态文件体积随对话长度增长（一个任务几万字），而索引只随任务数增长。

**代价**：查看历史任务详情需要读 SDK 会话文件，依赖其格式稳定。可接受——该格式是有文档的持久化契约。

### 决策 9：继承 `~/.pi/agent`，但不授予项目信任

**选择**：`createAgentSession({ agentDir: <默认 ~/.pi/agent>, cwd: workdir })`，显式补齐 code-mode / tool-search / MCP 三个内置扩展。项目信任保持默认（无人值守下等同跳过受保护资源）。

**理由**：用户级配置（设置、凭据、扩展、技能、包）是用户主动安装的，继承它是这次变更的核心收益之一。项目级资源来自工作目录，可能来自任意一个 clone 下来的仓库；后台自动信任等于自动执行任意代码。

**代价**：用户把 `workdir` 指到一个项目时，项目的 `.pi/skills`、`.pi/extensions` 不会生效，而 `AGENTS.md` 会生效——这个不对称必须在页面和文档里说清楚，否则用户会以为配好了。

### 决策 10：CommonJS 通过动态 `import()` 桥接 ESM

**选择**：`src/sessionRunner.js` 内部惰性加载 SDK：首次使用时 `await import('@earendil-works/pi-coding-agent')` 并缓存模块引用。

**理由**：SDK 是 ESM-only（`"type": "module"`，exports 仅提供 `import` 条件），项目是 CommonJS。动态 `import()` 是 Node 官方支持的桥接方式，不需要把整个项目改成 ESM。

**代价**：SDK 调用点必须是 async；测试注入改为传入 `createSession` 函数而非 mock 模块。

### 决策 11：工作目录字段

**选择**：`workdir`，缺省 `~/.taskloop/workdir`，支持 `~` 展开，不存在则自动创建，创建失败才报错。

**理由**：`cwd` 同时决定项目资源发现、会话分组、工具相对路径。当前 `main.js` 硬编码为 taskloop 根目录，打成 npm 包后那是包安装目录，不是用户想干活的地方。自动创建而非报错，是因为首次启动时它必然不存在。

### 决策 12：视觉语言

原型见 `docs/prototype/index.html`（截图在 `docs/prototype/shot-*.png`）。设计主张与实现约束：

- 三种文本三种视觉重量：系统事件用等宽小字灰、工具调用用等宽正文、agent 文本用衬线。整页等宽、只有 agent 文本是衬线，让"谁在说话"一眼可辨。
- 层级用左侧细竖线表示（每层一根），不用卡片、圆角、阴影、渐变。
- 颜色只编码状态，四个状态色均通过 WCAG AA 对比度检查。
- 无外链资源：不引 CDN，全部系统字体栈。

## Risks / Trade-offs

- **agent 派生的孙进程带崩整个页面** → 同进程无法避免。缓解：任务级超时上限（任务配置项），超出后中止会话；页面断线重连时重新拉取状态快照。
- **`pi-permission-system` 这类扩展会拦截后台 agent 的文件访问** → 这是用户配置的直接后果，不是缺陷。缓解：在文档与页面错误详情里保留扩展给出的拒绝原因，让用户知道是策略拦的不是代码挂了。
- **TUI 类扩展在无 TUI 环境下可能抛错** → 文档未承诺。缓解：把"在只装了终端类扩展的机器上启动一次并确认不崩"作为实现阶段的验证步骤；若确实抛错，用 `DefaultResourceLoader` 的扩展过滤排除它们。
- **依赖树体积**（SDK 的直接依赖 17 个） → 缓解：接受。这是产物定位的必要代价；`npm i -g` 的安装时长写进 README 预期。
- **`session.abort()` 是协作式的，可能停在文件改到一半** → 缓解：停止前二次确认；任务记录区分"已中止"与"失败"；页面显示"停止中"中间态而不是直接跳"已停止"。
- **状态写盘遇硬杀会丢最后一次变更** → 缓解：状态变更后立即写盘而非批量落盘；启动时把"执行中"记录改为"已中断"；状态文件损坏时以空历史启动并保留原文件。
- **配置结构变更会破坏存量 `config.json`** → 缓解：出现 `agent` 字段时报明确错误并指向迁移说明，而不是静默忽略。

## Migration Plan

1. 版本号 `0.4.2` → `1.0.0`（破坏性变更，按项目约定升 major）。
2. 首次启动新版本时，若 `~/.taskloop/config.json` 不存在而旧路径存在，不自动迁移——配置结构已变，自动转换会掩盖字段语义差异。改由错误消息和 README 指引用户手工改写四个字段：`agent`/`{agent}` 块 → 顶层 `model` / `thinking`，新增 `workdir`。
3. 回滚：`git revert` 本分支的提交。旧版本的 CLI 入口在回滚后即恢复；新版本写出的 `state.json` 不影响旧版本（旧版本不读它）。
4. 数据无迁移：任务历史与会话文件都是新产物，回滚后不会残留冲突。
