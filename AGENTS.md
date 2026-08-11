# AGENTS.md

taskloop：定时从 YouTrack / Supermap Wiki 按标签抓取任务，交给所选 AI Agent（pi / claude）非交互模式执行的循环 Worker。零第三方依赖的 Node.js 项目（仅内置模块），CommonJS。

## 运行与测试

- 入口：`node src/main.js [config.json 路径]`（package.json 没有 start script）
- 测试：`npm test`（Node 内置 node:test + node:assert，自动发现 test/*.test.js）。禁止引入 jest/mocha 等第三方测试框架；修改代码后必须运行 npm test 验证通过

## 代码约定（违反会出错）

- **零第三方依赖**：只允许 Node 内置模块（node:fs、node:http 等），不要 npm install 任何包
- **CommonJS**：用 `require`/`module.exports`，不要写 ESM `import/export`
- **中文错误消息**：src/ 的校验错误消息是中文，且被 test/ 正则断言（如 `/agent 必须是 "pi"/`），改措辞会挂测试
- **扩展走注册表，只写实现不注册不会生效**：新任务来源 → 新建 `src/<name>.js` 导出 `fetchTasks(rule, { httpClient, url, token })`，并在 `src/sources.js` 注册（tokenEnv/urlEnv/defaultUrl）；HTTP 请求复用 `src/youTrack.js` 的 `createHttpClient`（依赖注入，便于 mock）。新 agent → 新建 `src/<name>.js` 导出 `build<Name>Args(prompt, { tmpFile, cwd, agentConfig })` 纯函数，并在 `src/agents.js` 注册（含 optionKeys）；返回 `{ cmd, args }`，若 prompt 走 stdin（如 claude）返回 `{ cmd, args, stdin: true }`，由 agentRunner 写入子进程 stdin
- **模板占位符**：任务级 `{youtrack_id}`、`{wiki_url}` 无值时原样保留不替换；规则级 `{labels}`、`{not_labels}` 替换自规则配置

## 配置文件

- `config.json` 是本地配置（.gitignore 忽略，不提交）；改配置结构时同步更新 `config.example.json`
- templates/ 下除 analyze.md 外均被 .gitignore 忽略（个人模板不提交），需要提交新模板须改 .gitignore
- 环境变量：`SUPERMAP_YOUTRACK_TOKEN`、`SUPERMAP_WIKI_TOKEN`（对应来源必需，缺失启动即报错退出）；`YOUTRACK_URL`、`WIKI_URL`（可选，覆盖默认地址）
