# 实施方案

沿用 Router JSONB 直接能力、快照摘要、Operation 调度及清理占用。可选字段省略时保持旧快照摘要兼容。禁止同时授权同名本地与 MCP 工具。

Router 将冻结的 Bash 授权传给共享 Sandbox。Pi 通过原生 Bash 定义及 BashOperations 使用 bwrap，保留原工具 Schema、输出处理和工具执行校验。运行时只挂载专用只读根、Task 工作区和私有临时目录。Bash 担任 PID 命名空间 PID 1，使用既有取消信号和绝对执行截止。

授权管理沿用 Key 配置，运行状态和限长结果沿用 Operation 轨迹。固定目录通过一次性部署脚本从已安装解释器及依赖准备，Tasks 按需创建工作区。

迁移 0036 在原有工具历史约束中加入带 Provider 的内部 Bash 记录，并继续接受既有 MCP 记录。
