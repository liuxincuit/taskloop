# Proposal

## Why

taskloop 现在只能靠命令行启停：进程一启动就开始轮询，想知道它正在做什么必须盯着控制台，改一行配置得停掉重来。同时它依赖物理机 PATH 里存在 `pi` 或 `claude` 二进制，这使它无法作为一个 npm 包分发到别的机器。

pi 的 SDK 允许在同一个 Node 进程内创建 agent session，并以结构化事件（消息增量、工具调用、轮次边界）报告执行过程。这恰好是页面"看进度"所需的数据源，同时消除了子进程、临时 prompt 文件、Windows 引号处理、进程树强杀这一整套复杂度。

## What Changes

- **BREAKING** 移除 `claude` 后端与所有 CLI 调用路径：删除 `src/claudeRunner.js`、`src/piRunner.js`、`src/args.js`、`src/agents.js`，不再需要 PATH 中存在 `pi` / `claude` 二进制
- **BREAKING** `config.json` 结构拍平：移除顶层 `agent` 字段和 `{agent}` 命名配置块，模型与推理强度改为顶层 `model` / `thinking` 字段；同时新增 `workdir`
- **BREAKING** 版本号升为 `1.0.0`（破坏性变更）
- 新增基于 pi SDK 的同进程 agent 执行层，通过 `session.subscribe()` 采集执行事件，通过 `session.abort()` 实现协作式停止
- 新增 Web 界面（`node src/server.js`）：进度视图（规则状态、轮次、任务、工具调用、agent 文本流）、启动/停止/立即执行一轮、配置表单
- 新增进度落盘：循环状态、任务历史、日志按 `~/.taskloop/state.json` 与 `~/.taskloop/logs/` 持久化，重启后保留并标记中断任务
- 新增运行目录约定：配置、状态、日志、会话、agent 工作目录统一收敛到 `~/.taskloop/`
- 保留 `node src/main.js` 作为纯 CLI 入口（不启动页面），与页面模式共用同一套循环实现

## Capabilities

### New Capabilities

- `worker-loop`: 轮询循环的生命周期与执行语义——启动、停止、协作式中止当前任务、立即执行一轮、轮次与任务统计、失败不中断整轮
- `agent-execution`: 通过 pi SDK 在进程内执行 prompt——session 创建与销毁、事件采集（文本增量/工具调用/轮次）、成功与失败判定、继承 `~/.pi/agent` 配置
- `web-console`: HTTP 服务与浏览器界面——进度视图的 SSE 实时推送、启动/停止/立即执行一轮的控制接口、空闲态与历史展示
- `config-management`: 配置文件的位置、读取、校验与表单化编辑——原始 JSON 往返、`~/.taskloop/config.json` 定位、`workdir` 解析与目录创建
- `state-persistence`: 运行状态与历史的落盘与重启恢复——状态文件结构、日志保留、重启后中断任务标记

### Modified Capabilities

（无。项目当前没有任何已归档的 spec，本次五个 capability 均为新增。）

## Impact

**代码**

- 删除：`src/agentRunner.js`、`src/piRunner.js`、`src/claudeRunner.js`、`src/args.js`、`src/agents.js`
- 新增：`src/worker.js`（循环与生命周期）、`src/server.js`（HTTP 入口）、`src/sessionRunner.js`（SDK 执行层）、`src/state.js`（落盘）、`src/routes.js`（接口），以及页面静态资源目录
- 改造：`src/main.js`（缩为纯 CLI 入口）、`src/config.js`（拆出 `readRawConfig` + `validateConfig`，新增 `workdir`）
- 保留：`src/youTrack.js`、`src/wiki.js`、`src/jira.js`、`src/scrum.js`、`src/sources.js`、`src/filter.js`、`src/template.js`、`src/env.js` 不变

**依赖**

- 新增运行时依赖 `@earendil-works/pi-coding-agent`（含其依赖树），项目不再是"零第三方依赖"
- 该包为 ESM-only，CommonJS 代码通过动态 `import()` 加载

**测试**

- 删除：`test/agentRunner.test.js`、`test/piRunner.test.js`、`test/claudeRunner.test.js`、`test/args.test.js`
- 重写：`test/config.test.js`（配置结构变更）、`test/main.test.js`（循环拆到 worker）
- 新增：worker 生命周期、状态落盘、HTTP 接口、SDK 执行层（注入 mock session）的测试

**运行环境**

- Node.js ≥ 18 的要求不变（动态 `import()` 需要）
- 模型凭据改由 `envFile` 指向的 `KEY=VALUE` 文件提供，不再是"pi 已登录"

**安全**

- 服务必须绑定 `127.0.0.1`：页面等价于"启动任意 agent 命令"的入口
