# 模板片段复用（template-include）设计

日期：2026-08-10
状态：待用户审阅

## 背景与目标

templates/ 下的提示词之间存在大量重复内容，修改一处容易漏改另一处，已实际发生：`wiki-exploer.md` 与 `yt-explorer.md` 的产品路径表本应完全一致，目前 yt 版比 wiki 版多 2 行，即上次只改了一个文件的后果。

重复内容分两类：

1. **数据类**：产品路径表（两个模板各自维护一份，已漂移）
2. **结构类**：无人值守句、Constraints、Verification、Output format 等公共段落（`yt-explorer.md` 与 `yt-for-jira-explorer.md` 各有一份 Output format）

目标：**渲染期 include 片段机制**，让公共内容只有一份，模板按需组合。未来新增 yt 任务模板时，统一回复格式直接 `{{include}}` 复用，天然保持一致。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 方案选择 | 方案 A（渲染期 include），否掉方案 C（路径表进 config.json——只解决数据去重，解决不了回复格式等结构复用） |
| 引入依赖 | 零第三方依赖，只用 node:fs / node:path / 字符串处理，符合 AGENTS.md 约定 |
| include 语法 | `{{include:相对路径}}`（双花括号，与现有 `{youtrack_id}` 等单花括号占位符不冲突） |
| 路径解析 | 相对**包含该指令的文件**所在目录；嵌套片段内相对片段自身目录；只允许相对路径，绝对路径报错 |
| 展开顺序 | 先展开 include，再做占位符替换（片段内可正常使用 `{not_labels}` 等占位符） |
| renderTemplate | **保持不变**（纯函数、无 IO），现有测试零改动；include 展开为独立新函数 |
| 渲染入口 | template.js 提供一体入口 `renderTemplateFile(templatePath, placeholders)`（读文件 + 展开 include + 替换占位符），main.js 不直接碰渲染逻辑 |
| 片段抽取与模板改造 | **由用户负责**，不在本任务实施范围（见「模板改造边界」）；本任务只交付机制 + example-workflow.md 用法演示 |

## include 语法与解析规则

```markdown
## Output format:

{{include:parts/yt-output-format.md}}
```

| 规则 | 行为 |
|---|---|
| 匹配格式 | `{{include:<路径>}}`，路径 trim 后非空且不含 `}` |
| 相对基准 | 当前文件所在目录（主模板 = 模板目录；片段 = 片段所在目录） |
| 嵌套 | 支持，片段内可以再 include，深度不限（受循环检测约束） |
| 循环检测 | 维护已展开的绝对路径集合，重复展开同一文件即报错 |
| 文件缺失/读取失败 | 抛错（模板写错应立即暴露），由 main.js 现有 try/catch 记日志跳过该任务 |
| 插入方式 | 指令行整体替换为片段内容（原样插入，不留空白处理），指令行前后换行保留 |

## 代码改动

### src/template.js

渲染逻辑全部收拢在本模块，新增两个导出：

```js
// expandIncludes(content, baseDir) → 展开后的完整文本
// 1. 正则匹配 {{include:...}}
// 2. path.isAbsolute(路径) 则抛错；否则 path.resolve(baseDir, 路径)
// 3. 已展开集合包含该绝对路径 → 抛错（循环引用）
// 4. fs.readFileSync 读取，递归展开片段内容后替换回指令行
// 5. 返回展开结果
function expandIncludes(content, baseDir) { ... }

// renderTemplateFile(templatePath, placeholders) → 渲染后的完整 prompt
// 一体入口：读模板文件 → expandIncludes(path.dirname(templatePath)) → renderTemplate
function renderTemplateFile(templatePath, placeholders) { ... }
```

`renderTemplate` 保持纯函数不动；`expandIncludes` 单独导出供测试。

### src/main.js

不再直接读文件/渲染，只调用一体入口（`fs.readFileSync` 的职责移入 template.js）：

```js
const prompt = renderTemplateFile(rule.promptTemplate, {
  youtrackId: task.idReadable,
  wikiUrl: task.url,
  labels: rule.labels.join(', '),
  notLabels: rule.notLabels.join(', '),
});
```

catch 日志消息由「模板读取失败」改为「模板渲染失败」（覆盖 include 展开失败）。行为不变：失败记日志、跳过该任务、不中断整轮。现有 main.test.js 的「模板读取失败时跳过」用例不断言日志消息、只断言任务执行结果，无需改动。

## 模板改造边界（用户负责）

片段抽取与现有任务模板的业务改造由用户完成，不在本任务实施范围：`templates/parts/` 片段文件的内容划分、wiki-exploer.md / yt-explorer.md / yt-for-jira-explorer.md 的 include 改造、统一 yt 回复格式的具体方式。

本任务只交付机制与一处用法演示：

- 修改 `templates/example-workflow.md`（说明性模板，非业务模板），在其中演示 `{{include:...}}` 的用法，作为特性使用范例
- 片段目录的 .gitignore 注意事项（用户抽取片段时使用）：

```
templates/*
!templates/analyze.md
!templates/example-workflow.md
!templates/parts/
```

（`templates/*` 只匹配直接子项，`!templates/parts/` 解除目录忽略后，其内部文件无忽略规则命中，即可提交。）

## 测试设计

`test/template.test.js` 扩展（`expandIncludes` 用临时目录 + 真实文件测试，`node:test` 的 before/after 清理）：

| 用例 | 断言 |
|---|---|
| 无 include 指令 | 原样返回 |
| 基础替换 | `{{include:part.md}}` → 片段文件内容 |
| 相对 baseDir 解析 | 片段位于 baseDir 子目录 |
| 嵌套 include | 片段内 include 子片段，相对片段自身目录解析 |
| 循环引用 | a → b → a 抛错 |
| 文件不存在 | 抛错 |
| 绝对路径 | `{{include:D:\x.md}}` 抛错 |
| 集成：展开后再占位符替换 | 片段内含 `{not_labels}`，`expandIncludes` + `renderTemplate` 后正确替换 |
| 片段内 include 相同文件两次（非循环，顺序引用） | 正常展开（每次从根重新展开，不缓存） |
| renderTemplateFile 一体入口 | 真实模板文件读入 + include 展开 + 占位符替换全链路；模板文件缺失抛错 |

## 文档

README 更新（模板占位符一节）：
1. 新增「模板片段复用」小节：语法 `{{include:相对路径}}`、相对基准、嵌套与循环检测、先展开后替换占位符的顺序说明
2. 目录结构树补充 `templates/parts/`

## 明确不做（YAGNI）

- 不做变量/条件/循环等模板语法，只做 include
- 不做模板继承层次（base 模板覆盖机制）
- 不做片段缓存（每次渲染重新读文件，片段少、频率低，无需优化）
- 不做片段抽取与模板业务改造（用户负责）
- 方案 C（路径表进 config.json）已否，不再考虑

## 验证标准

1. `npm test` 全部通过（现有 renderTemplate 测试零改动 + 新增 expandIncludes 测试）
2. example-workflow.md 的 include 演示渲染正确（展开后与预期一致）
3. config.json 无需改动即可工作（promptTemplate 路径不变）
4. `git status` 确认 `templates/parts/` 新片段文件可被 git 跟踪（.gitignore 生效）
