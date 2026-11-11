# Spec Delta

## Purpose

定义配置的位置、结构与编辑方式，使配置既能在运行时被安全地校验，又能通过表单编辑而不丢失用户手写的内容。

## ADDED Requirements

### Requirement: 配置位于固定目录

系统 SHALL 默认从用户主目录下的 `.taskloop/config.json` 读取配置，并允许通过命令行参数指定其他配置文件路径。

#### Scenario: 不带参数启动

- **WHEN** 用户启动时未指定配置文件
- **THEN** 系统读取 `~/.taskloop/config.json`

#### Scenario: 指定配置文件

- **WHEN** 用户启动时传入配置文件的路径
- **THEN** 系统读取该路径，`MUST NOT` 再读取默认位置

#### Scenario: 默认配置文件不存在

- **WHEN** 用户启动且默认位置的配置文件不存在
- **THEN** 系统生成一份包含一条示例规则的默认配置，并继续启动

### Requirement: 配置结构拍平且无 agent 概念

配置 SHALL 在顶层直接声明模型与推理强度，`MUST NOT` 包含 `agent` 字段或按 agent 命名的嵌套配置块。

#### Scenario: 完整配置

- **WHEN** 配置文件包含轮询间隔、模型、推理强度、工作目录、环境变量文件与规则数组
- **THEN** 系统加载全部字段并用于循环执行

#### Scenario: 出现 agent 字段

- **WHEN** 配置文件中存在 `agent` 字段或按 agent 命名的配置块
- **THEN** 系统以明确的中文错误消息拒绝该配置

### Requirement: 配置校验在执行前拦截错误

系统 SHALL 在启动循环和保存配置两处使用同一套校验，并返回中文错误消息指明出错字段。

#### Scenario: 轮询间隔非法

- **WHEN** `intervalSeconds` 不是正整数
- **THEN** 校验失败并返回指明该字段的错误消息

#### Scenario: 规则来源非法

- **WHEN** 某条规则的 `source` 不在注册表支持的来源中
- **THEN** 校验失败并返回列出合法来源的错误消息

#### Scenario: 表单保存非法值

- **WHEN** 用户在表单中填入无法通过校验的值并保存
- **THEN** 系统拒绝写入文件，并在页面显示校验错误

### Requirement: 表单编辑保留原始结构

配置表单 SHALL 基于配置文件的原始内容渲染与保存，`MUST NOT` 基于校验后的解析结果渲染。

#### Scenario: 相对路径不被固化

- **WHEN** 用户在配置中把模板路径写为相对路径，通过表单保存后再次读取
- **THEN** 该路径仍为相对路径，未被改写为绝对路径

#### Scenario: 未知字段被保留

- **WHEN** 配置文件中存在表单未展示的字段，用户通过表单保存其他改动
- **THEN** 该未知字段原样保留在文件中

#### Scenario: 合法来源可选项

- **WHEN** 用户在表单中编辑某条规则的来源
- **THEN** 可选项来自来源注册表，用户无法输入注册表之外的来源

### Requirement: 工作目录字段

配置 SHALL 包含 `workdir` 字段，用于指定 agent 执行时的工作目录，并支持 `~` 展开与相对配置文件的相对路径。

#### Scenario: 缺省工作目录

- **WHEN** 配置未声明 `workdir`
- **THEN** 系统使用 `~/.taskloop/workdir` 作为工作目录

#### Scenario: 目录不存在

- **WHEN** 配置声明的 `workdir` 在磁盘上不存在
- **THEN** 系统自动创建该目录

#### Scenario: 目录创建失败

- **WHEN** 系统无法创建 `workdir`
- **THEN** 启动失败并返回指明路径的中文错误消息

### Requirement: 保存后提示生效时机

系统 SHALL 在配置保存成功后提示需要重启循环才会生效。

#### Scenario: 循环运行中保存配置

- **WHEN** 用户在循环运行期间保存配置
- **THEN** 页面提示已保存且需重启运行后生效，当前循环继续使用旧配置
