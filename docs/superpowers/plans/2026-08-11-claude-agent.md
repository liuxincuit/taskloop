# Claude Agent 适配器实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 taskloop 增加 Claude Code CLI（`claude`）适配器，使 config 顶层 `agent: "claude"` 时任务 prompt 经 `claude -p` 非交互执行。

**Architecture:** 在 agent 注册表（`src/agents.js`）注册 claude 条目，适配器 `buildClaudeArgs` 返回 `{ cmd, args, stdin: true }`——prompt 经 stdin 管道传给 `claude -p`（win32 下内联 argv 会被 cmd.exe 引号拆坏，故走 stdin）；通用执行层 `agentRunner` 识别 `stdin` 声明，把 prompt 写入子进程 stdin 并处理 EPIPE；`config.js` 的 `path` 缺省值由硬编码 `'pi'` 改为 agent key（claude 缺省 `'claude'`）。pi 路径零行为变化。

**Tech Stack:** Node.js ≥ 18 内置模块，`node:test` + `node:assert`，零第三方依赖。

---

### Task 1: claude 适配器纯函数（src/claudeRunner.js）

**Files:**
- Create: `src/claudeRunner.js`
- Test: `test/claudeRunner.test.js`

- [ ] **Step 1: 写失败的测试**

`test/claudeRunner.test.js`（全量内容）：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildClaudeArgs } = require('../src/claudeRunner.js');

test('buildClaudeArgs：返回 claude 命令、-p + bypassPermissions、stdin: true', () => {
  const { cmd, args, stdin } = buildClaudeArgs('prompt', {
    tmpFile: '/tmp/x.md',
    cwd: '/work',
    agentConfig: { path: 'claude' },
  });
  assert.strictEqual(cmd, 'claude');
  assert.deepStrictEqual(args, ['-p', '--permission-mode', 'bypassPermissions']);
  assert.strictEqual(stdin, true);
});

test('buildClaudeArgs：path 缺省为 claude', () => {
  const { cmd } = buildClaudeArgs('p', { tmpFile: '/tmp/x.md', cwd: '.', agentConfig: {} });
  assert.strictEqual(cmd, 'claude');
});

test('buildClaudeArgs：path 自定义完整路径', () => {
  const { cmd } = buildClaudeArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { path: '/opt/claude/bin/claude' },
  });
  assert.strictEqual(cmd, '/opt/claude/bin/claude');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/claudeRunner.test.js`
Expected: FAIL——`Cannot find module '../src/claudeRunner.js'`

- [ ] **Step 3: 写最小实现**

`src/claudeRunner.js`（全量内容）：

```js
// claude 适配器：仅负责把 prompt 映射为 spawn 参数，不 spawn、不碰文件系统。
// prompt 走 stdin（stdin: true 声明，由 agentRunner 写入子进程 stdin）：
// claude -p 不带 prompt 参数时从 stdin 读；不用内联 argv，避免 win32 shell:true
// 下 prompt 含引号/反引号/$()/换行被 cmd.exe 拆坏，也绕开 Linux 单参数 128KB 上限。
function buildClaudeArgs(prompt, { agentConfig }) {
  const cmd = agentConfig?.path ?? 'claude';
  const args = ['-p', '--permission-mode', 'bypassPermissions'];
  return { cmd, args, stdin: true };
}

module.exports = { buildClaudeArgs };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/claudeRunner.test.js`
Expected: PASS（3 个测试）

- [ ] **Step 5: Commit**

```bash
git add src/claudeRunner.js test/claudeRunner.test.js
git commit -m "feat: 新增 claude 适配器 buildClaudeArgs（prompt 走 stdin）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: agents 注册表注册 claude

**Files:**
- Modify: `src/agents.js`
- Modify: `test/agents.test.js`

- [ ] **Step 1: 更新测试**

`test/agents.test.js`（全量内容）：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { agents, AGENT_KEYS } = require('../src/agents.js');
const { buildPiArgs } = require('../src/piRunner.js');
const { buildClaudeArgs } = require('../src/claudeRunner.js');

test('注册表：pi 与 claude 两个 agent', () => {
  assert.deepStrictEqual(AGENT_KEYS, ['pi', 'claude']);
});

test('注册表：pi 条目声明 buildArgs 与 optionKeys', () => {
  assert.strictEqual(agents.pi.buildArgs, buildPiArgs);
  assert.deepStrictEqual(agents.pi.optionKeys, ['sessionDir', 'path']);
});

test('注册表：claude 条目声明 buildArgs 与 optionKeys', () => {
  assert.strictEqual(agents.claude.buildArgs, buildClaudeArgs);
  assert.deepStrictEqual(agents.claude.optionKeys, ['path']);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/agents.test.js`
Expected: FAIL——`deepStrictEqual` 实际 `['pi']` 不等于 `['pi', 'claude']`；`agents.claude` 为 undefined

- [ ] **Step 3: 注册 claude**

`src/agents.js`，替换为全量内容（新增第 1 行 require、claude 条目、注释里返回值签名补充 `stdin?`）：

```js
const { buildPiArgs } = require('./piRunner.js');
const { buildClaudeArgs } = require('./claudeRunner.js');

// 新增 agent：创建 src/<name>.js 导出 build<Name>Args(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args, stdin? }，
// 然后在此注册一行（buildArgs 实现 + optionKeys 专属配置项声明），
// 自动获得：config 的 agent 校验、[agent] 块 key 校验、main 的分发、通用执行层（临时文件/SIGINT/退出码）
const agents = {
  pi: {
    buildArgs: buildPiArgs,
    optionKeys: ['sessionDir', 'path'],
  },
  claude: {
    buildArgs: buildClaudeArgs,
    optionKeys: ['path'],
  },
};

const AGENT_KEYS = Object.keys(agents);

module.exports = { agents, AGENT_KEYS };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/agents.test.js`
Expected: PASS（3 个测试）

- [ ] **Step 5: Commit**

```bash
git add src/agents.js test/agents.test.js
git commit -m "feat: agents 注册表注册 claude（optionKeys: path）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: agentRunner 支持适配器声明 stdin 管道

**Files:**
- Modify: `src/agentRunner.js`
- Modify: `test/agentRunner.test.js`

- [ ] **Step 1: 写失败的测试**

`test/agentRunner.test.js`，在文件末尾（现有最后一个测试之后）追加两个测试。现有顶部已导入 `EventEmitter`（`const { EventEmitter } = require('node:events');`）。

```js
test('runAgent：claude 声明 stdin，prompt 写入子进程 stdin 并 end，stdio 为 pipe', async () => {
  let spawnArgs = null;
  const stdin = new EventEmitter();
  stdin.write = (data) => { stdin.data = data; };
  stdin.end = () => { stdin.ended = true; };
  const child = makeFakeChild(0);
  child.stdin = stdin;
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    return child;
  };
  const result = await runAgent('处理 CS-1', {
    agent: 'claude', cwd: '/work', agentConfig: { path: 'claude' }, spawnFn,
  });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(spawnArgs.cmd, 'claude');
  assert.deepStrictEqual(spawnArgs.args, ['-p', '--permission-mode', 'bypassPermissions']);
  assert.deepStrictEqual(spawnArgs.opts.stdio, ['pipe', 'inherit', 'inherit']);
  assert.strictEqual(stdin.data, '处理 CS-1');
  assert.strictEqual(stdin.ended, true);
});

test('runAgent：claude stdin 收到 error（EPIPE）不崩溃', async () => {
  const stdin = new EventEmitter();
  stdin.write = () => {};
  stdin.end = () => {};
  const child = makeFakeChild(0);
  child.stdin = stdin;
  const spawnFn = () => child;
  const result = await runAgent('x', {
    agent: 'claude', cwd: '.', agentConfig: { path: 'claude' }, spawnFn,
  });
  assert.strictEqual(result.exitCode, 0);
  stdin.emit('error', new Error('EPIPE')); // 若无 error 监听器，EventEmitter 会同步抛 "Unhandled 'error' event" 使测试失败
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/agentRunner.test.js`
Expected: FAIL——测试 1 的 `opts.stdio` 实际为 `'inherit'`（非数组）且 `stdin.data` 为 undefined；测试 2 的 `stdin.emit('error')` 抛 `Unhandled 'error' event`

- [ ] **Step 3: 实现 stdin 支持**

`src/agentRunner.js`，三处修改：

修改点 1——取返回值加 `stdin`（第 14 行）：
```js
    const { cmd, args, stdin } = agents[agent].buildArgs(prompt, { tmpFile, cwd, agentConfig });
```

修改点 2——stdio 按声明切换（第 21-23 行）：
```js
      const child = spawnFn(cmd, finalArgs, {
        cwd,
        stdio: stdin ? ['pipe', 'inherit', 'inherit'] : 'inherit',
        ...(isWin ? { shell: true } : {}),
      });
```

修改点 3——onChild try/catch 块之后追加 stdin 写入（原第 32 行 `}` 之后、Promise executor 内）：
```js
      if (stdin) {
        // EPIPE：子进程提前退出时忽略，避免 unhandled 'error' 崩溃
        child.stdin.on('error', () => {});
        child.stdin.write(prompt);
        child.stdin.end();
      }
```

修改完成后 `src/agentRunner.js` 全量内容应为：

```js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agents } = require('./agents.js');

async function runAgent(prompt, { agent, cwd, agentConfig, spawnFn = spawn, onChild, isWin = process.platform === 'win32' }) {
  const tmpFile = path.join(
    os.tmpdir(),
    `agent-task-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
  );
  try {
    fs.writeFileSync(tmpFile, prompt, 'utf8');
    const { cmd, args, stdin } = agents[agent].buildArgs(prompt, { tmpFile, cwd, agentConfig });
    // win32 shell:true 下含空格的路径会被拆分，统一对非 flag 参数（不以 - 开头）包引号；
    // 适配器返回的 args 一律不带引号
    const finalArgs = isWin ? args.map((a) => (a.startsWith('-') ? a : `"${a}"`)) : args;
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawnFn(cmd, finalArgs, {
        cwd,
        stdio: stdin ? ['pipe', 'inherit', 'inherit'] : 'inherit',
        ...(isWin ? { shell: true } : {}),
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
      try {
        onChild?.(child);
      } catch (err) {
        // 先 reject 再 kill：kill 可能同步触发 exit 事件，先 kill 会让 exit 的 resolve 吞掉 onChild 的错误
        reject(err);
        child.kill();
      }
      if (stdin) {
        // EPIPE：子进程提前退出时忽略，避免 unhandled 'error' 崩溃
        child.stdin.on('error', () => {});
        child.stdin.write(prompt);
        child.stdin.end();
      }
    });
    return { exitCode };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

module.exports = { runAgent };
```

- [ ] **Step 4: 运行确认通过（含回归）**

Run: `node --test test/agentRunner.test.js`
Expected: PASS（原有 6 个 pi 测试 + 新增 2 个 claude 测试，共 8 个）

- [ ] **Step 5: Commit**

```bash
git add src/agentRunner.js test/agentRunner.test.js
git commit -m "feat: agentRunner 支持适配器声明 stdin 管道写 prompt（EPIPE 静默）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: config.js path 缺省值改为 agent key

**Files:**
- Modify: `src/config.js`
- Modify: `test/config.test.js`

- [ ] **Step 1: 写失败的测试**

`test/config.test.js`，在文件末尾追加三个测试（`makeFixture` 已在顶部定义，其默认 `pi` 块对 claude 来说是非当前 agent 块，不校验不报错）：

```js
test('claude 配置块缺省时 agentConfig.path 为 claude', () => {
  const { dir, configPath } = makeFixture({ agent: 'claude' });
  const result = loadConfig(configPath);
  assert.strictEqual(result.agent, 'claude');
  assert.strictEqual(result.agentConfig.path, 'claude');
  assert.strictEqual(result.agentConfig.sessionDir, dir);
});

test('claude 配置块 path 自定义', () => {
  const { configPath } = makeFixture({ agent: 'claude', claude: { path: '/opt/claude/bin/claude' } });
  const result = loadConfig(configPath);
  assert.strictEqual(result.agentConfig.path, '/opt/claude/bin/claude');
});

test('claude 配置块出现未声明 key 时报错并列出允许值', () => {
  const { configPath } = makeFixture({ agent: 'claude', claude: { model: 'x' } });
  assert.throws(() => loadConfig(configPath), /不允许字段 "model"，允许: path/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/config.test.js`
Expected: 至少第一个测试 FAIL——`agentConfig.path` 实际为 `'pi'`（硬编码缺省），非 `'claude'`；另两个为回归测试

- [ ] **Step 3: 修改缺省值**

`src/config.js`，第 47 行：
```js
    path: agentBlock?.path ?? agent,
```
（原为 `path: agentBlock?.path ?? 'pi'`。pi 仍缺省 `'pi'`——agent key 即 `'pi'`；claude 缺省 `'claude'`。）

- [ ] **Step 4: 运行确认通过（含回归）**

Run: `npm test`
Expected: PASS（全部测试；现有 `agent 为非法值时报错并列出合法值` 用 `/agent 必须是 "pi"/` 子串匹配，`"pi" 或 "claude"` 仍含 `"pi"`，不需改动）

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "fix: config 的 agent path 缺省值改为 agent key（claude 缺省 claude）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 文档（README + AGENTS.md）

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新 README.md**

以下 5 处修改：

**1a. 快速开始环境要求**（第 40-41 行）：
```md
- Node.js ≥ 18
- 所用 agent 的命令在 PATH 中可用：`pi`（缺省）或 `claude`
```

**1b. 顶层 agent 字段说明**（第 80 行）：
```md
| `agent` | 否 | `pi` | 执行 agent 的注册表 key，目前 `pi` / `claude`；非法值启动报错并列出合法值 |
```

**1c. agent 专属配置块一节**（第 83-99 行整段替换）：
```md
### agent 专属配置块

顶层 `{agent}` 命名的对象（如 `pi`、`claude`）存放该 agent 的专属配置，只允许注册表声明的字段，出现未声明字段启动报错：

#### `pi` 块

| 字段 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `sessionDir` | 否 | config 文件所在目录 | pi 会话保存目录（相对配置文件解析） |
| `path` | 否 | `pi` | pi 可执行文件命令名或完整路径 |

```json
{
  "agent": "pi",
  "pi": { "sessionDir": "./.pi-sessions", "path": "pi" }
}
```

#### `claude` 块

| 字段 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `path` | 否 | `claude` | claude 可执行文件命令名或完整路径 |

```json
{
  "agent": "claude",
  "claude": { "path": "claude" }
}
```

切换 agent 只需改 `agent` 字段并重写对应配置块。
```

**1d. 扩展新 Agent 一节**（第 159-191 行整段替换，原假设性 claude 示例改为真实适配器 + stdin 说明）：
```md
## 扩展新 Agent

与「扩展新来源」同理，新增 agent 只需两步，校验与分发自动生效，无需改动其他代码：

1. **创建 `src/<name>.js`**，导出与现有适配器同签名的纯函数：

   ```js
   // src/myagent.js
   function buildMyagentArgs(prompt, { tmpFile, cwd, agentConfig }) {
     return {
       cmd: agentConfig.path ?? 'myagent',
       args: ['-p', prompt],   // 具体参数以该 CLI 的非交互用法为准
     };
   }
   module.exports = { buildMyagentArgs };
   ```

   适配器只负责「prompt → spawn 参数」的映射，纯函数、不 spawn、不碰文件系统；临时文件写入、退出码、Ctrl+C 杀进程、win32 引号处理均由通用执行层（`src/agentRunner.js`）统一负责。

   返回值为 `{ cmd, args }`；若该 CLI 的 prompt 经 stdin 读取（如 claude），返回 `{ cmd, args, stdin: true }`——通用层会把 prompt 写入子进程 stdin（win32 下比内联 argv 更稳，避免 prompt 被 shell 引号拆坏）。

2. **在 `src/agents.js` 注册一行**，声明专属配置项：

   ```js
   const agents = {
     pi: { buildArgs: buildPiArgs, optionKeys: ['sessionDir', 'path'] },
     claude: { buildArgs: buildClaudeArgs, optionKeys: ['path'] },
     myagent: { buildArgs: buildMyagentArgs, optionKeys: ['path'] },
   };
   ```

   注册后自动获得：`config` 的 `agent` 校验（错误消息列出合法值）、`{agent}` 配置块 key 校验（只允许 `optionKeys` 声明的字段）、`main` 按 agent 分发、通用执行层。config 用法：

   ```json
   { "agent": "myagent", "myagent": { "path": "myagent" } }
   ```
```

**1e. 目录结构**（第 214 行 piRunner 之后追加一行）：
```md
  claudeRunner.js # claude 适配器（纯函数，prompt 经 stdin 传入）
```

- [ ] **Step 2: 更新 AGENTS.md**

`AGENTS.md`，两处修改：

**2a. 首行描述**（第 3 行）：
```md
taskloop：定时从 YouTrack / Supermap Wiki 按标签抓取任务，交给所选 AI Agent（pi / claude）非交互模式执行的循环 Worker。零第三方依赖的 Node.js 项目（仅内置模块），CommonJS。
```

**2b. 代码约定 agent 一行**（第 15 行，末尾补 stdin 返回说明）：
```md
- **扩展走注册表，只写实现不注册不会生效**：新任务来源 → 新建 `src/<name>.js` 导出 `fetchTasks(rule, { httpClient, url, token })`，并在 `src/sources.js` 注册（tokenEnv/urlEnv/defaultUrl）；HTTP 请求复用 `src/youTrack.js` 的 `createHttpClient`（依赖注入，便于 mock）。新 agent → 新建 `src/<name>.js` 导出 `build<Name>Args(prompt, { tmpFile, cwd, agentConfig })` 纯函数，并在 `src/agents.js` 注册（含 optionKeys）；返回 `{ cmd, args }`，若 prompt 走 stdin（如 claude）返回 `{ cmd, args, stdin: true }`，由 agentRunner 写入子进程 stdin
```

- [ ] **Step 3: 全量测试确认**

Run: `npm test`
Expected: PASS（文档改动不影响测试，作最终回归）

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: README/AGENTS.md 补 claude agent 说明与 stdin 约定

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 真机冒烟（可选，手动）

**Files:** 无（不提交任何代码）

- [ ] **Step 1: 用真实 claude 验证适配器参数可跑通（消耗一次 API 调用）**

```bash
echo '只回复 OK 两个字' | claude -p --permission-mode bypassPermissions
```

Expected: 输出 `OK`，退出码 0。（验证 `-p` 无 prompt 参数时确实从 stdin 读；等价于 `buildClaudeArgs` 产出的 args。）

- [ ] **Step 2: 本地 config 冒烟（不真正抓任务/跑任务，仅验证配置校验）**

临时建一个最小 `claude` 配置并 `node src/main.js`，确认不出现 `配置错误: ...` 后 Ctrl+C 退出；跑完删除临时配置。若不想动 config.json，可跳过（配置校验已被 Task 4 单测覆盖）。

---

## 自审

**1. Spec 覆盖：**
- claudeRunner 纯函数（args/stdin/path 缺省）→ Task 1 ✓
- agents 注册 claude optionKeys ['path'] → Task 2 ✓
- agentRunner stdin 管道 + EPIPE 静默 + pi 零变化（回归由现有测试守护）→ Task 3 ✓
- config path 缺省 agent key → Task 4 ✓
- README agent 块/claude 说明/扩展新 Agent stdin 约定、AGENTS.md → Task 5 ✓
- config.example.json 不动（spec 明确保持 pi 演示）→ 不设任务 ✓

**2. 占位符扫描：** 所有代码步骤均有完整可执行代码与期望输出；无 TBD/TODO。

**3. 类型一致性：** `{ cmd, args, stdin }` 解构在 Task 3 与 Task 1 的适配器返回一致；`agentConfig.path` 在 claudeRunner、config、各测试中同名同义；`AGENT_KEYS` 由 Task 2 改为 `['pi', 'claude']` 后无其他测试硬编码旧值（config.test 用 `/agent 必须是 "pi"/` 子串、main.test 直接构造 agentConfig 均不受影响）。
