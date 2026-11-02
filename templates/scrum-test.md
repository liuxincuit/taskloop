请处理 Scrum 任务 {scrum_id}：

任务地址：{scrum_url}

1. 使用 supermap-scrum skill 在该任务的评论区回复一句 `test`
2. 使用 supermap-scrum skill 给该任务打上 `{not_labels}` 标签

打上 `{not_labels}` 后，下一轮轮询会因 `notLabels` 配置自动排除该任务，不会重复触发。
