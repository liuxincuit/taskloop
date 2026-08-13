# Agent 参数可配置化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 块（pi/claude）任意字段经约定映射生成 CLI 参数，移除适配器硬编码，config.json 可完整控制调用参数。

**Architecture:** 新增 `src/args.js` 提供纯函数 `toKebabCase`/`buildMappedArgs`（保留字段 path/args 外全部字段 → `--key value`）。`config.js` 负责校验与路径类 key（注册表 `pathKeys`）的相对解析，组装 `agentConfig`；两个适配器只拼固定结构性参数 + `buildMappedArgs(agentConfig)` + `args` 数组。

**Tech Stack:** Node.js 内置模块（node:test/node:assert），CommonJS，零第三方依赖。

## Global Constraints

- 零第三方依赖：只允许 Node 内置模块，不 npm install 任何包
- CommonJS：`require`/`module.exports`，不写 ESM `import/export`
- 中文错误消息，且被 test/ 正则断言（改措辞会挂测试）
- 测试：`npm test`（node --test，自动发现 test/*.test.js），禁止 jest/mocha；修改后必须运行 `npm test` 全绿才能提交
- 版本号：本次为 feat → 收尾提交（Task 4）升 package.json version 0.2.0 → 0.3.0；不打 git tag
- 只提交本次改造涉及的文件，不提交工作区其他未跟踪文件（`debug-environment-quickstart.md`、`icloudnative.md`、`workflows/` 等）
- 参照 spec：`docs/superpowers/specs/2026-08-13-configurable-agent-args-design.md`

---

### Task 1: src/args.js 约定映射工具（toKebabCase + buildMappedArgs）

**Files:**
- Create: `src/args.js`
- Test: `test/args.test.js`

**Interfaces:**
- Consumes: 无（独立模块）
- Produces: `toKebabCase(key) → string`；`buildMappedArgs(agentBlock) → string[]`。规则：跳过 `path`/`args`；数组值抛错「不能是数组，请改用 args」；对象值抛错「必须是字符串、数字或布尔值」；`false`/`null`/`undefined` 跳过；`true` → 只加 `--key`；字符串/数字 → `--key value`（key 先 toKebabCase）；按对象书写顺序展开；不含 `args` 内容

- [ ] **Step 1: 写测试文件 test/args.test.js（预期失败：模块不存在）**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { toKebabCase, buildMappedArgs } = require('../src/args.js');

test('toKebabCase：camelCase 转 kebab-case', () => {
  assert.strictEqual(toKebabCase('sessionDir'), 'session-dir');
  assert.strictEqual(toKebabCase('permissionMode'), 'permission-mode');
  assert.strictEqual(toKebabCase('model'), 'model');
});

test('buildMappedArgs：字符串与数字生成 --key value', () => {
  assert.deepStrictEqual(
    buildMappedArgs({ model: 'deepseek-v4-flash', maxTurns: 5 }),
    ['--model', 'deepseek-v4-flash', '--max-turns', '5']
  );
});

test('buildMappedArgs：true 生成纯 flag，false 与 null 跳过', () => {
  assert.deepStrictEqual(
    buildMappedArgs({ verbose: true, quiet: false, nothing: null }),
    ['--verbose']
  );
});

test('buildMappedArgs：按对象书写顺序展开', () => {
  assert.deepStrictEqual(
    buildMappedArgs({ thinking: 'max', model: 'x', verbose: true }),
    ['--thinking', 'max', '--model', 'x', '--verbose']
  );
});

test('buildMappedArgs：跳过 path 与 args 保留字段', () => {
  assert.deepStrictEqual(
    buildMappedArgs({ path: 'pi', args: ['--x'], sessionDir: '/s' }),
    ['--session-dir', '/s']
  );
});

test('buildMappedArgs：数组值报错提示改用 args', () => {
  assert.throws(() => buildMappedArgs({ tags: ['a', 'b'] }), /不能是数组，请改用 args/);
});

test('buildMappedArgs：对象值报错', () => {
  assert.throws(() => buildMappedArgs({ nested: { a: 1 } }), /必须是字符串、数字或布尔值/);
});

test('buildMappedArgs：空配置返回空数组', () => {
  assert.deepStrictEqual(buildMappedArgs({}), []);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `node --test test/args.test.js`
Expected: FAIL，`Cannot find module '../src/args.js'`

- [ ] **Step 3: 实现 src/args.js**

```js
// 约定映射：agentConfig 中除保留字段（path 命令名、args 原样数组）外的字段 → CLI 参数。
// pathKeys 声明的路径值已由 config.js 相对 config 目录解析为绝对路径，此处与其他字段同等对待。
function toKebabCase(key) {
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function buildMappedArgs(agentBlock) {
  const mapped = [];
  for (const [key, value] of Object.entries(agentBlock ?? {})) {
    if (key === 'path' || key === 'args') continue;
    if (Array.isArray(value)) {
      throw new Error(`配置块字段 "${key}" 不能是数组，请改用 args`);
    }
    if (value !== null && typeof value === 'object') {
      throw new Error(`配置块字段 "${key}" 必须是字符串、数字或布尔值`);
    }
    if (value === false || value === null || value === undefined) continue;
    const flag = '--' + toKebabCase(key);
    if (value === true) mapped.push(flag);
    else mapped.push(flag, String(value));
  }
  return mapped;
}

module.exports = { toKebabCase, buildMappedArgs };
```

- [ ] **Step 4: 运行验证通过**

Run: `node --test test/args.test.js`
Expected: PASS，8 个用例全过

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: 全部 PASS（现有测试不受影响，args.js 尚未被引用）

- [ ] **Step 6: 提交**

```bash
git add src/args.js test/args.test.js
git commit -m "feat: args 约定映射工具（toKebabCase/buildMappedArgs）"
```

---

### Task 2: 适配器改造（piRunner.js / claudeRunner.js 移除硬编码）

**Files:**
- Modify: `src/piRunner.js`、`src/claudeRunner.js`
- Test: `test/piRunner.test.js`、`test/claudeRunner.test.js`、`test/agentRunner.test.js`

**Interfaces:**
- Consumes: `buildMappedArgs(agentConfig)`（Task 1）；`agentConfig` 新形状（Task 3）
- Produces: `buildPiArgs(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args }`：args = `['-p', '@' + tmpFile, ...buildMappedArgs(agentConfig), ...(agentConfig.args ?? [])]`；`buildClaudeArgs(prompt, { agentConfig }) → { cmd, args, stdin: true }`：args = `['-p', ...buildMappedArgs(agentConfig), ...(agentConfig.args ?? [])]`

- [ ] **Step 1: 改 test/claudeRunner.test.js**

第一个用例的 `agentConfig` 加 `permissionMode` 并改用例名，其余两用例不变；新增两个用例：

```js
test('buildClaudeArgs：返回 claude 命令、-p + 映射参数、stdin: true', () => {
  const { cmd, args, stdin } = buildClaudeArgs('prompt', {
    tmpFile: '/tmp/x.md',
    cwd: '/work',
    agentConfig: { path: 'claude', permissionMode: 'bypassPermissions' },
  });
  assert.strictEqual(cmd, 'claude');
  assert.deepStrictEqual(args, ['-p', '--permission-mode', 'bypassPermissions']);
  assert.strictEqual(stdin, true);
});

// ... path 缺省 / path 自定义 两个用例不变 ...

test('buildClaudeArgs：未配置权限时不再硬编码 --permission-mode', () => {
  const { args } = buildClaudeArgs('p', { tmpFile: '/tmp/x.md', cwd: '.', agentConfig: { path: 'claude' } });
  assert.deepStrictEqual(args, ['-p']);
});

test('buildClaudeArgs：args 数组拼接在末尾', () => {
  const { args } = buildClaudeArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { path: 'claude', model: 'sonnet', args: ['--extra'] },
  });
  assert.deepStrictEqual(args, ['-p', '--model', 'sonnet', '--extra']);
});
```

- [ ] **Step 2: 改 test/piRunner.test.js（现有 4 用例全部保留，追加 3 用例）**

```js
test('buildPiArgs：映射参数（thinking/model）按书写顺序生成', () => {
  const { args } = buildPiArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { path: 'pi', sessionDir: '/s', thinking: 'max', model: 'x' },
  });
  assert.deepStrictEqual(args, [
    '-p', '@/tmp/x.md', '--session-dir', '/s', '--thinking', 'max', '--model', 'x',
  ]);
});

test('buildPiArgs：未配置 sessionDir 时不传 --session-dir', () => {
  const { args } = buildPiArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { path: 'pi' },
  });
  assert.deepStrictEqual(args, ['-p', '@/tmp/x.md']);
});

test('buildPiArgs：args 数组拼接在末尾', () => {
  const { args } = buildPiArgs('p', {
    tmpFile: '/tmp/x.md',
    cwd: '.',
    agentConfig: { path: 'pi', verbose: true, args: ['--extra', '1'] },
  });
  assert.deepStrictEqual(args, ['-p', '@/tmp/x.md', '--verbose', '--extra', '1']);
});
```

- [ ] **Step 3: 改 test/agentRunner.test.js 的 claude stdin 用例**

该用例中 `runAgent` 调用的这一行：

```js
    agent: 'claude', cwd: '/work', agentConfig: { path: 'claude' }, spawnFn, isWin: true,
```

改为：

```js
    agent: 'claude', cwd: '/work', agentConfig: { path: 'claude', permissionMode: 'bypassPermissions' }, spawnFn, isWin: true,
```

断言 `assert.deepStrictEqual(spawnArgs.args, ['-p', '--permission-mode', '"bypassPermissions"']);` 保持不变（win32 包引号逻辑未变）。

- [ ] **Step 4: 运行验证失败**

Run: `node --test test/piRunner.test.js test/claudeRunner.test.js test/agentRunner.test.js`
Expected: FAIL（新增用例失败：pi 未配置 sessionDir 时现实现仍拼 `--session-dir undefined`；claude 仍硬编码 permission-mode）

- [ ] **Step 5: 改 src/piRunner.js**

整个文件替换为：

```js
// pi 适配器：仅负责把 prompt 映射为 spawn 参数，不 spawn、不碰文件系统。
// 临时文件由 agentRunner 写入并传入 tmpFile；win32 引号由 agentRunner 统一处理（args 不含引号）。
// -p @tmpfile 为固定结构性参数；其余参数由 buildMappedArgs 从 agentConfig 按约定映射生成，args 数组原样追加。
const { buildMappedArgs } = require('./args.js');

function buildPiArgs(prompt, { tmpFile, cwd, agentConfig }) {
  const cmd = agentConfig?.path ?? 'pi';
  const args = ['-p', '@' + tmpFile, ...buildMappedArgs(agentConfig)];
  if (Array.isArray(agentConfig?.args)) args.push(...agentConfig.args);
  return { cmd, args };
}

module.exports = { buildPiArgs };
```

- [ ] **Step 6: 改 src/claudeRunner.js**

整个文件替换为：

```js
// claude 适配器：仅负责把 prompt 映射为 spawn 参数，不 spawn、不碰文件系统。
// prompt 走 stdin（stdin: true 声明，由 agentRunner 写入子进程 stdin）：
// claude -p 不带 prompt 参数时从 stdin 读；不用内联 argv，避免 win32 shell:true
// 下 prompt 含引号/反引号/$()/换行被 cmd.exe 拆坏，也绕开 Linux 单参数 128KB 上限。
// -p 为固定结构性参数；其余参数由 buildMappedArgs 从 agentConfig 按约定映射生成
// （如 permissionMode: "bypassPermissions" → --permission-mode bypassPermissions），args 数组原样追加。
const { buildMappedArgs } = require('./args.js');

function buildClaudeArgs(prompt, { agentConfig }) {
  const cmd = agentConfig?.path ?? 'claude';
  const args = ['-p', ...buildMappedArgs(agentConfig)];
  if (Array.isArray(agentConfig?.args)) args.push(...agentConfig.args);
  return { cmd, args, stdin: true };
}

module.exports = { buildClaudeArgs };
```

- [ ] **Step 7: 运行验证通过**

Run: `node --test test/piRunner.test.js test/claudeRunner.test.js test/agentRunner.test.js`
Expected: PASS

- [ ] **Step 8: 全量回归**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 9: 手动验证当前 config.json 生成参数**

Run:

```bash
node -e "const { loadConfig } = require('./src/config.js'); const { buildPiArgs } = require('./src/piRunner.js'); const c = loadConfig('./config.json'); console.log(JSON.stringify(buildPiArgs('x', { tmpFile: 'F:/tmp/t.md', cwd: '.', agentConfig: c.agentConfig }), null, 2));"
```

Expected: `args` 为 `['-p', '@F:/tmp/t.md', '--session-dir', '<config 目录>/.pi/pi-sessions']`——与改造前一致（sessionDir 仍解析为绝对路径且位置不变）

- [ ] **Step 10: 提交**

```bash
git add src/piRunner.js src/claudeRunner.js test/piRunner.test.js test/claudeRunner.test.js test/agentRunner.test.js
git commit -m "feat: pi/claude 适配器参数全部由配置生成，移除硬编码参数"
```

---

### Task 3: 注册表 pathKeys + config.js 校验改造

**Files:**
- Modify: `src/agents.js`（`optionKeys` → `pathKeys`）
- Modify: `src/config.js`（删除白名单；类型校验；pathKeys 相对解析；agentConfig 组装）
- Test: `test/agents.test.js`、`test/config.test.js`

**Interfaces:**
- Consumes: 无新增依赖
- Produces: `agents[agent].pathKeys`（字符串数组，路径类 key）；`loadConfig` 返回的 `agentConfig` 形状：`{ path, ...agentBlock 除 path 外全部字段 }`，其中 `pathKeys` 声明的 key 已解析为绝对路径；未配置 pi 块时 `agentConfig` 为 `{ path: 'pi' }`（无 sessionDir 键）

- [ ] **Step 1: 改 test/agents.test.js（预期失败：optionKeys 还在）**

将两个注册表断言用例整体替换为：

```js
test('注册表：pi 条目声明 buildArgs 与 pathKeys', () => {
  assert.strictEqual(agents.pi.buildArgs, buildPiArgs);
  assert.deepStrictEqual(agents.pi.pathKeys, ['sessionDir']);
});

test('注册表：claude 条目声明 buildArgs 与 pathKeys', () => {
  assert.strictEqual(agents.claude.buildArgs, buildClaudeArgs);
  assert.deepStrictEqual(agents.claude.pathKeys, []);
});
```

- [ ] **Step 2: 改 test/config.test.js 的 6 处现有用例 + 追加 5 个校验用例**

改动 1——「缺省值」用例（原断言 sessionDir 缺省为 config 目录）：

```js
test('缺省值：intervalSeconds 缺省 60，agent 缺省 pi，未配置 pi 块时 agentConfig 只有 path', () => {
  const { configPath } = makeFixture();
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete raw.intervalSeconds;
  delete raw.agent;
  delete raw.pi;
  fs.writeFileSync(configPath, JSON.stringify(raw), 'utf8');
  const result = loadConfig(configPath);
  assert.strictEqual(result.intervalSeconds, 60);
  assert.strictEqual(result.agent, 'pi');
  assert.deepStrictEqual(result.agentConfig, { path: 'pi' });
});
```

改动 2——原「agent 配置块出现未声明 key 时报错并列出允许值」用例改为透传：

```js
test('agent 配置块任意映射字段透传进 agentConfig', () => {
  const { configPath } = makeFixture({ pi: { sessionDir: './.pi-sessions', model: 'x', thinking: 'max' } });
  const result = loadConfig(configPath);
  assert.strictEqual(result.agentConfig.model, 'x');
  assert.strictEqual(result.agentConfig.thinking, 'max');
});
```

改动 3——「agent 配置块缺省时 agentConfig 用默认值」用例改为：

```js
test('agent 配置块缺省时 agentConfig 只有 path 缺省值', () => {
  const { configPath } = makeFixture();
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete raw.agent;
  delete raw.pi;
  fs.writeFileSync(configPath, JSON.stringify(raw), 'utf8');
  const result = loadConfig(configPath);
  assert.strictEqual(result.agent, 'pi');
  assert.deepStrictEqual(result.agentConfig, { path: 'pi' });
});
```

改动 4——「claude 配置块缺省时 agentConfig.path 为 claude」用例删掉 sessionDir 断言：

```js
test('claude 配置块缺省时 agentConfig.path 为 claude', () => {
  const { configPath } = makeFixture({ agent: 'claude' });
  const result = loadConfig(configPath);
  assert.strictEqual(result.agent, 'claude');
  assert.strictEqual(result.agentConfig.path, 'claude');
  assert.strictEqual(result.agentConfig.sessionDir, undefined);
});
```

改动 5——原「claude 配置块出现未声明 key 时报错并列出允许值」用例改为透传：

```js
test('claude 配置块任意映射字段透传进 agentConfig', () => {
  const { configPath } = makeFixture({ agent: 'claude', claude: { permissionMode: 'bypassPermissions' } });
  const result = loadConfig(configPath);
  assert.strictEqual(result.agentConfig.permissionMode, 'bypassPermissions');
});
```

改动 6——文件末尾追加 5 个校验用例：

```js
test('agent 配置块字段为数组时报错提示改用 args', () => {
  const { configPath } = makeFixture({ pi: { sessionDir: './x', tags: ['a'] } });
  assert.throws(() => loadConfig(configPath), /不能是数组，请改用 args/);
});

test('agent 配置块字段为对象时报错', () => {
  const { configPath } = makeFixture({ pi: { sessionDir: './x', nested: { a: 1 } } });
  assert.throws(() => loadConfig(configPath), /必须是字符串、数字或布尔值/);
});

test('agent 配置块 args 非字符串数组时报错', () => {
  const { configPath } = makeFixture({ pi: { sessionDir: './x', args: [1] } });
  assert.throws(() => loadConfig(configPath), /"args" 必须是字符串数组/);
});

test('agent 配置块 args 透传', () => {
  const { configPath } = makeFixture({ pi: { sessionDir: './x', args: ['--a', '1'] } });
  const result = loadConfig(configPath);
  assert.deepStrictEqual(result.agentConfig.args, ['--a', '1']);
});

test('agent 配置块 false 值不报错并透传', () => {
  const { configPath } = makeFixture({ pi: { sessionDir: './x', quiet: false } });
  const result = loadConfig(configPath);
  assert.strictEqual(result.agentConfig.quiet, false);
});
```

- [ ] **Step 3: 运行验证失败**

Run: `node --test test/agents.test.js test/config.test.js`
Expected: FAIL（pathKeys 不存在、未知字段仍报错、agentConfig 形状不符）

- [ ] **Step 4: 改 src/agents.js**

整个文件替换为：

```js
const { buildPiArgs } = require('./piRunner.js');
const { buildClaudeArgs } = require('./claudeRunner.js');

// 新增 agent：创建 src/<name>.js 导出 build<Name>Args(prompt, { tmpFile, cwd, agentConfig }) → { cmd, args, stdin? }，
// 然后在此注册一行（buildArgs 实现 + pathKeys 路径类 key 声明——值由 config.js 相对 config 目录解析为绝对路径），
// 自动获得：config 的 agent 校验、[agent] 块校验、main 的分发、通用执行层（临时文件/SIGINT/退出码）。
// 适配器只拼固定结构性参数（如 -p @tmpfile），其余参数由 args.js 的 buildMappedArgs 从 agentConfig 按约定映射生成。
const agents = {
  pi: {
    buildArgs: buildPiArgs,
    pathKeys: ['sessionDir'],
  },
  claude: {
    buildArgs: buildClaudeArgs,
    pathKeys: [],
  },
};

const AGENT_KEYS = Object.keys(agents);

module.exports = { agents, AGENT_KEYS };
```

- [ ] **Step 5: 改 src/config.js**

将 `loadConfig` 中从 `const allowedKeys = agents[agent].optionKeys;` 到 `const agentConfig = {...};` 的整段（约 18 行）替换为：

```js
  const pathKeys = agents[agent].pathKeys;
  for (const [key, value] of Object.entries(agentBlock ?? {})) {
    if (key === 'path') {
      if (typeof value !== 'string') {
        throw new Error(`${agent} 配置块的 path 必须是字符串`);
      }
    } else if (key === 'args') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new Error(`${agent} 配置块字段 "args" 必须是字符串数组`);
      }
    } else if (pathKeys.includes(key)) {
      if (typeof value !== 'string') {
        throw new Error(`${agent} 配置块字段 "${key}" 必须是字符串`);
      }
    } else if (Array.isArray(value)) {
      throw new Error(`${agent} 配置块字段 "${key}" 不能是数组，请改用 args`);
    } else if (value !== null && typeof value === 'object') {
      throw new Error(`${agent} 配置块字段 "${key}" 必须是字符串、数字或布尔值`);
    }
  }
  const agentConfig = { path: agentBlock?.path ?? agent };
  for (const [key, value] of Object.entries(agentBlock ?? {})) {
    if (key === 'path') continue;
    agentConfig[key] = pathKeys.includes(key) ? path.resolve(configDir, value) : value;
  }
```

- [ ] **Step 6: 运行验证通过**

Run: `node --test test/agents.test.js test/config.test.js`
Expected: PASS

- [ ] **Step 7: 全量回归**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 8: 提交**

```bash
git add src/agents.js src/config.js test/agents.test.js test/config.test.js
git commit -m "feat: agent 配置块任意字段透传，pathKeys 路径类 key 相对解析"
```

---

### Task 4: 文档、示例与版本收尾

**Files:**
- Modify: `config.example.json`、`README.md`、`AGENTS.md`、`package.json`

**Interfaces:**
- Consumes: Task 1-3 的最终行为（映射规则、pathKeys、args 兜底）

- [ ] **Step 1: 更新 config.example.json**

pi 块补 `thinking`/`model`（其余保持原样）：

```json
{
  "intervalSeconds": 60,
  "agent": "pi",
  "pi": {
    "sessionDir": "./.pi-sessions",
    "thinking": "max",
    "model": "deepseek-v4-flash"
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
    },
    {
      "source": "jira",
      "labels": ["taskloop"],
      "notLabels": ["explored"],
      "assignee": "me",
      "promptTemplate": "templates/analyze.md"
    }
  ]
}
```

- [ ] **Step 2: 更新 README「agent 专属配置块」整节**

将 `### agent 专属配置块` 到 `切换 agent 只需改 \`agent\` 字段并重写对应配置块。` 的整节替换为：

````markdown
### agent 专属配置块

顶层 `{agent}` 命名的对象（如 `pi`、`claude`）存放该 agent 的调用参数。除保留字段外，任意字段经约定映射生成 CLI 参数：

| 配置值类型 | 生成的 CLI 参数 |
| --- | --- |
| 字符串/数字 `"key": "v"` | `--key v`（camelCase 自动转 kebab-case，如 `permissionMode` → `--permission-mode`） |
| `true` | `--key`（纯 flag） |
| `false` / `null` | 跳过不传 |
| 数组 | 启动报错，改用 `args` |

保留/特殊字段：

| 字段 | 说明 |
| --- | --- |
| `path` | 可执行文件命令名或完整路径，缺省为 agent 名（`"pi"`/`"claude"`），不参与映射 |
| `args` | 字符串数组，原样拼接在所有参数之后（表达重复 flag 等映射覆盖不了的场景） |
| 路径类 key | 注册表 `pathKeys` 声明的 key（如 pi 的 `sessionDir`），值相对 config 文件所在目录解析为绝对路径后，作为普通映射参数生成 |

固定结构性参数：`-p @tmpfile`（pi）/ `-p` + stdin（claude）是 prompt 传递机制，代码固定、不可配置。参数顺序：结构性参数 → 映射参数（config 书写顺序）→ `args`。

```json
{
  "agent": "pi",
  "pi": { "sessionDir": "./.pi-sessions", "thinking": "max", "model": "deepseek-v4-flash" }
}
```

生成命令行：`pi -p @<tmpfile> --session-dir <绝对路径> --thinking max --model deepseek-v4-flash`。

claude 不再自动附带 `--permission-mode bypassPermissions`，需要时显式配置：

```json
{
  "agent": "claude",
  "claude": { "permissionMode": "bypassPermissions" }
}
```

切换 agent 只需改 `agent` 字段并重写对应配置块。
````

- [ ] **Step 3: 更新 README「扩展新 Agent」一节**

步骤 1 的适配器示例代码替换为：

```js
   // src/myagent.js
   const { buildMappedArgs } = require('./args.js');

   function buildMyagentArgs(prompt, { tmpFile, cwd, agentConfig }) {
     const cmd = agentConfig?.path ?? 'myagent';
     const args = ['-p', '@' + tmpFile, ...buildMappedArgs(agentConfig)];
     if (Array.isArray(agentConfig?.args)) args.push(...agentConfig.args);
     return { cmd, args };
   }

   module.exports = { buildMyagentArgs };
```

步骤 2 的整段（注册表示例 + 「注册后自动获得」段落 + config 用法 JSON）替换为：

````markdown
2. **在 `src/agents.js` 注册一行**，声明路径类 key（值由 config 相对 config 文件目录解析为绝对路径，如 pi 的 `sessionDir`）：

   ```js
   const agents = {
     pi: { buildArgs: buildPiArgs, pathKeys: ['sessionDir'] },
     claude: { buildArgs: buildClaudeArgs, pathKeys: [] },
     myagent: { buildArgs: buildMyagentArgs, pathKeys: [] },
   };
   ```

   注册后自动获得：`config` 的 `agent` 校验（错误消息列出合法值）、`{agent}` 配置块校验（任意字段经约定映射生成 CLI 参数，见「agent 专属配置块」）、`main` 按 agent 分发、通用执行层。config 用法：

   ```json
   { "agent": "myagent", "myagent": { "path": "myagent", "model": "x" } }
   ```
````

- [ ] **Step 4: 更新 AGENTS.md 两处**

「扩展走注册表」一条中的 agent 部分替换为：

```markdown
- **扩展走注册表，只写实现不注册不会生效**：新任务来源 → 新建 `src/<name>.js` 导出 `fetchTasks(rule, { httpClient, url, token })`，并在 `src/sources.js` 注册（tokenEnv/urlEnv/defaultUrl/placeholders）；HTTP 请求复用 `src/youTrack.js` 的 `createHttpClient`（依赖注入，便于 mock）。新 agent → 新建 `src/<name>.js` 导出 `build<Name>Args(prompt, { tmpFile, cwd, agentConfig })` 纯函数，并在 `src/agents.js` 注册（含 pathKeys，路径类 key 声明，值由 config.js 相对 config 目录解析）；返回 `{ cmd, args }`，若 prompt 走 stdin（如 claude）返回 `{ cmd, args, stdin: true }`，由 agentRunner 写入子进程 stdin。适配器只拼固定结构性参数（如 `-p @tmpfile`），其余参数用 `src/args.js` 的 `buildMappedArgs(agentConfig)` 按约定映射生成（camelCase→kebab-case、`true` 纯 flag、`false`/`null` 跳过），`agentConfig.args` 数组原样追加在末尾
```

「配置文件」一条补一行（追加在该条末尾）：

```markdown
- agent 块任意字段经约定映射生成 CLI 参数：`"thinking": "max"` → `--thinking max`，`true` → `--key`，`false`/`null` 跳过，数组报错改用 `args` 数组原样透传；`path` 为命令名（缺省 agent 名），路径类 key（如 pi 的 `sessionDir`）相对 config 目录解析
```

- [ ] **Step 5: package.json 版本号 0.2.0 → 0.3.0**

将 `"version": "0.2.0"` 改为 `"version": "0.3.0"`。

- [ ] **Step 6: 全量回归**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add config.example.json README.md AGENTS.md package.json
git commit -m "docs: 参数映射文档与示例同步，版本号升至 0.3.0"
```

---

## Self-Review

**Spec coverage:**
- 约定映射 + args 兜底 → Task 1（args.js）与 Task 3（适配器拼接）
- 值类型语义（true/false/null/数组/对象）→ Task 1 + Task 2 校验
- 参数顺序（结构性参数 → 书写顺序 → args）→ Task 3
- path 缺省 agent 名 → Task 2（`agentBlock?.path ?? agent`）
- pathKeys 相对 config 目录解析 → Task 2（`path.resolve(configDir, value)`）
- 移除硬编码（pi 的 --session-dir 强制、claude 的 --permission-mode）→ Task 3
- 无缺省（不写不传）→ Task 2 的 agentConfig 组装 + Task 3 的 undefined 跳过
- 文档/示例/AGENTS.md/版本号 → Task 4
- 现有用例同步修改（config/agents/piRunner/claudeRunner/agentRunner 测试）→ Task 2、Task 3

**Placeholder scan:** 无 TBD/TODO；所有代码块为实际内容。

**Type consistency:** `buildMappedArgs(agentBlock)` 无第二参数（Task 1 定义、Task 3 调用一致）；`agents[agent].pathKeys`（Task 2 定义、Task 2 config.js 消费一致）；`agentConfig.args` 数组（Task 2 透传、Task 3 追加一致）。

**任务顺序说明：** 适配器改造（Task 2）先于 config.js 改造（Task 3），适配器测试用直接构造的 agentConfig、不依赖 loadConfig，每个任务结束时 npm test 均全绿，无临时失败状态。
