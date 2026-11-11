# Tasks

## 1. 依赖与执行层基础

- [ ] 1.1 在 `package.json` 添加 `@earendil-works/pi-coding-agent` 依赖并安装，验证方式：`node -e "import('@earendil-works/pi-coding-agent').then(m=>console.log(m.VERSION))"` 能从项目目录解析并输出版本号
- [ ] 1.2 实现 `src/sessionRunner.js`：惰性 `await import()` 缓存 SDK 模块，支持注入 `createSession` 便于测试，创建 session、提交 prompt、成功时取 `getLastAssistantText()`、失败时带回错误原因、结束时 `dispose()`；验证方式：新增 `test/sessionRunner.test.js` 用 mock session 覆盖成功/失败/销毁三条路径并通过
- [ ] 1.3 在 `sessionRunner` 中实现事件采集与文本增量合并（约 100ms 一批），验证方式：`test/sessionRunner.test.js` 断言 200 个连续文本增量产生的推送事件数远小于 200，且拼接后的文本与原始输入一致
- [ ] 1.4 在 `sessionRunner` 中实现协作式中止，验证方式：`test/sessionRunner.test.js` 断言中止期间调用 `session.abort()`，且该任务结果被标记为"已中止"而非"失败"

## 2. 配置改造

- [ ] 2.1 把 `src/config.js` 拆分为 `readRawConfig(path)`（读文件 + JSON 解析 + 顶层类型检查）与 `validateConfig(raw, configDir)`（字段校验 + 路径解析），移除 `agent` 字段与 `{agent}` 配置块校验，新增顶层 `model` / `thinking` / `workdir`；验证方式：重写 `test/config.test.js`，覆盖缺失字段、非法 `thinking`、遗留 `agent` 字段报错三类用例并通过
- [ ] 2.2 实现 `workdir` 解析：`~` 展开、相对 config 目录解析为绝对路径、缺省 `~/.taskloop/workdir`、目录不存在时自动创建、创建失败返回中文错误；验证方式：`test/config.test.js` 新增四个用例（缺省值、`~` 展开、自动创建、创建失败）并通过
- [ ] 2.3 更新 `config.example.json` 与 README 的「配置详解」章节为拍平后的结构；验证方式：README 中给出的示例配置能被 `validateConfig` 直接通过（写成一个测试用例）

## 3. 循环与生命周期

- [ ] 3.1 抽出 `src/worker.js`，暴露 `start()` / `stop()` / `wake()` / `snapshot()`，把原 `main()` 里的 `while` 循环、`sleep` 与轮次计数迁入；`src/main.js` 缩为纯 CLI 入口；验证方式：新增 `test/worker.test.js` 覆盖启动后按间隔重复、停止后不再开始新轮次、`wake()` 提前唤醒三条路径并通过
- [ ] 3.2 停止语义改为协作式中止：中止当前任务、对外报告"停止中"中间态、中止的任务记为"已中止"，并移除 `src/main.js` 中 SIGINT handler 里的 `spawnSync` + `taskkill` 进程树清理（agent 已不再是子进程，没有进程树可杀）；验证方式：`test/worker.test.js` 覆盖"有任务在跑时停止"和"仅在等待时停止"两种情况，断言前者产生已中止记录并经过停止中状态
- [ ] 3.3 迁移 `test/main.test.js` 中针对 `runCycle` 的用例到 `test/worker.test.js`，验证方式：单轮内同任务只执行一次、单规则抓取失败继续、模板渲染失败跳过、`config.model` 与 `config.thinking` 透传给执行层四类用例全部通过
- [ ] 3.4 删除 `src/agentRunner.js`、`src/piRunner.js`、`src/claudeRunner.js`、`src/args.js`、`src/agents.js` 及对应的四个测试文件；验证方式：`npm test` 全绿，且 `grep -rn "child_process" src/` 无任何匹配（`main.js` 的 `spawnSync` 已在 3.2 移除，剩下的 HTTP 抓取走 `node:http`）

## 4. 状态持久化

- [ ] 4.1 实现 `src/state.js`：读写 `~/.taskloop/state.json`、自动创建目录、任务历史与日志环形缓冲的上限、变更后立即写盘；验证方式：`test/state.test.js` 覆盖读写往返、超上限丢弃最旧、写盘失败不抛到调用方三条路径并通过
- [ ] 4.2 实现重启恢复：启动时读取状态文件、把"执行中"记录改为"已中断"、状态文件损坏时以空历史启动并保留原文件；验证方式：`test/state.test.js` 覆盖正常恢复、中断标记、损坏文件三种场景并通过
- [ ] 4.3 在任务记录中保存 SDK 会话文件路径而不是对话全文；验证方式：`test/state.test.js` 断言写出的状态文件体积不随对话文本长度增长（构造一份长文本任务记录前后对比）

## 5. Web 服务

- [ ] 5.1 实现 `src/server.js` 与 `src/routes.js` 骨架，仅监听 `127.0.0.1`，端口占用时以明确错误退出；验证方式：新增 `test/server.test.js` 用端口 `0` 起真实服务，断言监听地址为回环地址、占用端口时报错
- [ ] 5.2 实现 `GET /api/state` 状态快照接口，返回运行状态、轮次、唤醒剩余时间与各规则进度；验证方式：`test/server.test.js` 断言运行中与已停止两种状态下返回的字段差异
- [ ] 5.3 实现 `GET /api/events` 服务器推送事件流，含断线后重连时的状态补齐；验证方式：`test/server.test.js` 断言响应头为事件流类型、能收到至少一条状态事件
- [ ] 5.4 实现 `POST /api/start`、`POST /api/stop`、`POST /api/wake` 三个控制接口，并在当前状态不允许时返回明确拒绝；验证方式：`test/server.test.js` 覆盖运行中/已停止/停止中三种状态下的接口可用性矩阵
- [ ] 5.5 在 README 补充页面模式的启动方式、默认端口与目录约定；验证方式：按 README 写的命令启动一次，能打开页面并看到状态

## 6. 页面

- [ ] 6.1 把 `docs/prototype/index.html` 落地为 `src/ui/` 下的进度视图：轮次/规则/任务三层结构、左侧层级竖线、三种文本视觉层次、空闲态显示上一次运行结果；验证方式：浏览器打开后启动循环，能看到任务从排队到执行中到完成的完整流转
- [ ] 6.2 实现配置表单：运行参数区与规则卡片增删，来源与模板为下拉选择、标签为可增删的条目；验证方式：浏览器中增删规则并保存后重新打开页面，改动生效，且手写的相对路径与未知字段未被改写
- [ ] 6.3 实现停止二次确认与"停止中"中间态；验证方式：浏览器中点击停止出现确认、取消后状态不变、确认后显示停止中再变为已停止，三个分支各验一次
- [ ] 6.4 校验页面自包含与响应式；验证方式：对 `src/ui/` 下每个文件执行 `grep -E 'https?://'` 均无匹配（`MUST NOT` 扫描 `docs/`——那里有历史设计文档本就带外部链接，会误报），并在 560px 宽度下截图确认顶栏控制项可见、正文正常换行

## 7. 集成与交付

- [ ] 7.1 端到端验证：用 mock 任务来源与 mock 模型会话跑完整一轮，验证方式：页面能看到规则抓取数、任务执行层级、工具调用与文本流，且 `npm test` 全绿
- [ ] 7.2 扩展兼容性验证：在装有终端类扩展（会操作 TUI 的扩展）的环境里以页面模式启动并执行一个任务，验证方式：进程不崩溃，若扩展报错则确认在 `DefaultResourceLoader` 中用扩展过滤排除并记录在 README
- [ ] 7.3 升版本号 `0.4.2` → `1.0.0`，补齐 README 的运行目录约定、依赖说明与配置迁移指引；验证方式：`npm test` 全绿，`package.json` 版本正确，README 的迁移章节能指导一份旧的带 `agent` 字段配置改写成新结构
- [ ] 7.4 为 `package.json` 添加 `bin` 入口（指向页面模式入口）并移除 `private: true`；验证方式：`npm pack --dry-run` 的产物列表包含该入口文件，且 `package.json` 中不再有 `private` 字段
- [ ] 7.5 删除 README 的「扩展新 Agent」整节——它引用 `src/args.js`、`src/agents.js`、`src/agentRunner.js`，这些文件已在 3.4 删除；验证方式：`grep -nE "src/agents\.js|src/args\.js|src/piRunner\.js|src/claudeRunner\.js" README.md` 无匹配

## Workflow follow-up

- 变更归档前确认审查要求已满足。
- 归档后运行 `openspec archive add-web-ui-and-sdk`，把五个 capability 落入主 specs。
- 合并 `feature/web-ui-and-sdk` 分支（视审查结果决定是否保留为独立提交序列）。
