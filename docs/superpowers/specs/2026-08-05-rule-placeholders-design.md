# taskloop promptTemplate 规则级占位符设计

日期：2026-08-05
状态：已批准（用户逐节确认）

## 背景与目标

现有 taskloop 的模板占位符只有任务级 `{youtrack_id}`、`{wiki_url}`，替换值来自任务（task）。而"完成后打上排除标签"的机制依赖模板硬编码标签名（如 `explored`）：config.json 的 `notLabels` 改动后，模板必须同步修改，两处不一致会造成 Agent 打完旧标签后任务被重复抓取（或模板与新配置不一致）。

本次为 promptTemplate 增加规则级占位符 `{labels}`、`{not_labels}`，替换值来自规则配置（rule），运行时替换后再传给 Agent。此后修改 config.json 的 labels/notLabels 无需再改模板。

## 核心需求

1. 模板支持 `{labels}`、`{not_labels}` 两个规则级占位符，替换为规则配置对应数组按 `, `（逗号+空格）连接的结果
2. `notLabels` 未配置（空数组）时替换为空字符串
3. 任务级占位符 `{youtrack_id}`、`{wiki_url}` 行为不变；"未提供值原样保留"的行为不变
4. 示例模板改用 `{not_labels}` 演示新能力，README 占位符表同步更新

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 占位符范围 | `{labels}` 与 `{not_labels}` 都暴露 |
| 数组渲染格式 | 逗号+空格分隔（`ready, explorer`） |
| 空数组行为 | 替换为空字符串 |
| 实现方式 | 显式扩展 renderTemplate 签名（方案 1），数组 join 在调用方 main.js 组装 |
| 命名风格 | snake_case，与现有 `{youtrack_id}`、`{wiki_url}` 一致 |

## 架构与组件

### src/template.js

`renderTemplate` 签名扩展为：

```js
function renderTemplate(content, { youtrackId, wikiUrl, labels, notLabels } = {})
```

- 任务级参数（youtrackId/wikiUrl）：维持现有"存在才替换"逻辑
- 规则级参数（labels/notLabels）：存在即替换（含空字符串），undefined/null 时原样保留

### src/main.js

`runCycle` 渲染处组装规则级值：

```js
const prompt = renderTemplate(template, {
  youtrackId: task.idReadable,
  wikiUrl: task.url,
  labels: rule.labels.join(', '),
  notLabels: rule.notLabels.join(', '),
});
```

join 放在调用方，renderTemplate 保持纯替换职责。

### templates/

- `templates/yt-explorer.md`、`templates/wiki-exploer.md`：末尾"为该任务打上 `explored` 的标签"改为"为该任务打上 `{not_labels}` 的标签"

### README.md

「模板占位符」表补充两行：

| 占位符 | 替换值 |
| --- | --- |
| `{labels}` | 规则配置 labels 的 `, ` 连接 |
| `{not_labels}` | 规则配置 notLabels 的 `, ` 连接（未配置时为空字符串） |

### 测试

- `test/template.test.js`：`{labels}`/`{not_labels}` 替换、多标签 `, ` 连接、空数组替换为空串、未提供时原样保留
- `test/main.test.js`：runCycle 集成用例，模板含规则级占位符时渲染正确（现有 fixture 模板无规则级占位符，不破坏现有用例）

## 数据流

config.json → loadConfig（校验，notLabels 缺省 `[]`）→ runCycle → renderTemplate（规则级 + 任务级占位符）→ runPi(prompt)

## 错误处理

无新增错误路径。替换为纯字符串操作；模板读取失败逻辑不变。
