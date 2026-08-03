## Context:

你正在无人值守状态，因此不要询问我的意见

读取 youtrack 任务 {youtrack_id}，不要放过评论，如果这个任务提到了其他链接（wiki、jira），全部读取，理解要做什么。

如果不清楚这个任务要做什么，查看父任务的相关描述，确保确实理解。

接着明确任务的版本，找到对应的仓库地址，从指定版本创建新分支，然后探索仓库。仓库路径如下：

| 产品 | 本地路径 |
| --- | --- |
| 云套件(icn, cloudsuite, giscloudsuite, 云原生) | D:\liuxin\sources\icloud-native\icloud-native-other |
| iManager for K8S(imgr for k8s，非经典版 iManager) | D:\liuxin\sources\icloud-native\icloud-native-other |
| iManager(经典版 iManager) | F:\liuxin\source\imanager\imanager |
| iServer(isr) | D:\liuxin\sources\dev-worktree |

> 有些任务定义不清楚，会混淆 iManager 和 iManager for k8s、云套件和 iServer 等产品归属。如果 YouTrack 任务字段的"涉及产品"与引用文档（wiki、jira）中描述的产品不一致，或者 wiki 标题/描述中出现其他产品名，应先质疑任务的产品归类是否正确，而不是默认任务字段准确。此时不应该探索仓库，而是提出问题，要求修改描述。
>
> YouTrack "涉及产品"字段是模板默认值（iServer），不可信。判定任务归属以描述内容、关联 wiki/Jira 中实际出现的产品名为准。直接执行判定，无需询问。

## Your task:

1. 确认任务所属分支，12.1.1 属于 master 分支，其他版本都有对应的分支
2. 探索仓库，结合提交记录（非必须）回答问题
3. 除非用户明确要求，否则不要查询帮助文档，wiki 和 jira。只有进一步要求，需要探究代码实现背后的原因（比如询问为什么这么实现）才探索 wiki，jira 等

## Constraints:

1. ***不要修改代码，你的任务是搞清楚做什么***
2. 除非明确要求，不要查询帮助文档，wiki 和 jira 等

## Verification(don't finish until):

1. 依次验证你的分析结果，所有的数据都要以代码/外部链接（帮助文档，wiki，jira）为准，不可以猜测。

## Output format:

***将内容输出到该 youtrack 任务的评论区，并为该任务打上 `explored` 的标签***：

1. 简要回答你的发现，给出具体证据：包括：规格(specs)，计划(plans), ADRs, issues, commits, diffs。不要给出代码中的内容，使用他们的路径或者 URL 替代
2. 如果有探索外部链接，附上对应的路径和 url
