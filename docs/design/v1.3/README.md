# AN 2.0 设计基线 v1.3

**执行后端更新：2026-10-16，用户已选择 Podman。** 先读 [Podman 决策](../decisions/2026-10-16-podman-runtime.md)。该 ADR 在本地执行、安装与前置条件上优先于本目录旧正文的冲突表述；它不表示 Podman 代码已实现或验收通过。

v1.3 产品基线原发布于 2026-10-12；旧聊天附件 v1.0/v1.1/v1.2 不再是实施依据。本文为阅读索引，不代替设计全文。已读相同 blob 的记录可复用，新的 ADR、变更章节及所涉代码必须重新核对。

## 阅读顺序

1. [Podman 决策与迁移边界](../decisions/2026-10-16-podman-runtime.md)：最新选型及覆盖范围。
2. [super bot 交接](../../handoff/super-bot.md)：读取要求与历史任务背景；阶段状态以最新主线程授权与仓库报告为准。
3. [产品与技术详细设计](technical-design.md)：领域、执行、资源、资产、Connection 和验收。
4. [界面与交互详细设计](interaction-design.md)：页面、状态、Mac 交互及失败路径。
5. 根目录 [AGENTS.md](../../../AGENTS.md)、[README.md](../../../README.md) 以及 [P1 验证记录](../../validation/p1-report.md)：当前工程、已验证候选及未完成项。

任务委派携带实际 Git revision、文件路径和所需章节，不依赖另一个聊天的附件。旧 Ubuntu/helper runbook 不再是默认首装指令；新 Podman 适配需要独立实现与证据，不重做整个 P0。

## 已确认的产品决定

| 范围 | 当前决定 |
|---|---|
| 产品 | Electron 桌面 App，Mac-only V1；未来再扩展其他桌面客户端 |
| 一级入口 | 任务指挥台、Bots、成长 |
| 主体 | 长期 Bot；Orchestrator 也是 Bot |
| 生命周期 | 专属逻辑环境跟 Bot；任务结束不销毁工作数据，进程/容器可受控重启 |
| 本机后端 | Podman CLI + Podman Machine；共享固定版本 OCI 镜像，各 Bot 容器及持久数据独立 |
| 远程执行 | 后续接现成 Sandbox，复用任务/Runner 协议，不作为本次前置 |
| 配套服务 | Resource Server 管模板、环境目录和分发，不自动接管私有数据/调度 |
| 用户资产 | 知识、Skill、规约、经验本地优先；授权、版本和采用可追溯 |
| 连接选择 | 用户决定账号/计费来源；Bot 默认连接可受控覆盖 |
| 认证解析 | ConnectionResolver 确定性检查实际认证、数据和兼容性 |
| 默认故障策略 | 不自动订阅→API，不绕过网关，不借用其他账号 |
| 成长 | 有来源、可撤回、可评测；RRSI/决策模型不改权限或付款来源 |

不再把自研 Swift VM/EFI、Ubuntu 离线 chroot 制备、外部 ARM64 制备机作为首发必需。Podman 负责机器/容器机制，AN 负责 Bot 的持续工作、交互、授权和成果。具体资源与性能以实测为准；不要默认另装 Podman Desktop、Docker Desktop、Lima 或再叠一套自研沙箱。

## v1.3 原有修订继续保留

- Resource Server 与公共制品分发；本地权威 Core 不变。
- AssetRegistry/ContextAssembler 的归属、装载、撤回与处理政策。
- ConnectionRegistry、Grant、Resolver、RuntimeAuthAdapter 及凭据生命周期。
- 认证方式、计费来源、请求路径分离；启动前核对实际生效方式。
- CLI 安装/再分发/认证路径分别核验，不能由官方二进制可运行推导任意集成获准。
- 原验收 ID 保留；与旧 VM 实现相关的证明重新映射，不删除失败、不自动改 PASS。

## 当前实施边界

仓库已经包含 P0/P1-A 代码和报告；早期“仅文档、尚无工程”的说明属于历史。本次执行决策仅更新文档入口，不改业务代码、依赖、CI、许可证或测试记录。

super bot 下次接手先提交针对现有 Provider/Runner 的小范围迁移映射，按已有获准开发范围推进；真机安装、机器资源、登录、费用和发布仍需对应授权。不要重复确认已决定的 Podman 选型，也不要要求用户转交仓库已有材料。
