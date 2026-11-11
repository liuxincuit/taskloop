# AGENTS.md

taskloop：定时从 YouTrack / Supermap Wiki / Supermap Jira 按标签抓取任务，交给所选 AI Agent（pi / claude）非交互模式执行的循环 Worker。零第三方依赖的 Node.js 项目（仅内置模块），CommonJS。

## 运行与测试

- 入口：`node src/server.js`（页面模式，默认 `http://127.0.0.1:4789/`）；`node src/main.js [config.json 路径]`（纯 CLI 循环）
- 默认配置位置：`~/.taskloop/config.json`，状态与会话在 `~/.taskloop/`
- 测试：`npm test`（Node 内置 node:test + node:assert，自动发现 test/*.test.js）。禁止引入 jest/mocha 等第三方测试框架；修改代码后必须运行 npm test 验证通过

## 代码约定（违反会出错）

- **第三方依赖仅限 pi SDK**：只允许 `@earendil-works/pi-coding-agent` 及其传递依赖，其余一律用 Node 内置模块。新增其他依赖需要先说明理由
- **CommonJS**：用 `require`/`module.exports`，不要写 ESM `import/export`。pi SDK 是 ESM-only，必须用动态 `await import()` 桥接（见 `src/sessionRunner.js` 的 `loadSdk()`），不要改 `"type": "module"`
- **扩展走注册表，只写实现不注册不会生效**：新任务来源 → 新建 `src/<name>.js` 导出 `fetchTasks(rule, { httpClient, url, token })`，并在 `src/sources.js` 注册（tokenEnv/urlEnv/defaultUrl/placeholders）；HTTP 请求复用 `src/youTrack.js` 的 `createHttpClient`（依赖注入，便于 mock）。**执行层已固定为 pi SDK，不再有 agent 注册表**——`agents.js` / `args.js` / `piRunner.js` / `claudeRunner.js` / `agentRunner.js` 已删除，不要再加回来
- **来源解耦**：`worker.js` 不得感知具体来源，`rule.source` 的一切处理都经 `sources.js` 注册表分发；页面表单的来源选项从 `GET /api/config` 的 `options.sources` 读取，新增来源后自动出现，不需要改前端
- **中文错误消息**：src/ 的校验错误消息是中文，且被 test/ 正则断言（如 `/intervalSeconds 必须是正整数/`），改措辞会挂测试
- **模板占位符**：任务级占位符由来源注册表声明（youtrack: {youtrack_id}/{youtrack_url}；wiki: {wiki_id}/{wiki_url}；jira: {jira_id}/{jira_url}；scrum: {scrum_id}/{scrum_url}），无值时原样保留；规则级 {labels}、{not_labels} 替换自规则配置
- 版本号：修改 src/ 代码后，在该次改造的收尾提交按改造性质升 package.json version——feat（新功能）→ minor（0.1.0 → 0.2.0）、fix/refactor → patch、破坏性变更 → major；仅改 docs/、README、test/（补用例）、模板不升；不打 git tag

## 配置文件

- 默认位置是 `~/.taskloop/config.json`（不再读当前目录的 config.json）；改配置结构时同步更新 `config.example.json` 与 README 的「配置详解」「从 0.4.x 迁移」两节
- 配置是**拍平结构**：顶层 `intervalSeconds` / `model` / `thinking` / `workdir` / `sessionDir` / `envFile` / `rules`。**没有 `agent` 字段与 `{agent}` 配置块**，出现时 `validateConfig` 报错并给出迁移提示
- 表单编辑走 `readRawConfig` + `validateConfig` 两段，**不能直接用 `loadConfig()` 的返回值渲染表单**：那里面的路径已被解析成绝对路径，回写会把相对路径固化、并丢掉表单不认识的字段
- templates/ 下除 analyze.md / example-workflow.md / scrum-test.md 外均被 .gitignore 忽略（个人模板不提交），需要提交新模板须改 .gitignore
- 环境变量：`SUPERMAP_YOUTRACK_TOKEN`、`SUPERMAP_WIKI_TOKEN`、`SUPERMAP_JIRA_TOKEN`、`SUPERMAP_SCRUM_TOKEN`（对应来源必需，缺失启动即报错退出）；`YOUTRACK_URL`、`WIKI_URL`、`JIRA_URL`、`SCRUM_URL`（可选，覆盖默认地址）
- 模型凭据不通过 config 字段传递：用 `envFile` 指向的 `KEY=VALUE` 文件，或沿用 `~/.pi/agent/auth.json` 里已保存的凭据
