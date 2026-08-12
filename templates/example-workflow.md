# 示例模板：任务处理中调用已保存的工作流

> 本文件演示如何在 taskloop 任务模板中使用 workflow 工具调用已保存的工作流。
> 用法：在 config.json 的 rule 中把 promptTemplate 指向本文件，或把下方"模板体"复制进 analyze.md。

## 模板体

{{include:parts/example-output.md}}

请分析并处理 YouTrack 任务 {youtrack_id}：

1. 使用 supermap-youtrack skill 读取任务 {youtrack_id} 的详情
2. 使用 workflow 工具运行已保存的工作流 demo_workflow（演示工作流流程，不做实际操作），验证工作流可正常调用
3. 分析任务内容并给出处理结论
4. 处理完成后，给任务添加 done 标签（notLabels 中配置的标签），以便下一轮轮询自动排除

## 使用说明

- **第 2 步依赖已保存的工作流**：`~/.pi/workflows/saved/demo_workflow.json`（用户级保存，任何 cwd 都能按名加载）。
- **触发机制**：提示词中的 "workflow" 关键词会授权（arm）workflow 工具，但模型可能选择不用；必须显式写明"使用 workflow 工具运行已保存的工作流 <名称>"才会稳定触发。
- **换工作流**：把 `demo_workflow` 换成你自己的 saved workflow 名称即可。
- **传参数**：如需传参，工作流脚本内通过全局 `args` 读取；工具调用时用 args 字段传入（本演示工作流不接收参数）。
- **注意**：模板中嵌入的真实任务处理步骤（第 1、3、4 步）请按 analyze.md 的约定保留，工作流步骤只是附加环节。
- **片段复用（include）**：模板体首行是一个 include 指令，渲染时会被替换为 `templates/parts/example-output.md` 的内容（本演示片段与第 4 步内容呼应，实际使用时不必重复）。语法与要点：
  - 写法：双花括号包裹 `include:相对路径`（路径相对**当前模板文件所在目录**解析）；片段内也可以继续 include，相对片段自身所在目录
  - 片段内可以使用任务级占位符（如任务 id、排除标签），先展开 include 再替换占位符
  - 循环引用、片段文件不存在会在渲染时报错，该任务被跳过并记日志
  - 公共内容（如产品路径表、统一回复格式）抽到 `templates/parts/` 下由多个模板 include，修改一处全部生效，避免各模板复制粘贴后不同步
