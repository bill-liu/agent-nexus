# Agent Nexus 设计文档

当前生效依据：**v1.3 产品基线 + 2026-10-16 Podman 执行后端决策**。用户已选择 Podman，避免重复建设；不是已经完成 Podman 迁移。

- **先读：[Podman 执行后端决策](decisions/2026-10-16-podman-runtime.md)。** 在本地执行、首次安装与相关前置条件上，它取代旧自研 VM/Ubuntu 制备路线和此前原生软件包路线的冲突建议。
- [v1.3 阅读索引与决策清单](v1.3/README.md)
- [产品与技术详细设计](v1.3/technical-design.md)
- [界面与交互详细设计](v1.3/interaction-design.md)
- [super bot 交接与下一步](../handoff/super-bot.md)

仍保留 Electron/Mac-only V1、长期 Bot、单一 Core、资源分发服务、私有资产、显式 Connection 和验收要求。新路线采用 Podman CLI/Machine、共享 OCI 镜像、每 Bot 容器及持久工作数据，不要求 Podman Desktop，不再要求用户提供外部 ARM64 制备机。

旧聊天附件 v1.0/v1.1/v1.2 为历史。v1.3 两份正文与旧 P1/首装计划保留供对照；冲突之处先应用上述 ADR，不能直接执行旧安装配方。历史测试结果不删除，也不转记为 Podman 通过。安装、账号、费用和设备操作仍受对应授权约束；不要把决定写入文档当成产品已经可用。
