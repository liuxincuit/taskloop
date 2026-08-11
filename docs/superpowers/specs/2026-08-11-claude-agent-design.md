# Claude Code Agent 适配器（claude-agent）设计

日期：2026-08-11
状态：已批准（用户逐节确认）

## 背景与目标

taskloop 目前只支持 pi 一个 AI Agent。2026-08-09 的 agent-registry 设计已把执行层抽象为注册表模式，并在「明确不做（YAGNI）」中注明 claude 适配器不在当时范围内。本次实现第二个适配器：**Claude Code CLI（`claude`）**，验证注册表扩展点并投入使用。

目标：`config.json` 顶层 `agent` 切到 `"claude"` 后，任务 prompt 交由 `claude -p` 非交互执行，与 pi 共用临时文件/spawn/退出码/SIGINT 通用层。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 权限模式 | 硬编码 `--permission-mode bypassPermissions`（等价 `--dangerously-skip-permissions`），不做配置项；用户明确选择全放行 |
| prompt 传参 | **stdin 管道**：`claude -p` 不带 prompt 参数时从 stdin 读；适配器返回 `stdin: true` 声明，通用层写管道。不用内联 argv |
| 为何不内联 argv | win32 下 agentRunner 走 `shell: true` + 手动包引号，prompt 含 `"`/反引号/`$()`/换行会被 cmd.exe 拆坏，且无法鲁棒转义；stdin 完全绕开，顺带消掉 128KB 单参数上限与 ps 可见性 |
| 配置项 | 仅 `path`（可执行文件名或完整路径，缺省 `'claude'`）。不新增 model/budget/session 等 |
| win32 验证 | 开发环境为 Linux，win32 分支真实行为无法在本机验证；stdin 走 shell:true 由 cmd.exe 转发，理论可用，需 Windows 真机确认 |

## 配置格式

```jsonc
{
  "agent": "claude",           // 切到 claude；pi 仍是缺省
  "claude": {                  // agent 专属配置块，块名 = agent key
    "path": "claude"           // 可执行文件名或完整路径，缺省 "claude"
  },
  "rules": [...]
}
```

claude 块只允许 `path`；出现其他字段（如 `sessionDir`、`model`）启动报错 `claude 配置块不允许字段 "xxx"，允许: path`。

## 组件职责与接口

### src/claudeRunner.js（新增，claude 适配器）

```js
function buildClaudeArgs(prompt, { agentConfig }) {
  const cmd = agentConfig?.path ?? 'claude';
  const args = ['-p', '--permission-mode', 'bypassPermissions'];
  return { cmd, args, stdin: true };
}
```

- 纯函数，不 spawn、不碰文件系统
- `-p` 不带 prompt 参数 → claude 从 stdin 读 prompt
- `args` 全是 flag 与纯字面量（无路径、无 prompt 内容），win32 包引号安全
- 返回值新增 `stdin: true`：向通用层声明「prompt 走 stdin 管道」，pi 不返回此字段（走原路径）

### src/agents.js（注册表扩展）

```js
const { buildClaudeArgs } = require('./claudeRunner.js');

const agents = {
  pi: { buildArgs: buildPiArgs, optionKeys: ['sessionDir', 'path'] },
  claude: {
    buildArgs: buildClaudeArgs,
    optionKeys: ['path'],
  },
};
```

`AGENT_KEYS` 变为 `['pi', 'claude']`。

### src/agentRunner.js（通用层扩展 stdin）

`buildArgs` 返回值从 `{ cmd, args }` 扩展为可选的 `{ cmd, args, stdin }`（`stdin` 缺省 falsy，pi 行为不变）：

```js
const { cmd, args, stdin } = agents[agent].buildArgs(prompt, { tmpFile, cwd, agentConfig });
...
stdio: stdin ? ['pipe', 'inherit', 'inherit'] : 'inherit',
...
if (stdin) {
  child.stdin.on('error', () => {});   // EPIPE：子进程提前退出时忽略
  child.stdin.write(prompt);
  child.stdin.end();
}
```

- pi 不声明 stdin → 原 `stdio: 'inherit'`，零行为变化
- claude 声明 → `stdio: ['pipe', 'inherit', 'inherit']`，prompt 写入 stdin 后 end
- 临时文件仍照常写入/删除（pi 用 `@tmpfile`；claude 用不上但保留统一接口）

### src/config.js（缺省修正）

`agentConfig.path` 缺省值由硬编码 `'pi'` 改为 agent key：`path: agentBlock?.path ?? agent`。
pi 仍缺省 `'pi'`、claude 缺省 `'claude'`，行为对 pi 不变。

claude 的 `agentConfig` 仍含 `sessionDir`（解析为 configDir，闲置不用）——保持现有 shape 不改，最小改动。

## 数据流（一轮内单任务执行，claude）

```
渲染 prompt
  └→ deps.runAgent(prompt, { agent: 'claude', cwd, agentConfig, onChild })
        ├→ 写临时文件（claude 不用，但通用层照常）
        ├→ buildClaudeArgs(prompt, { agentConfig }) → { cmd: 'claude', args: ['-p', '--permission-mode', 'bypassPermissions'], stdin: true }
        ├→ spawn(claude, args, { cwd, stdio: ['pipe', 'inherit', 'inherit'] })
        ├→ child.stdin.write(prompt); child.stdin.end()
        └→ 返回 { exitCode }；finally 删临时文件
```

## 错误处理

| 场景 | 行为 |
|---|---|
| claude 块未知 key / 块非对象 | 启动报错 exit 1，错误消息列出允许值（随注册表 optionKeys） |
| `agent` 为 pi 时 claude 块存在 | 不校验不报错（与现有顶层宽松风格一致） |
| claude 可执行文件不存在（spawn error） | reject 冒泡到 runCycle 顶层 catch，记日志，本轮中止，下一轮继续 |
| 子进程提前退出导致 EPIPE | `child.stdin.on('error')` 忽略，不崩不挂 |
| 非零退出码 | 记日志（含退出码），继续下一个任务 |
| Ctrl+C（SIGINT） | 不变：kill 当前子进程 → 清理临时文件 → exit 0 |

## 测试设计

`node --test` 运行，全部单测，不 spawn 真实进程；外部依赖通过参数注入 mock。

| 测试文件 | 覆盖内容 |
|---|---|
| `test/claudeRunner.test.js`（新增） | `buildClaudeArgs` 纯函数：args 为 `['-p', '--permission-mode', 'bypassPermissions']`、`stdin: true`、path 缺省 `'claude'`/自定义完整路径、忽略 prompt 与 tmpFile |
| `test/agentRunner.test.js`（扩展） | `agent: 'claude'` mock spawn：stdio 为 pipe、`child.stdin.write(prompt)` + `end()` 被调、临时文件照常清理；pi 路径 stdio 仍为 inherit |
| `test/agents.test.js`（扩展） | `AGENT_KEYS` 为 `['pi', 'claude']`；claude 条目 buildArgs 与 optionKeys `['path']` |
| `test/config.test.js`（扩展） | claude 块未知 key 报错（`不允许字段 "model"，允许: path`）、`agentConfig.path` 缺省 `'claude'`、path 自定义 |

## 文档

README 更新：
1. 「支持的 agent」相关：顶层 `agent` 字段说明由「目前仅 pi」改为 pi / claude
2. agent 专属配置块表格补 claude 块（`path`，缺省 `'claude'`），示例 JSON 补 claude 切换
3. 「快速开始」环境要求补 `claude` 命令在 PATH 中可用（可选，仅用 claude 时）
4. 「扩展新 Agent」一节补充：适配器可返回 `stdin: true` 声明 prompt 走 stdin（win32 兼容场景）

AGENTS.md：约定补一句「适配器返回值可含可选 `stdin: true`，声明 prompt 走 stdin 管道（win32 兼容场景），通用层负责写入」。

`config.example.json` 保持 pi 演示不变（pi 仍为缺省）。

## 明确不做（YAGNI）

- 不做 `--model`、`--max-budget-usd`、`--add-dir`、session 恢复（`-r`/`--continue`）等 claude 专属选项
- 不做 permission 配置项（硬编码 bypassPermissions）
- 不重写 agentRunner 的 win32 shell:true 处理（仅新增 stdin 路径，不影响现有 win32 行为）
- 不做 per-rule agent 选择

## 验证标准

1. `npm test` 全部通过
2. `config.example.json` 切 `agent` 为 `"claude"` 并配 `claude` 块后启动无配置报错（Linux 本机；真实跑任务需 `claude` 在 PATH 且已登录）
3. pi 路径回归：不改 agent 时行为与现在一致（stdio 仍 inherit）
4. `docs/superpowers/specs/` 与 README、AGENTS.md 同步更新
