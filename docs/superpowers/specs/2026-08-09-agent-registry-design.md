# Agent 注册表架构（agent-registry）设计

日期：2026-08-09
状态：已批准（用户逐节确认）

## 背景与目标

taskloop 目前只支持 pi 一个 AI Agent：`src/piRunner.js` 硬编码 `spawn('pi', ['-p', '@tmpfile', '--session-dir', dir])`，`src/main.js` 硬编码 `piPath: 'pi'` 与顶层 `sessionDir`。

目标：**架构层面兼容更多 agent 命令（opencode、claude code、codex 等），但本次不实现任何新 agent 适配器**。只把执行层抽象为注册表模式，pi 是唯一（且首个）adapter，扩展点与文档就位，未来加 agent 只需两步。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| agent 选择粒度 | 全局一个：config 顶层 `agent` 字段，缺省 `'pi'`；不支持 per-rule agent |
| 实现范围 | 只做架构兼容，不实现 opencode/claude/codex 适配器；注册表只放 pi |
| agent 专属配置位置 | 顶层按 agent 名命名的配置块：`{ "agent": "pi", "pi": { ... } }` |
| 顶层 `sessionDir` | 直接迁移进 `pi` 块，不留向后兼容 |
| 适配器接口 | 纯函数 `buildArgs(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args }`；临时文件/spawn/退出码/SIGINT 由通用层统一负责 |
| `pi.path` | 现有 `deps.piPath`（缺省 `'pi'`，可执行文件名或完整路径）迁移为 pi 块可选配置，缺省 `'pi'` |
| 未知 agent 块 | 非当前 agent 名的顶层块不校验不报错（与现有顶层宽松风格一致） |

## 配置格式

```jsonc
{
  "intervalSeconds": 60,
  "agent": "pi",                     // 可选，缺省 "pi"；必须 ∈ 注册表 keys，否则启动报错
  "pi": {                            // agent 专属配置块，块名 = agent key；可选
    "sessionDir": "./.pi-sessions",  // pi 专属：会话保存目录（相对 config 文件解析），缺省 configDir
    "path": "pi"                     // pi 专属：可执行文件名或完整路径，缺省 "pi"
  },
  "rules": [...]                     // 不变
}
```

顶层 `sessionDir` 不再支持。

### 校验规则（src/config.js）

| 场景 | 行为 |
|---|---|
| `agent` 缺省 | `'pi'` |
| `agent` 非法（非字符串 / 不在注册表） | 启动报错 exit 1，错误消息列出合法值（随注册表自动扩展） |
| `[agent]` 块（如 `pi`）缺省 | 空对象 |
| `[agent]` 块非对象（如数组） | 启动报错 exit 1 |
| 块内出现未声明的 key | 启动报错：`pi 配置块不允许字段 "xxx"，允许: sessionDir, path`（允许列表来自注册表 optionKeys） |
| `sessionDir` 缺省 | config 文件所在目录（与现状行为一致） |
| `path` 缺省 | `'pi'` |
| 非当前 agent 名的顶层块 | 不校验不报错 |

## 目录结构变化

```
src/
  agents.js       # 新增：agent 注册表 + AGENT_KEYS
  agentRunner.js  # 新增：通用执行层（临时文件、spawn、退出码、清理、win32 引号、onChild）
  piRunner.js     # 改造：仅保留 buildPiArgs 纯函数（pi 适配器）
  main.js         # deps.runPi/piPath → deps.runAgent；agentConfig 传入
  config.js       # 新增 agent 与 agent 块校验，sessionDir 解析进 agentConfig
  ...（其余不变）
```

## 组件职责与接口

### src/agents.js（注册表）

仿照 sources.js：

```js
const { buildPiArgs } = require('./piRunner.js');

// 新增 agent：创建 src/<name>.js 导出 build<Name>Args(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args }，
// 然后在此注册一行（buildArgs 实现 + optionKeys 专属配置项声明）
const agents = {
  pi: {
    buildArgs: buildPiArgs,
    optionKeys: ['sessionDir', 'path'],
  },
};

const AGENT_KEYS = Object.keys(agents);

module.exports = { agents, AGENT_KEYS };
```

注册后自动获得：config 的 `agent` 校验、`[agent]` 块 key 校验、main 的分发、通用执行层（临时文件/SIGINT/退出码）。

### src/piRunner.js（pi 适配器）

```js
// buildPiArgs(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args }
// cmd: agentConfig.path ?? 'pi'
// args: ['-p', '@' + tmpFile, '--session-dir', agentConfig.sessionDir]
```

纯函数，不 spawn、不碰文件系统。

### src/agentRunner.js（通用执行层）

```js
runAgent(prompt, { agent, cwd, agentConfig, spawnFn, onChild }) → { exitCode }
```

职责（从现有 runPi 平移，行为不变）：
1. prompt 写入 `os.tmpdir()` 临时文件（文件名含唯一标识：pid+时间戳+随机数）
2. `agents[agent].buildArgs(prompt, { tmpFile, cwd, agentConfig })` 取 `{ cmd, args }`
3. `spawn(cmd, args, { cwd, stdio: 'inherit', ...(win32 ? { shell: true } : {}) })`
4. win32 引号处理留在通用层（对非 flag 参数包引号，行为与现状一致）
5. `onChild` 回调、`error` 事件 reject、`exit` 事件返回退出码（非零不抛异常）
6. finally 删除临时文件

### src/main.js

- deps：`runPi` → `runAgent`；删除 `piPath: 'pi'`
- runCycle 调用：`deps.runAgent(prompt, { agent: config.agent, cwd, agentConfig: config.agentConfig, onChild })`
- `config.agentConfig` 由 config.js 解析：`{ sessionDir: <绝对路径>, path: 'pi' | 用户值 }`

### src/config.js

- 新增 `agent`、`[agent]` 块校验（见校验规则表）
- 返回值增加 `agent`、`agentConfig`：`sessionDir` 相对 config 文件解析为绝对路径，`path` 透传

## 数据流（一轮内单任务执行）

```
渲染 prompt
  └→ deps.runAgent(prompt, { agent, cwd, agentConfig, onChild })
        ├→ 写临时文件
        ├→ agents[agent].buildArgs(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args }
        ├→ spawn(cmd, args, { cwd, stdio: 'inherit' })
        └→ 返回 { exitCode }；finally 删临时文件
```

## 错误处理

| 场景 | 行为 |
|---|---|
| `agent` 非法 / agent 块未知 key / 块非对象 | 启动时报错退出（exit 1），消息含合法值列表 |
| agent 可执行文件不存在（spawn error） | reject 冒泡到 runCycle 顶层 catch，记日志，本轮中止，下一轮继续 |
| 单任务执行非零退出码 | 记日志（含退出码），继续下一个任务 |
| Ctrl+C（SIGINT） | 不变：kill 当前子进程（win32 进程树）→ 清理临时文件 → exit 0 |

## 测试设计

`node --test` 运行，全部单测，不 spawn 真实进程；外部依赖通过参数注入 mock。

| 测试文件 | 覆盖内容 |
|---|---|
| `test/piRunner.test.js`（改造） | `buildPiArgs` 纯函数：`-p @tmpfile --session-dir` 参数形状、path 缺省 `'pi'`/自定义、sessionDir 透传 |
| `test/agentRunner.test.js`（新增） | mock spawn：临时文件内容为 prompt、spawn 参数来自注册表 buildArgs、退出码返回、临时文件清理、onChild 回调、spawn error reject、非零退出码不抛异常、win32 引号行为 |
| `test/config.test.js`（扩展） | agent 缺省 `'pi'`、非法 agent 报错（消息含合法值）、pi 块未知 key 报错（消息含允许值）、pi 块非对象报错、sessionDir 相对路径解析、path 缺省 |
| `test/main.test.js`（改造） | deps 注入 `runAgent` + `agentConfig`，验证按 agent 分发调用、执行顺序与去重逻辑不变 |

## 文档

README 更新：
1. 配置详解：顶层 `agent` 字段、agent 专属配置块（以 pi 为例说明 `sessionDir`/`path`）
2. 新增「扩展新 Agent」一节（与「扩展新来源」姊妹篇）：两步添加新 agent——创建 `src/<name>.js` 导出 `build<Name>Args` 纯函数、在 `src/agents.js` 注册一行声明 `optionKeys`；自动获得 config 校验、分发、临时文件与 SIGINT 处理
3. 「快速开始」不变（缺省 pi 零改动）

## 明确不做（YAGNI）

- 不实现 opencode / claude code / codex 适配器（本次只做架构兼容）
- 不做顶层 `sessionDir` 向后兼容
- 不做 per-rule agent 选择
- 不做 agent 热切换 / 多 agent 并行

## 验证标准

1. `npm test` 全部通过
2. 现有 config.json 手动迁移（顶层 `sessionDir` 移入 `pi` 块）后行为与迁移前一致
3. `config.example.json` 同步更新
