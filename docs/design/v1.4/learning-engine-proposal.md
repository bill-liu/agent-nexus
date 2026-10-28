# AN v1.4 提案：Bot 学习闭环与共享记忆架构

> 状态：设计提案（非已批准实施基线）｜2026-10-29
> 依赖：v1.3 设计、Podman ADR、P1-B 真实联调。本文不覆盖既有 ADR、验收和授权边界。

## 1. 目标与非目标
借鉴 Beacon 的“会话捕获→评估→经验提炼→审核→跨代理复用”，为 AN 长期 Bot 网络提供有证据、可撤回的经验。覆盖 Bot、项目、Goal 与跨 Bot 协作策略。不是模型权重训练，也不承诺无监督自动改进。

不在当前 P1-B 引入 Jev 云服务、向量数据库、额外常驻进程或自动改写全局规则。不得改变 Connection/Grant/Resolver、计费来源、权限、独立验收门禁。

## 2. 与既有架构关系
- 本地 AN Core/SQLite 为权威状态；Resource Server 不保存私有经验或执行轨迹。
- Podman Sandbox 内 Runner/CLI 发出可追溯事件；本地 Core 收集、去重、脱敏并关联 Bot/Task/Goal。
- AssetRegistry 管理经验资产版本、归属、采用、撤回；ContextAssembler 负责检索后的受控注入。
- Learning Engine 是 Core 内异步模块，不另建必须常驻的服务。后续远程 Sandbox 复用相同事件协议。
- 用户现有 Markdown/Obsidian 可作为显式授权的导入/导出源，不默认全盘扫描或跨项目共享。

## 3. 最小数据契约
ExecutionTrace: trace_id, bot_id, task_id, goal_id?, runner_id, sandbox_id, event_seq, event_type, occurred_at, payload_ref, sensitivity, redaction_version, integrity_hash。
OutcomeEvidence: evidence_id, trace_id, verifier_kind, verifier_version, environment_fingerprint, artifact_hashes, verdict, timestamp。
Experience: experience_id, scope(bot/project/goal/network), title, conditions, steps, contraindications, source_trace_ids, evidence_ids, author, version, status, created_at, expires_at?。
ExperienceUse: use_id, experience_id, task_id, retrieval_reason, injected_at, applied_signal, outcome_evidence_ids, feedback。
ApprovalAudit: actor, action, asset_version, decision, reason, timestamp。

状态：Candidate → Verified → Active；任何状态可进入 Rejected/Deprecated，撤回立即阻止后续注入。Verified 只代表证据核验通过，不代表自动批准 Active。所有晋升需可追溯授权；高风险或跨范围共享必须人工审批。

## 4. 端到端行为
1. Runner 事件以序号、幂等键持久入库；缺失字段标记 incomplete，不虚构“完整会话”。
2. 任务结束或失败后，异步筛选高信号轨迹；P1/P2 可用规则和已有本地模型，Jev 仅作可选未来适配器。
3. 代理提炼候选经验，必须引用具体 trace/evidence；禁止把未经证实的猜测当作操作规程。
4. 独立验证器或受控复现提供证据；人批准激活。不得让撰写经验的 Bot 自行宣布验收通过。
5. ContextAssembler 在规划、执行前及错误恢复节点按 scope、环境、版本、相关性和 token 预算检索；注入标记来源及不可信边界，不允许经验提升指令优先级。
6. 记录是否真正采用及任务结果；对照相似任务评估收益，不能仅凭检索次数宣称成长。
7. 环境/工具版本变化、验证失败或用户撤回时降级、过期或重新验证。

## 5. 安全与资源
- 采集前按最小必要原则过滤 secret、token、个人数据和命令输出；敏感原文不进入普通 Markdown、GitHub Issue 或遥测。
- 跨 Bot/项目共享默认关闭，需明确 scope 和 Grant；不能借记忆绕过 Sandbox/Connection 审批。
- 不自动执行经验里的命令或脚本；SKILL.md 是受控内容资产，不是授权。
- 保留容量上限、清理策略、导出与撤回机制；原始轨迹和摘要分级保留。
- 离线优先，远程评分必须单独获得数据发送授权；成本、失败和降级可观测。

## 6. 分期（沿用仓库既定 P0–P5 路线）
- P1-B：不改范围；仅确保 Runner 事件协议将来可关联 trace_id / evidence，不能阻塞真实 Podman/CLI 联调。
- P2：统一事件捕获、去重、脱敏、可追溯存储；完成本地检索 API 的最小契约。
- P3：Orchestrator 使用已批准经验作为参考，记录协作策略采用与效果，不自动改变授权。
- P4：候选提炼、验证、人工审核、Markdown/SKILL.md 导出、主动检索、撤回与成长页面。
- P5：评估器适配、A/B 效果测量、过期重验、受控策略优化。

## 7. 验收门禁（新增，不覆盖原 165 项）
L01 事件重放和乱序输入不产生重复事实。
L02 丢失会话内容时显式 incomplete。
L03 密钥和隐私样例不会进入 Experience 或导出文件。
L04 无 Grant 的跨 Bot/项目经验不能被检索或注入。
L05 Candidate/Rejected/Deprecated 不进入生产上下文。
L06 Active 撤回后下一次检索立即不可见。
L07 经验提炼必须附来源与独立证据，缺失时不得 Verified。
L08 注入内容不能修改系统权限、Connection、计费与验收标准。
L09 ContextAssembler 的 token 预算与版本匹配可复现。
L10 记录检索、实际采用和结果三种不同指标。
L11 无评分服务、无网络时正常任务仍可运行。
L12 真实任务至少展示一次“经验复用有效”和一次“过时经验拒绝”，记录可复核证据。

## 8. 实施任务书（供 super bot）
先读取 main 最新 revision、v1.3 README、Podman ADR、AGENTS.md、P1-B 计划与验收报告；输出冲突矩阵和事件契约增量，不直接大规模改造。按最小纵向切片拆 Issue：A 事件与证据契约；B SQLite/资产版本；C 检索与权限；D 提炼/验证/审核；E 成长 UI 与效果评测。每项注明依赖、测试、回滚与真实/合成证据等级。先提交设计审查，未经单独授权不扩大 P1-B 范围、不改用户环境、不引入云服务。

## 9. 外部参考
Beacon: https://github.com/Asymptote-Labs/agent-beacon
Beacon memory: https://docs.beacon.sh/concepts/cross-harness-memory
本提案借鉴架构理念，不表示 AN 已集成 Beacon 或 Jev。
