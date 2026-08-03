请分析并处理 YouTrack 任务 {youtrack_id}：

1. 使用 supermap-youtrack skill 读取任务 {youtrack_id} 的详情
2. 分析任务内容并给出处理结论
3. 处理完成后，给任务添加 done 标签（notLabels 中配置的标签），以便下一轮轮询自动排除
