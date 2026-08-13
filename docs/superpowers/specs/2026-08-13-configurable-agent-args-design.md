# Agent 参数可配置化（configurable-agent-args）设计

日期：2026-08-13
状态：已批准（用户逐节确认）

## 背景与目标

taskloop 目前把 agent 的 CLI 参数硬编码在适配器里：pi 固定 `-p @tmpfile --session-dir <sessionDir>`，claude 固定 `-p --permission-mode bypassPermissions`。`config.js` 对 agent 块的校验只允许注册表 `optionKeys` 声明的字段（pi：`sessionDir`/`path`；claude：`path`），写其他字段直接启动报错。

物理机/模型/思考级别等参数（如 `--thinking`、`--model`）无法通过配置传入，必须改代码。本次改造把「agent 块 → CLI 参数」变成通用可配置映射：config.json 里写什么参数，调用 agent 时就带什么参数，不写不传。

目标：`config.json` 中

```json
{
  "agent": "pi",
  "pi": {
    "sessionDir": "./.pi-sessions",
    "thinking": "max",
    "model": "deepseek-v4-flash"
  }
}
```

调用 pi 时生成 `pi -p @tmpfile --session-dir <abs> --thinking max --model deepseek-v4-flash`，其他参数同理。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 参数生成方式 | 约定映射为主 + `args` 数组兜底（两者结合） |
| 约定映射 | agent 块任意字段 `key: value` → CLI 参数；camelCase 自动转 kebab-case（`permissionMode` → `--permission-mode`） |
| 值类型语义 | 字符串/数字 → `--key value`；`true` → `--key`（纯 flag）；`false`/`null` → 跳过；数组 → 配置校验报错，提示改用 `args` |
| `args` 数组 | 原样逐项拼接到**最后**，不转换、不校验；用于表达约定映射覆盖不了的场景（如重复 flag） |
| 参数顺序 | `-p @tmpfile` 固定最前 → 映射参数按 config 书写顺序 → `args` 数组 |
| 结构性参数 | `-p @tmpfile`（pi）/ `-p` + stdin（claude）保持代码固定，不受配置控制，文档说明 |
| 缺省值 | 除 `path` 外**无代码缺省**：不写就不传。`path` 缺省为 agent 名（`"pi"`/`"claude"`） |
| 硬编码参数 | 移除：pi 不再强制 `--session-dir`、claude 不再强制 `--permission-mode`，全部由配置决定 |
| 路径解析 | 涉及文件/目录的参数值统一相对 **config 文件所在目录**解析（`pathKeys` 声明，如 `sessionDir`） |
| 兼容性 | 用户当前 config.json（已写 `sessionDir`）行为完全不变 |

## 配置格式

```jsonc
{
  "agent": "pi",
  "pi": {
    "path": "pi",                    // 命令名/完整路径，唯一保留缺省的字段（缺省 agent 名）
    "sessionDir": "./.pi-sessions",  // 路径类 key，相对 config 文件目录解析
    "thinking": "max",               // → --thinking max
    "model": "deepseek-v4-flash",    // → --model deepseek-v4-flash
    "verbose": true,                 // → --verbose
    "quiet": false,                  // 跳过
    "args": ["--extra", "x"]         // 原样拼到末尾
  },
  "rules": [...]
}
```

```jsonc
{
  "agent": "claude",
  "claude": {
    "permissionMode": "bypassPermissions"  // → --permission-mode bypassPermissions（必须显式写，不再自动附带）
  },
  "rules": [...]
}
```

约束：

- `path`、`args`、`pathKeys` 声明的 key 为保留/特殊字段，不参与约定映射；其余任意 key 均可写，不再报「不允许字段」
- `args` 必须是字符串数组（允许空数组）；出现两次 `args` 不可能（JSON key 唯一），无需处理
- 数组值（除 `args`）报错：`pi 配置块字段 "xxx" 不能是数组，请改用 args`
- 对象值报错：`pi 配置块字段 "xxx" 必须是字符串、数字或布尔值`

## 组件职责与接口

### src/args.js（新增，映射公共逻辑）

```js
function toKebabCase(key) {
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

// agentBlock 中除保留字段（path、args）外的字段 → CLI 参数
// 按对象书写顺序展开；返回数组，不包含 args 的内容
// pathKeys 声明的 key 值已由 config.js 解析为绝对路径，此处按普通映射字段处理
function buildMappedArgs(agentBlock) {
  const mapped = [];
  for (const [key, value] of Object.entries(agentBlock ?? {})) {
    if (key === 'path' || key === 'args') continue;
    if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
      throw new Error(...); // 中文消息，由 config 校验层提前拦截，此处兜底
    }
    if (value === false || value === null || value === undefined) continue;
    const flag = '--' + toKebabCase(key);
    if (value === true) mapped.push(flag);
    else mapped.push(flag, String(value));
  }
  return mapped;
}
```

适配器不识别任何业务 key（含 sessionDir），全部由 config.js 预处理后统一映射。两个适配器共用 `buildMappedArgs` + `toKebabCase`。

### src/piRunner.js（适配器改造）

```js
const { buildMappedArgs } = require('./args.js');

function buildPiArgs(prompt, { tmpFile, cwd, agentConfig }) {
  const cmd = agentConfig?.path ?? 'pi';
  const args = ['-p', '@' + tmpFile, ...buildMappedArgs(agentConfig)];
  if (Array.isArray(agentConfig?.args)) args.push(...agentConfig.args);
  return { cmd, args };
}
```

- `-p @tmpfile` 固定最前，随后是映射参数（config 书写顺序），最后 `args`
- `sessionDir` 无特殊处理：未配置则 agentConfig 中为 undefined，映射跳过、不传 `--session-dir`；已配置则值已由 config.js 解析为绝对路径，与其它参数一样按书写顺序生成（用户 config 中通常写在首位，顺序与现状一致）

### src/claudeRunner.js（适配器改造）

```js
function buildClaudeArgs(prompt, { agentConfig }) {
  const cmd = agentConfig?.path ?? 'claude';
  const args = ['-p', ...buildMappedArgs(agentConfig)];
  if (Array.isArray(agentConfig?.args)) args.push(...agentConfig.args);
  return { cmd, args, stdin: true };
}
```

- 移除硬编码 `--permission-mode bypassPermissions`；`permissionMode` 走约定映射生成
- `stdin: true` 与 win32 引号处理（agentRunner）不变

### src/agents.js（注册表改造）

```js
const agents = {
  pi: { buildArgs: buildPiArgs, pathKeys: ['sessionDir'] },
  claude: { buildArgs: buildClaudeArgs, pathKeys: [] },
};
```

`optionKeys` 更名 `pathKeys`：语义从「允许字段白名单」变为「路径类 key 声明（相对 config 目录解析）」，不再用于拒绝未知字段。

### src/config.js（校验改造）

删除未知 key 报错与 `allowedKeys` 白名单逻辑；新增：

- 遍历 agent 块：`path` 必须字符串；`args` 必须字符串数组；`pathKeys` 声明的 key 必须字符串（`sessionDir`）；其余 key 值必须是字符串/数字/布尔（数组、对象报错中文消息；null 合法，映射时跳过）
- `agentConfig` 组装：`path` 缺省 agent 名；`pathKeys` 声明的 key 值解析为相对 configDir 的绝对路径后存进 `agentConfig`（未配置则 key 不存在）；其余 key 原样透传进 `agentConfig`，供 `buildMappedArgs` 生成参数
- `agentConfig.args` 原样透传

错误消息为中文并被 test 断言，例如：

- `pi 配置块字段 "sessionDir" 必须是字符串`
- `pi 配置块字段 "model" 必须是字符串、数字或布尔值`
- `pi 配置块字段 "tags" 不能是数组，请改用 args`
- `pi 配置块字段 "args" 必须是字符串数组`

## 数据流（单任务执行）

```
config.json → loadConfig
  ├→ 校验 agent 块值类型，pathKeys 相对解析 → agentConfig { path, sessionDir?, thinking, model, ..., args? }
  └→ runCycle → runAgent(prompt, { agent, cwd, agentConfig })
        └→ buildPiArgs/buildClaudeArgs
              ├→ cmd = agentConfig.path ?? agent
              ├→ 固定前缀（-p @tmpfile / -p）
              ├→ buildMappedArgs（path/args 外全部字段，书写顺序，camelCase→kebab-case，true 纯 flag，false/null/undefined 跳过；pathKeys 的值已由 config.js 解析为绝对路径）
              └→ args 原样拼接
              → agentRunner spawn
```

## 错误处理

| 场景 | 行为 |
|---|---|
| 保留/路径类 key 类型错误（`path`/`sessionDir` 非字符串、`args` 非字符串数组） | 启动报错 exit 1，中文消息指明字段 |
| 映射字段值为数组/对象 | 启动报错 exit 1，数组提示改用 `args` |
| `false` 值 | 不报错，跳过该参数 |
| 可执行文件不存在（spawn error） | 现状不变：reject 冒泡，记日志，本轮中止 |
| 参数含空格/特殊字符 | 现状不变：win32 由 agentRunner 统一包引号（非 `-` 开头参数），适配器返回的 args 不带引号 |

## 测试设计

`node --test` 运行，全部单测，不 spawn 真实进程。

| 测试文件 | 覆盖内容 |
|---|---|
| `test/args.test.js`（新增） | `toKebabCase`（camelCase→kebab-case）；`buildMappedArgs` 各类型：字符串/数字 → `--key value`、`true` → `--key`、`false`/`null`/`undefined` 跳过、数组/对象报错、保留字段（path/args）跳过、按书写顺序展开 |
| `test/piRunner.test.js`（改造） | 无 sessionDir 时不传 `--session-dir`；有 sessionDir（含在 agentConfig 中）时按书写顺序生成 `--session-dir <值>`；映射参数（如 thinking/model）与 `args` 追加顺序；`path` 缺省 `pi` |
| `test/claudeRunner.test.js`（改造） | 不再硬编码 `--permission-mode`；`permissionMode` 配置生成 `--permission-mode value`；`args` 追加；`stdin: true` 保持 |
| `test/agents.test.js`（改造） | 注册表字段 `optionKeys` → `pathKeys`（pi `['sessionDir']`、claude `[]`） |
| `test/config.test.js`（改造） | 删除两条「未知字段报错」用例；现有「sessionDir 缺省 config 所在目录」用例改为「未配置 sessionDir 时 `agentConfig` 无 sessionDir 键」；新增：映射字段类型校验（数组/对象报错、null 透传跳过）、`args` 非字符串数组报错、`args` 透传、pathKeys 相对解析、未知映射字段合法且透传进 `agentConfig` |
| `test/agentRunner.test.js` | 不涉及生成逻辑，若现有断言依赖 pi 固定 args 则同步更新 |

现有用例中会挂掉并同步修改的：

- `test/config.test.js`：「agent 配置块出现未声明 key 时报错并列出允许值」「claude 配置块出现未声明 key 时报错并列出允许值」→ 改为合法透传
- `test/agents.test.js`：`optionKeys` 断言 → `pathKeys`
- `test/piRunner.test.js`：`--session-dir` 断言改为「映射生成」（sessionDir 值经 config 解析后传入）
- `test/claudeRunner.test.js`：`--permission-mode bypassPermissions` 硬编码断言 → 配置生成

## 文档

README 更新：

1. 「agent 专属配置块」一节重写：任意字段经约定映射生成 CLI 参数；映射规则表（值类型 → 参数）；`args` 兜底；`path` 缺省；路径类 key 相对 config 目录解析；`-p @tmpfile`/stdin 为固定结构性参数不可配置
2. 示例 JSON 更新：pi 块补 `thinking`/`model`；claude 块补 `permissionMode: "bypassPermissions"` 并注明必须显式写
3. 「扩展新 Agent」一节同步：注册表字段 `optionKeys` → `pathKeys`（路径类 key 声明）

AGENTS.md 约定同步：

- 「扩展走注册表」中 agent 适配器说明更新为：适配器只拼固定结构性参数，其余参数由 `buildMappedArgs` 从 `agentConfig` 按约定映射生成；注册表 `pathKeys` 声明路径类 key
- 「配置文件」一节补：agent 块任意字段映射为 CLI 参数（camelCase→kebab-case），`args` 数组原样兜底

`config.example.json` 更新：pi 块补 `thinking`/`model` 演示；claude 演示补 `permissionMode`。

## 明确不做（YAGNI）

- 不做 per-rule 的 agent/参数覆盖（仍全局一份 agentConfig）
- 不做参数占位符（如 `{youtrack_id}` 出现在参数值中）——保持字面透传
- 不做映射值的嵌套对象/数组语义（数组一律报错，用 `args` 表达）
- 不做 `-p @tmpfile` 的可配置化（prompt 传递机制固定）
- 不重写 agentRunner 的 win32 引号处理（适配器返回值约定不变：args 不带引号）

## 验证标准

1. `npm test` 全部通过（含改造后的既有用例）
2. 用用户当前 `config.json` 启动：`--session-dir F:/liuxin/temp/temp/.pi/pi-sessions` 生成不变（行为零回归）
3. 示例配置（含 `thinking`/`model`）生成命令行含对应参数且顺序正确
4. README、AGENTS.md、`config.example.json` 与实现同步
