# Agent 注册表架构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 taskloop 的执行层从硬编码 pi 抽象为 agent 注册表模式，pi 成为首个适配器，未来可两步扩展 opencode/claude/codex 等 agent。

**Architecture:** 仿照现有 `sources.js` 注册表模式：`src/agents.js` 注册 `{ pi: { buildArgs, optionKeys } }`；`src/piRunner.js` 改为纯函数适配器 `buildPiArgs`；`src/agentRunner.js` 承担通用执行层（临时文件、spawn、退出码、win32 引号、onChild）；`src/config.js` 新增 `agent` 与 `[agent]` 配置块校验；`src/main.js` 按 `config.agent` 分发。

**Tech Stack:** Node.js ≥ 18 内置模块（node:child_process、node:fs、node:os、node:path），测试用 node:test，零第三方依赖。

## Global Constraints

- 零第三方依赖（仅 Node.js 内置模块），Node.js ≥ 18
- 测试框架 `node:test`，`npm test` 运行全部；不 spawn 真实进程、不发真实 HTTP，外部依赖参数注入 mock
- 本次只实现 pi 适配器；opencode/claude/codex 仅留扩展点（README 文档），不实现
- 顶层 `sessionDir` 不再支持，迁移进 `pi` 块
- `agent` 缺省 `'pi'`；配置校验失败启动即报错（exit 1）
- 适配器接口：`buildArgs(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args }`，纯函数，不 spawn、不碰文件系统
- 通用执行层接口：`runAgent(prompt, { agent, cwd, agentConfig, spawnFn, onChild, isWin }) → { exitCode }`
- 非当前 agent 名的顶层块（如 `claude: {...}`）不校验不报错
- 现有行为保持：串行执行、同轮去重、SIGINT kill 子进程、非零退出码记日志不中断

---

### Task 1: piRunner 改造为 buildPiArgs 纯函数

**Files:**
- Rewrite: `src/piRunner.js`
- Rewrite: `test/piRunner.test.js`

**Interfaces:**
- Consumes: 无（本任务不依赖其他新模块）
- Produces: `buildPiArgs(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args }`
  - `cmd`: `agentConfig.path ?? 'pi'`（字符串）
  - `args`: `['-p', '@' + tmpFile, '--session-dir', agentConfig.sessionDir]`（字符串数组，不含引号——win32 引号由通用层处理）
  - `prompt`、`cwd` 参数存在但 pi 实现不使用（接口统一为未来 agent 保留）

原 `runPi` 被删除，其职责（临时文件/spawn/退出码/清理）由 Task 4 的 `runAgent` 接管。注意：`src/main.js` 仍 `require('./piRunner.js')` 取 `runPi`——Task 1 完成后该引用为 undefined，但 main 的测试全部注入 mock deps，`npm test` 仍绿；Task 5 会修正 main.js。

- [ ] **Step 1: 重写测试（先写失败测试）**

`test/piRunner.test.js` 整体替换为：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPiArgs } = require('../src/piRunner.js');

test('buildPiArgs：返回 pi 命令与 -p @tmpfile --session-dir 参数', () => {
  const { cmd, args } = buildPiArgs('prompt', {
    tmpFile: '/tmp/pi-task-1.md',
    cwd: '/work',
    agentConfig: { sessionDir: '/work/.pi-sessions', path: 'pi' },
  });
  assert.strictEqual(cmd, 'pi');
  assert.deepStrictEqual(args, ['-p', '@/tmp/pi-task-1.md', '--session-dir', '/work/.pi-sessions']);
});

test('buildPiArgs：path 缺省为 pi', () => {
  const { cmd } = buildPiArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { sessionDir: '/work' },
  });
  assert.strictEqual(cmd, 'pi');
});

test('buildPiArgs：path 自定义完整路径', () => {
  const { cmd } = buildPiArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { sessionDir: '/work', path: '/opt/pi/bin/pi' },
  });
  assert.strictEqual(cmd, '/opt/pi/bin/pi');
});

test('buildPiArgs：sessionDir 透传', () => {
  const { args } = buildPiArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { sessionDir: '/sessions' },
  });
  assert.deepStrictEqual(args, ['-p', '@/tmp/x.md', '--session-dir', '/sessions']);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test`
Expected: FAIL——`Cannot find module '../src/piRunner.js'` 或 `buildPiArgs is not a function`（旧实现只有 `runPi`）

- [ ] **Step 3: 重写 piRunner.js**

`src/piRunner.js` 整体替换为：

```js
// pi 适配器：仅负责把 prompt 映射为 spawn 参数，不 spawn、不碰文件系统。
// 临时文件由 agentRunner 写入并传入 tmpFile；win32 引号由 agentRunner 统一处理（args 不含引号）。
function buildPiArgs(prompt, { tmpFile, cwd, agentConfig }) {
  const cmd = agentConfig?.path ?? 'pi';
  const args = ['-p', '@' + tmpFile, '--session-dir', agentConfig.sessionDir];
  return { cmd, args };
}

module.exports = { buildPiArgs };
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test`
Expected: PASS（piRunner.test.js 4 个用例通过；main/config 等既有用例不受影响——main 测试注入 mock，不引用真实 runPi）

- [ ] **Step 5: 提交**

```bash
git add src/piRunner.js test/piRunner.test.js
git commit -m "refactor: piRunner 改为 buildPiArgs 纯函数适配器"
```

---

### Task 2: agents.js 注册表

**Files:**
- Create: `src/agents.js`
- Test: `test/sources.test.js` 同目录约定——新增 `test/agents.test.js`

**Interfaces:**
- Consumes: `buildPiArgs`（Task 1 产出）
- Produces:
  - `agents`: `{ pi: { buildArgs: buildPiArgs, optionKeys: ['sessionDir', 'path'] } }`
  - `AGENT_KEYS`: `['pi']`
- 被 Task 3（config 校验）、Task 4（agentRunner 分发）消费

- [ ] **Step 1: 写失败测试**

新建 `test/agents.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { agents, AGENT_KEYS } = require('../src/agents.js');
const { buildPiArgs } = require('../src/piRunner.js');

test('注册表：只有 pi 一个 agent', () => {
  assert.deepStrictEqual(AGENT_KEYS, ['pi']);
});

test('注册表：pi 条目声明 buildArgs 与 optionKeys', () => {
  assert.strictEqual(agents.pi.buildArgs, buildPiArgs);
  assert.deepStrictEqual(agents.pi.optionKeys, ['sessionDir', 'path']);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test`
Expected: FAIL——`Cannot find module '../src/agents.js'`

- [ ] **Step 3: 写 agents.js**

新建 `src/agents.js`：

```js
const { buildPiArgs } = require('./piRunner.js');

// 新增 agent：创建 src/<name>.js 导出 build<Name>Args(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args }，
// 然后在此注册一行（buildArgs 实现 + optionKeys 专属配置项声明），
// 自动获得：config 的 agent 校验、[agent] 块 key 校验、main 的分发、通用执行层（临时文件/SIGINT/退出码）
const agents = {
  pi: {
    buildArgs: buildPiArgs,
    optionKeys: ['sessionDir', 'path'],
  },
};

const AGENT_KEYS = Object.keys(agents);

module.exports = { agents, AGENT_KEYS };
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agents.js test/agents.test.js
git commit -m "feat: agent 注册表（pi 为首个适配器）"
```

---

### Task 3: config.js 新增 agent 与配置块校验

**Files:**
- Modify: `src/config.js`
- Modify: `test/config.test.js`

**Interfaces:**
- Consumes: `agents`, `AGENT_KEYS`（Task 2 产出）
- Produces: `loadConfig(path) → { intervalSeconds, agent, agentConfig, rules }`
  - `agent`: 字符串，缺省 `'pi'`
  - `agentConfig`: `{ sessionDir: <绝对路径>, path: 'pi' | 用户值 }`，`sessionDir` 缺省 config 文件所在目录
- 被 Task 5（main.js）消费；`sessionDir` 从顶层字段移除

- [ ] **Step 1: 改测试（先红）**

`test/config.test.js` 修改点：

1. `makeFixture` 中配置改为：

```js
  const config = {
    intervalSeconds: 60,
    agent: 'pi',
    pi: { sessionDir: './.pi-sessions' },
    rules: [
      {
        labels: ['readyed', 'clearly'],
        notLabels: ['done'],
        assignee: 'me',
        promptTemplate: 'templates/analyze.md',
      },
    ],
    ...overrides,
  };
```

2. 「解析合法配置」用例断言改为：

```js
  assert.strictEqual(result.agent, 'pi');
  assert.strictEqual(result.agentConfig.sessionDir, path.join(dir, '.pi-sessions'));
  assert.strictEqual(result.agentConfig.path, 'pi');
```

（删除 `assert.strictEqual(result.sessionDir, ...)` 一行）

3. 「缺省值」用例：删除 `delete raw.sessionDir;`，改为 `delete raw.agent; delete raw.pi;`，断言改为：

```js
  assert.strictEqual(result.agent, 'pi');
  assert.strictEqual(result.agentConfig.sessionDir, dir);
  assert.strictEqual(result.agentConfig.path, 'pi');
```

4. 文件末尾新增用例：

```js
test('agent 为非法值时报错并列出合法值', () => {
  const { configPath } = makeFixture({ agent: 'opencode' });
  assert.throws(() => loadConfig(configPath), /agent 必须是 "pi"/);
});

test('agent 为非字符串时报错', () => {
  const { configPath } = makeFixture({ agent: 123 });
  assert.throws(() => loadConfig(configPath), /agent/);
});

test('agent 配置块为数组时报错', () => {
  const { configPath } = makeFixture({ pi: [] });
  assert.throws(() => loadConfig(configPath), /配置块必须是对象/);
});

test('agent 配置块出现未声明 key 时报错并列出允许值', () => {
  const { configPath } = makeFixture({ pi: { sessionDir: './.pi-sessions', model: 'x' } });
  assert.throws(() => loadConfig(configPath), /不允许字段 "model"，允许: sessionDir, path/);
});

test('agent 配置块缺省时 agentConfig 用默认值', () => {
  const { dir, configPath } = makeFixture();
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete raw.agent;
  delete raw.pi;
  fs.writeFileSync(configPath, JSON.stringify(raw), 'utf8');
  const result = loadConfig(configPath);
  assert.strictEqual(result.agent, 'pi');
  assert.strictEqual(result.agentConfig.sessionDir, dir);
  assert.strictEqual(result.agentConfig.path, 'pi');
});
```

注意：`makeFixture` 的 `overrides` 是浅合并——`{ agent: 'opencode' }` 覆盖顶层 `agent` 字段；`{ pi: [] }` 覆盖 `pi` 块。符合现有用例模式（如 `{ intervalSeconds: -1 }`）。

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test`
Expected: FAIL——config 相关用例报 `result.agent` undefined / 无 `agent 必须是` 错误

- [ ] **Step 3: 改 config.js**

`src/config.js` 修改：

顶部增加 require：

```js
const { agents, AGENT_KEYS } = require('./agents.js');
```

`loadConfig` 内、`configDir` 之后、`rules` 之前插入：

```js
  const agent = raw.agent ?? 'pi';
  if (typeof agent !== 'string' || !AGENT_KEYS.includes(agent)) {
    throw new Error(`agent 必须是 ${AGENT_KEYS.map((k) => `"${k}"`).join(' 或 ')}`);
  }
  const agentBlock = raw[agent];
  if (agentBlock !== undefined &&
      (typeof agentBlock !== 'object' || agentBlock === null || Array.isArray(agentBlock))) {
    throw new Error(`${agent} 配置块必须是对象`);
  }
  const allowedKeys = agents[agent].optionKeys;
  for (const key of Object.keys(agentBlock ?? {})) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${agent} 配置块不允许字段 "${key}"，允许: ${allowedKeys.join(', ')}`);
    }
  }
  const agentConfig = {
    sessionDir: agentBlock?.sessionDir ? path.resolve(configDir, agentBlock.sessionDir) : configDir,
    path: agentBlock?.path ?? 'pi',
  };
```

删除原有 `sessionDir` 解析行：

```js
  const sessionDir = raw.sessionDir
    ? path.resolve(configDir, raw.sessionDir)
    : configDir;
```

返回值改为：

```js
  return { intervalSeconds, agent, agentConfig, rules };
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: config 支持 agent 字段与 agent 专属配置块校验"
```

---

### Task 4: agentRunner 通用执行层

**Files:**
- Create: `src/agentRunner.js`
- Create: `test/agentRunner.test.js`

**Interfaces:**
- Consumes: `agents`（Task 2 产出，`agents[agent].buildArgs`）
- Produces: `runAgent(prompt, { agent, cwd, agentConfig, spawnFn, onChild, isWin }) → { exitCode }`
  - `spawnFn` 缺省 `spawn`（node:child_process），测试注入 mock
  - `isWin` 缺省 `process.platform === 'win32'`，测试注入模拟 win32
  - 行为：写临时文件（文件名前缀 `agent-task-`）→ `buildArgs` → spawn（stdio inherit）→ 退出码 → finally 删临时文件；win32 下对不以 `-` 开头的参数包引号并 `shell: true`
- 被 Task 5（main.js）消费

- [ ] **Step 1: 写失败测试**

新建 `test/agentRunner.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { runAgent } = require('../src/agentRunner.js');

function makeFakeChild(exitCode) {
  const child = new EventEmitter();
  child.kill = () => { child.emit('exit', exitCode); };
  process.nextTick(() => child.emit('exit', exitCode));
  return child;
}

const agentConfig = { sessionDir: '/work/.pi-sessions', path: 'pi' };

test('runAgent：spawn 参数来自注册表 buildArgs，临时文件内容为 prompt', async () => {
  let spawnArgs = null;
  let tmpContent = null;
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    tmpContent = fs.readFileSync(args[1].slice(1), 'utf8');
    return makeFakeChild(0);
  };
  const result = await runAgent('处理 CS-1', {
    agent: 'pi', cwd: '/work', agentConfig, spawnFn,
  });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(spawnArgs.cmd, 'pi');
  assert.strictEqual(spawnArgs.opts.cwd, '/work');
  assert.strictEqual(spawnArgs.opts.stdio, 'inherit');
  assert.deepStrictEqual(spawnArgs.args, ['-p', spawnArgs.args[1], '--session-dir', '/work/.pi-sessions']);
  assert.ok(spawnArgs.args[1].startsWith('@'));
  assert.ok(spawnArgs.args[1].includes('agent-task-'));
  assert.strictEqual(tmpContent, '处理 CS-1');
});

test('runAgent：win32 下对非 flag 参数包引号并 shell: true', async () => {
  let spawnArgs = null;
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { args, opts };
    return makeFakeChild(0);
  };
  await runAgent('x', {
    agent: 'pi', cwd: '/work', agentConfig, spawnFn, isWin: true,
  });
  assert.strictEqual(spawnArgs.args[0], '-p');                  // flag 不加引号
  assert.ok(spawnArgs.args[1].startsWith('"@'));               // @tmpfile 加引号
  assert.ok(spawnArgs.args[1].endsWith('.md"'));
  assert.strictEqual(spawnArgs.args[2], '--session-dir');       // flag 不加引号
  assert.strictEqual(spawnArgs.args[3], '"/work/.pi-sessions"'); // 值加引号
  assert.strictEqual(spawnArgs.opts.shell, true);
});

test('runAgent：执行后删除临时文件', async () => {
  let tmpPath = null;
  const spawnFn = (cmd, args) => {
    tmpPath = args[1].slice(1);
    return makeFakeChild(0);
  };
  await runAgent('x', { agent: 'pi', cwd: '.', agentConfig, spawnFn });
  assert.strictEqual(fs.existsSync(tmpPath), false);
});

test('runAgent：非零退出码返回且不抛异常', async () => {
  const result = await runAgent('x', {
    agent: 'pi', cwd: '.', agentConfig, spawnFn: () => makeFakeChild(1),
  });
  assert.strictEqual(result.exitCode, 1);
});

test('runAgent：onChild 回调收到 child 对象', async () => {
  let received = null;
  const spawnFn = () => makeFakeChild(0);
  await runAgent('x', {
    agent: 'pi', cwd: '.', agentConfig, spawnFn,
    onChild: (child) => { received = child; },
  });
  assert.ok(received);
});

test('runAgent：spawn error 事件 reject 且清理临时文件', async () => {
  let tmpPath = null;
  const spawnFn = (cmd, args) => {
    tmpPath = args[1].slice(1);
    const child = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  };
  await assert.rejects(
    runAgent('x', { agent: 'pi', cwd: '.', agentConfig, spawnFn }),
    /ENOENT/
  );
  assert.strictEqual(fs.existsSync(tmpPath), false);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test`
Expected: FAIL——`Cannot find module '../src/agentRunner.js'`

- [ ] **Step 3: 写 agentRunner.js**

新建 `src/agentRunner.js`：

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
    const { cmd, args } = agents[agent].buildArgs(prompt, { tmpFile, cwd, agentConfig });
    // win32 shell:true 下含空格的路径会被拆分，统一对非 flag 参数（不以 - 开头）包引号；
    // 适配器返回的 args 一律不带引号
    const finalArgs = isWin ? args.map((a) => (a.startsWith('-') ? a : `"${a}"`)) : args;
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawnFn(cmd, finalArgs, {
        cwd,
        stdio: 'inherit',
        ...(isWin ? { shell: true } : {}),
      });
      try {
        onChild?.(child);
      } catch (err) {
        child.kill();
        reject(err);
        return;
      }
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
    return { exitCode };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

module.exports = { runAgent };
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agentRunner.js test/agentRunner.test.js
git commit -m "feat: agentRunner 通用执行层（临时文件/spawn/退出码/win32 引号）"
```

---

### Task 5: main.js 按 agent 分发

**Files:**
- Modify: `src/main.js`
- Modify: `test/main.test.js`

**Interfaces:**
- Consumes: `runAgent`（Task 4）、`config.agent`/`config.agentConfig`（Task 3）
- Produces: 无新导出；`runCycle` 的 deps 契约变化：`runPi` → `runAgent`，删除 `piPath`

- [ ] **Step 1: 改测试（先红）**

`test/main.test.js` 修改点：

1. `makeFixtureConfig` 返回对象改为：

```js
  return {
    intervalSeconds: 60,
    agent: 'pi',
    agentConfig: { sessionDir: path.join(dir, '.pi-sessions'), path: 'pi' },
    rules: [
      {
        labels: ['readyed'],
        notLabels: ['done'],
        promptTemplate: templatePath,
      },
    ],
  };
```

2. `makeDeps` 中 `runPi: async () => ({ exitCode: 0 })` 改为 `runAgent: async () => ({ exitCode: 0 })`，删除 `piPath: 'pi'` 行

3. 所有 `runPi:` 键改名为 `runAgent:`。用 grep 定位全部出现位置（实现时执行 `grep -n "runPi" test/main.test.js`，预期 12 处）：行 36（makeDeps 默认值）、49、62、86、100、127、144、162、195、234、320、345。测试名中的 `runPi` 一并改为 `runAgent`（行 92 `无候选任务时不调用 runPi` → `无候选任务时不调用 runAgent`，行 133 `runPi 非零退出码不中断循环` → `runAgent 非零退出码不中断循环`）

4. `sessionDir` 字段改造（用 `grep -n "sessionDir" test/main.test.js` 定位，预期 7 处）：行 14 在 `makeFixtureConfig` 内，改为在返回值中加 `agent: 'pi',` 并把 `sessionDir: path.join(dir, '.pi-sessions')` 替换为 `agentConfig: { sessionDir: path.join(dir, '.pi-sessions'), path: 'pi' }`；其余 6 处（行 74、112、177、221、307、332）为内联 config 字面量，`sessionDir: dir` 替换为：

```js
    agent: 'pi',
    agentConfig: { sessionDir: dir, path: 'pi' },
```

5. 新增用例验证 agent 透传：

```js
test('runCycle：config.agent 与 agentConfig 透传给 runAgent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
  const templatePath = path.join(dir, 'analyze.md');
  fs.writeFileSync(templatePath, '处理 {youtrack_id}', 'utf8');
  const config = {
    intervalSeconds: 60,
    agent: 'pi',
    agentConfig: { sessionDir: dir, path: '/opt/pi' },
    rules: [{ labels: ['a'], notLabels: [], promptTemplate: templatePath }],
  };
  let opts = null;
  const deps = makeDeps({
    sources: {
      youtrack: { fetchTasks: async () => [{ id: '1', idReadable: 'CS-1', labels: ['a'] }] },
      wiki: { fetchTasks: async () => [] },
    },
    runAgent: async (p, o) => { opts = o; return { exitCode: 0 }; },
  });
  await runCycle({ config, deps, round: 1 });
  assert.strictEqual(opts.agent, 'pi');
  assert.strictEqual(opts.agentConfig.path, '/opt/pi');
  assert.strictEqual(opts.agentConfig.sessionDir, dir);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test`
Expected: FAIL——main 相关用例：旧 main.js 仍调 `deps.runPi`，mock 里已改名 `runAgent`，报 `deps.runPi is not a function`

- [ ] **Step 3: 改 main.js**

`src/main.js` 修改点：

1. require 行：

```js
const { runPi } = require('./piRunner.js');
```

改为：

```js
const { runAgent } = require('./agentRunner.js');
```

2. `runCycle` 内执行调用：

```js
      const { exitCode } = await deps.runPi(prompt, {
        cwd: deps.cwd,
        piPath: deps.piPath,
        sessionDir: config.sessionDir,
        onChild: deps.onChild,
      });
```

改为：

```js
      const { exitCode } = await deps.runAgent(prompt, {
        agent: config.agent,
        cwd: deps.cwd,
        agentConfig: config.agentConfig,
        onChild: deps.onChild,
      });
```

3. `main()` 的 deps 对象：`runPi,` 改为 `runAgent,`，删除 `piPath: 'pi',` 行

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main.js test/main.test.js
git commit -m "refactor: main 按 agent 注册表分发，sessionDir/piPath 迁入 agentConfig"
```

---

### Task 6: config.example.json 与 README 更新

**Files:**
- Modify: `config.example.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: 前序任务确定的配置格式 `{ agent, pi: { sessionDir, path }, rules }` 与注册表接口

- [ ] **Step 1: 更新 config.example.json**

`config.example.json` 改为：

```json
{
  "intervalSeconds": 60,
  "agent": "pi",
  "pi": {
    "sessionDir": "./.pi-sessions"
  },
  "rules": [
    {
      "source": "youtrack",
      "labels": ["ready"],
      "notLabels": ["explored"],
      "assignee": "me",
      "promptTemplate": "templates/yt-explorer.md"
    },
    {
      "source": "wiki",
      "labels": ["ready"],
      "notLabels": ["explored"],
      "assignee": "me",
      "promptTemplate": "templates/wiki-exploer.md"
    }
  ]
}
```

- [ ] **Step 2: 更新 README 配置详解**

README「配置详解」的顶层字段表中，`sessionDir` 一行删除，改为：

```markdown
| `agent` | 否 | `pi` | 执行 agent 的注册表 key，目前仅 `pi`；非法值启动报错并列出合法值 |
```

并在 rules 表之前新增一节「agent 专属配置块」：

```markdown
### agent 专属配置块

顶层 `{agent}` 命名的对象（如 `pi`）存放该 agent 的专属配置，只允许注册表声明的字段，出现未声明字段启动报错：

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

切换 agent 只需改 `agent` 字段并重写对应配置块（如未来有 claude：`"agent": "claude", "claude": { ... }`）。
```

- [ ] **Step 3: README 新增「扩展新 Agent」一节**

在「扩展新来源」一节之后新增：

```markdown
## 扩展新 Agent

与「扩展新来源」同理，新增 agent 只需两步，校验与分发自动生效，无需改动其他代码：

1. **创建 `src/<name>.js`**，导出与现有适配器同签名的纯函数：

   ```js
   // src/claude.js
   function buildClaudeArgs(prompt, { tmpFile, cwd, agentConfig }) {
     return {
       cmd: agentConfig.path ?? 'claude',
       args: ['-p', '@' + tmpFile],   // 具体参数以该 CLI 的非交互用法为准
     };
   }
   module.exports = { buildClaudeArgs };
   ```

   适配器只负责「prompt → spawn 参数」的映射，纯函数、不 spawn、不碰文件系统；临时文件写入、退出码、Ctrl+C 杀进程、win32 引号处理均由通用执行层（`src/agentRunner.js`）统一负责。

2. **在 `src/agents.js` 注册一行**，声明专属配置项：

   ```js
   const agents = {
     pi: { buildArgs: buildPiArgs, optionKeys: ['sessionDir', 'path'] },
     claude: { buildArgs: buildClaudeArgs, optionKeys: ['model', 'permissionMode'] },
   };
   ```

   注册后自动获得：`config` 的 `agent` 校验（错误消息列出合法值）、`{agent}` 配置块 key 校验（只允许 `optionKeys` 声明的字段）、`main` 按 agent 分发、通用执行层。config 用法：

   ```json
   { "agent": "claude", "claude": { "model": "opus", "permissionMode": "acceptEdits" } }
   ```
```

同时把 README 开头「调用 `pi -p` 非交互执行」处改为「调用所选 agent（`config.json` 顶层 `agent` 字段，缺省 pi）非交互执行」。

- [ ] **Step 4: 验证**

Run: `npm test`
Expected: PASS（文档改动不影响测试）

- [ ] **Step 5: 提交**

```bash
git add config.example.json README.md
git commit -m "docs: 配置迁移至 agent 配置块，新增扩展新 Agent 一节"
```

---

### Task 7: 全量验证

**Files:**
- 无代码改动

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS（9 个测试文件）

- [ ] **Step 2: 检查残留引用**

Run: `grep -rn "runPi\|piPath\|config\.sessionDir" src/`   # 预期无输出

Expected: 无输出。若有残留，修正（`config.sessionDir` 字段、`runPi`、`piPath` 均不应再存在）。

再单独确认 config.js 中 sessionDir 引用均为合法解析逻辑：

Run: `grep -n "sessionDir" src/config.js`
Expected: 仅命中 agentConfig 解析相关行（`sessionDir: agentBlock?.sessionDir ? path.resolve(configDir, agentBlock.sessionDir) : configDir`），不出现 `const sessionDir =` 或 `config.sessionDir`。

- [ ] **Step 3: 手动验证配置校验**

Run:

```bash
node -e "
const { loadConfig } = require('./src/config.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
fs.writeFileSync(path.join(dir, 't.md'), 'x');
fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ rules: [{ labels: ['a'], promptTemplate: 't.md' }] }));
const c = loadConfig(path.join(dir, 'c.json'));
console.log('agent =', c.agent, '| sessionDir =', c.agentConfig.sessionDir, '| path =', c.agentConfig.path);
try {
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ agent: 'opencode', rules: [{ labels: ['a'], promptTemplate: 't.md' }] }));
  loadConfig(path.join(dir, 'bad.json'));
  console.log('BAD: 应报错');
} catch (e) { console.log('非法 agent 报错 OK:', e.message); }
"
```

Expected: 第一行输出 `agent = pi | sessionDir = <dir> | path = pi`；第二行输出 `非法 agent 报错 OK: agent 必须是 "pi"`

- [ ] **Step 4: 确认提交历史**

Run: `git log --oneline -6`
Expected: 6 个功能提交 + 设计文档提交

- [ ] **Step 5: 完成**

无提交（验证任务）。向用户汇报：npm test 全绿、配置迁移说明（现有 config.json 需把顶层 `sessionDir` 移入 `pi` 块）。
