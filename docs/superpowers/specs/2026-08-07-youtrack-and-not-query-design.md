# YouTrack 服务端精确 AND/NOT 查询设计

日期：2026-08-07

## 背景

当前 `src/youTrack.js` 的 `buildQuery` 将规则标签生成为 hashtag 形式（`#a #b`），多 hashtag 空格分隔是 **OR 语义**（已在 yt.ispeco.com:8099 实测：`#CVE #dev` 返回 24 条 = 15 + 9 并集），精确的 AND/NOT 过滤依赖本地 `filterTasks`。

实测发现 YouTrack 查询语法支持服务端精确组合：

- `tag: {a} AND tag: {b}`：显式 AND（实测 `tag: {CVE} AND tag: {dev}` 返回 0，因无交集任务；`tag: {liuxinfc-ready} AND tag: {liuxinfc-explorer}` 返回 6，正确交集）
- `tag: -{c}`：排除标签（实测 `tag: -{liuxinfc-explored}` 返回 50 条且结果均不含该标签；与 `tag: -c` 等价）
- `tag: {-c}`（负号在花括号内）报 HTTP 400，禁止
- `tag: -c` / `tag: -{c}` 引用的标签必须存在，否则 HTTP 400（与现状 hashtag 行为一致）
- 小写 `and` 与大写 `AND` 均有效；花括号 `tag: {x}` 与无花括号 `tag: x` 均有效

## 目标

将 YouTrack 来源的查询下沉为服务端精确 AND/NOT，每轮不再拉取 OR 超集；本地 `filterTasks` 保留作为兜底。

非目标：wiki 来源不改、sources.js 注册表不改、不加配置开关、不新增抽象、不加"标签存在性"预校验。

## 设计

### 1. `buildQuery(rule)` 输出变化（src/youTrack.js）

```
现状：  #liuxinfc-ready #liuxinfc-explorer assignee: me
改造后：tag: {liuxinfc-ready} AND tag: {liuxinfc-explorer} AND tag: -{liuxinfc-explored} AND assignee: me
```

规则：

- 每个 `labels[i]` → `tag: {label}`，多个用 ` AND ` 连接
- 每个 `notLabels[i]` → 追加 ` AND tag: -{label}`；notLabels 为空/未配置则不生成该段
- `assignee` → 追加 ` AND assignee: me` 或 ` AND assignee: {用户名}`（从空格连接改为 AND 连接，避免 OR 语义下把"所有指派给我的任务"并集进来）
- 负号写在花括号外（`tag: -{x}`），禁止 `tag: {-x}`

### 2. 本地过滤保留

`filterTasks` 原样保留：youtrack 服务端精确后退化为防御层（防实例语法差异、防标签语义变化）；wiki 来源（CQL `label in (...)` 粗查）继续依赖它做精确过滤。

数据流不变：`fetchTasks` → `filterTasks` → 逐任务跑 pi。

### 3. 测试（test/youTrack.test.js）

- 更新 `buildQuery` 现有断言（hashtag 格式 → `tag: {x} AND ...` 格式）
- 新增用例：空 notLabels 不生成排除段、多 labels、多 notLabels、assignee me / 具体用户名、fetchTasks 的 query 参数
- filter.test.js 不变

### 4. README 更新

来源表格中 YouTrack 查询描述从"多标签是 OR 语义粗查，AND 精确匹配由本地 filterTasks 兜底"改为"服务端 `tag: {x} AND ... AND tag: -{x}` 精确 AND/NOT，本地 filterTasks 兜底"。

### 5. 冒烟验证

改完后用真实实例（yt.ispeco.com:8099）跑现有 config 规则（labels: liuxinfc-ready/explorer，notLabels: liuxinfc-explored，assignee: me），确认：

- 查询返回 1 条（CS-5514），而非改造前的 6 条
- 本地过滤后仍为 1 条

## 已知边界

- `tag: -{x}` 引用的标签必须存在（400 报错，错误消息已指向配置检查）
- 含空格标签名的负向组合（如 `tag: -{alpha 10.1}`）未经实测，冒烟验证时顺带验证
