# 示例模板：任务处理中调用已保存的工作流

> 本文件演示如何在 taskloop 任务模板中使用 workflow 工具调用已保存的工作流。
> 用法：在 config.json 的 rule 中把 promptTemplate 指向本文件，或把下方"模板体"复制进 analyze.md。

## 模板体

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
