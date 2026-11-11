# Spec Delta

## Purpose

定义在宿主进程内通过 pi SDK 执行 agent 任务的行为契约，包括会话生命周期、执行事件采集、结果判定，以及如何继承物理机上已有的 pi 用户配置。

## ADDED Requirements

### Requirement: 进程内执行不派生子进程

系统 SHALL 在当前 Node.js 进程内创建 agent 会话执行任务，`MUST NOT` 通过 spawn 启动 `pi`、`claude` 或任何 agent 命令行程序。

#### Scenario: 执行一个任务

- **WHEN** 轮询循环选中一个候选任务并已渲染 prompt
- **THEN** 系统在当前进程内创建 agent 会话并提交 prompt，不产生新的 agent 子进程

#### Scenario: 未安装 pi 命令行

- **WHEN** 运行环境 PATH 中不存在 `pi` 可执行文件，但已安装 SDK 包
- **THEN** 任务仍能正常执行

### Requirement: 每个任务使用独立会话

系统 SHALL 为每个任务创建新的 agent 会话，并在执行结束后销毁该会话。

#### Scenario: 连续执行两个任务

- **WHEN** 同一轮内先后执行两个候选任务
- **THEN** 第二个任务不会看到第一个任务的对话内容

#### Scenario: 任务结束释放会话

- **WHEN** 一个任务的执行结束，无论成功或失败
- **THEN** 系统销毁该任务的会话并释放其占用的资源

### Requirement: 执行过程以事件形式上报

系统 SHALL 在任务执行过程中上报三类事件：系统事件、工具调用事件、agent 文本增量。

#### Scenario: agent 产生文本

- **WHEN** agent 生成回复文本
- **THEN** 系统上报包含文本增量的消息事件

#### Scenario: agent 调用工具

- **WHEN** agent 开始执行一个工具调用
- **THEN** 系统上报包含工具名和参数摘要的工具事件

#### Scenario: 文本增量合并推送

- **WHEN** agent 在短时间内产生大量文本增量
- **THEN** 系统合并后再推送，`MUST NOT` 为每个最小文本增量单独推送一次

### Requirement: 执行结果不使用退出码判定

系统 SHALL 依据会话结束状态与错误信息判定任务成功或失败，`MUST NOT` 依赖子进程退出码。

#### Scenario: 执行成功

- **WHEN** agent 会话正常结束且未产生错误
- **THEN** 系统将该任务记录为成功，并保存最后一条助手回复文本

#### Scenario: 执行失败

- **WHEN** 会话因模型错误、凭据无效或其他异常结束
- **THEN** 系统将该任务记录为失败，并保存错误原因文本

#### Scenario: 执行被中止

- **WHEN** 用户在任务执行期间请求停止循环
- **THEN** 系统将该任务记录为已中止，与其他失败原因区分

### Requirement: 继承物理机的 pi 用户配置

系统 SHALL 通过 SDK 的资源发现机制加载 agent 目录下的用户级配置，包括设置文件、凭据、全局指令、扩展、技能，以及设置文件中声明的包。

#### Scenario: 使用用户安装的扩展

- **WHEN** agent 目录的扩展目录中存在扩展文件
- **THEN** 该扩展在任务执行时被加载并生效

#### Scenario: 使用设置文件声明的包

- **WHEN** 设置文件的包列表中声明了本地路径或 git 包
- **THEN** 这些包提供的技能和扩展在任务执行时可用

#### Scenario: 使用已保存的模型凭据

- **WHEN** agent 目录存在已保存的模型凭据，且 `envFile` 未提供服务商标钥
- **THEN** 系统沿用已保存凭据完成模型调用

### Requirement: 显式加载命令行内置扩展

系统 SHALL 显式加载命令行的内置扩展（代码执行、工具搜索、MCP），因为 SDK 默认不加载它们。

#### Scenario: 设置要求启用代码执行

- **WHEN** 设置文件将代码执行工具加入默认工具集
- **THEN** 系统加载对应的内置扩展，使该工具在任务执行时可用

#### Scenario: 配置了 MCP 服务器

- **WHEN** agent 目录或工作目录存在 MCP 服务器配置文件
- **THEN** 系统加载 MCP 扩展并连接配置中的服务器

### Requirement: 不自动信任项目级资源

系统 MUST NOT 自动授予工作目录的项目信任；在无人值守场景下，未信任项目的受保护资源应被跳过而不是等待交互确认。

#### Scenario: 工作目录含未信任的项目扩展

- **WHEN** `workdir` 指向的目录包含项目级扩展且该目录未被信任
- **THEN** 系统跳过这些项目级资源，任务仍可执行，且不阻塞等待用户确认

#### Scenario: 工作目录含上下文文件

- **WHEN** `workdir` 目录存在项目指令文件（如 `AGENTS.md`）
- **THEN** 系统加载该指令文件，因为上下文文件的加载不依赖项目信任
