# Agent Nexus：协作与设计入口

## 先读当前设计

当前生效依据为 **AN 2.0 v1.3 产品基线 + 2026-10-16 Podman 执行后端决策**。先读取 [Podman ADR](docs/design/decisions/2026-10-16-podman-runtime.md)，再读 [交接文件](docs/handoff/super-bot.md)、[设计索引](docs/design/v1.3/README.md) 和两份 [技术](docs/design/v1.3/technical-design.md) / [交互](docs/design/v1.3/interaction-design.md) 全文。记录实际 Git revision；相同 blob 已读可复用，变化检查 diff 与相关上下文，不只转交摘要。

实施同时读取 [P0/P1 计划](docs/plans/p0-p1-implementation-plan.md)、[执行门禁](docs/plans/p0-p1-execution-gates.md)、[P1 任务书](docs/plans/p1-task-brief.md) 和 [P1-B 推进计划](docs/plans/p1b-readiness-plan.md)。它们的通用契约继续适用，但旧自研 VM/Ubuntu/外部 ARM64 制备路线与最新 ADR 冲突时，必须以 ADR 为准；不要照旧配方安装后再处理冲突。

## 用户已确认边界

- Electron 桌面 App，一期仅 Mac；不做 Web 主客户端/手机首发，不再要求 SwiftUI 主界面。
- 一级入口：任务指挥台、Bots、成长；Orchestrator 也是 Bot。
- Bot 是长期执行实体，逻辑工作环境随 Bot 保留；任务完成不销毁数据，不要求 CLI 永不退出。
- **默认本机采用 Podman CLI + Podman Machine + OCI 镜像和每 Bot 持久工作数据。** 一套选定引擎服务多个 Bot 容器；不要求 Podman Desktop，不默认一 Bot 一 VM。
- 不再扩展自研虚拟化/helper、离线制备链或另建类 Docker 软件包系统作为首发必需。复用已有 Core、Runner、审批、Connection、资产与验收；旧代码保留，不未经批准清理。
- 远程 Sandbox 为之后的独立后端；本地/远程统一工作协议，不虚构同等功能或相同二进制可跨平台运行。
- Resource Server 管环境目录、模板、版本和分发，不自动托管用户账号、私有数据或 Goal。优先复用现成 OCI Registry。
- 私有知识/Skill/规约/经验本地优先，版本化按授权装载；硬约束在真实执行点落实，后端不能提供时说明限制并阻塞必需该能力的任务。
- 用户选 Connection 和费用来源；不静默跨计费切换、不绕过网关、不借用其他 Bot 凭据。
- CLI 安装、再分发和认证许可分别核验；公共镜像不含秘密、OAuth、认证缓存或用户工作数据。
- 独立证据绑定当前候选与契约，Bot 自报完成不等于验收成功。

## 实施与并行协作

Podman 选型已获用户确认，不再要求重复选择。最新决定不是 Podman 已安装/迁移通过，也不是接入用户 Mac、下载镜像、分配资源、登录、花费、签名发布、修改许可证或清理数据的无限授权。实现范围按主线程已有明确授权推进，缺少前置仅阻塞相关真实操作。

P0/P1-A 已有代码和证据看 [P0 报告](docs/validation/p0-report.md) 与 [P1 报告](docs/validation/p1-report.md)。不要清空重做，也不要把旧测试数当成新后端通过。先给出小范围 Provider/Runner 迁移映射及正向闭环，继续原 Task A/B，避免再写一套总体平台。

Podman 的已有机器、默认连接、默认共享目录必须检测。不得自动停止他人机器/容器、覆盖全局默认连接、把引擎 socket 交给 Bot，或运行全局 prune/reset。长期空闲时只停止明确归属 AN 且可安全停止的资源；工作卷与敏感凭据分开处理，机器删除不等于安全备份。

并行提交先刷新 main 与相关 blob，保留其他执行者的代码、锁文件和验证历史；禁止强推覆盖。不要向用户索要仓库已有设计，不要求其在聊天之间中转。通过仓库与 Issue #1 交接，评论发布不等于接手者已读。

## 验证与安全

原 165 项及 GATE01–GATE20 是验收规格。结果按场景、阶段、fake/离线/真实/人工、Runtime、平台、Provider 与候选分开；新增 Podman 路径重新取证，不覆盖原失败历史。旧 VM 特定门禁要明确被取代还是仍需等效能力，不直接改成 PASS。

Runtime 审批回复精确原请求；未知/过期/错代际不能自动批准。容器运行状态不是某个 Run 的停止证明；子进程仍可写时不释放槽位。安装镜像不代表用户账号授权；不得为兼容性静默启用特权容器或关闭全部保护。

提交前检查 diff 与范围。不提交真实 Key、Token、设备码、认证缓存、私有接入信息、个人资料或秘密日志。本次 ADR 不修改业务代码/依赖/CI，不重写报告；无新证据不宣称功能、性能或安装体验通过。
