# P1 验证记录

设计基线：AN 2.0 v1.3；本阶段任务书及门禁读取版本 `5aa3e5a547985342a147e36f0904912ee6735765`。本记录按提交追加，保留 [P0 记录](p0-report.md) 的既有结果。P1-A 无账号实现已获授权；P1-B 真实设备、VM、登录、账户和模型操作未获授权。

## A1：异步 Core 与可信停写证据

2026-10-13 UTC，本提交实现并独立审查：异步预检/发送不占用 SQLite 事务；Query-first Outbox 保留命令身份；发出前复验撤权、取消、代际、租约和 epoch；v1→v2 迁移持久保存执行绑定。Runner 接受回执与可写进程树停止是不同事实。真实 Run 拒绝旧 fake 退出/存活报告，只有受信 Node 观察经完整绑定和新鲜度校验后才可释放槽位；退出码 0 只推进 VERIFYING。

| requirement_id / stage / evidence_kind | Runtime / 平台 | 实际验证与结果 |
|---|---|---|
| A1；GATE07/08/13/19 协议子集 / P1-A / scripted | Node 24.19.0 / Linux x64 | 新增两个文件 42 项通过；涵盖丢 ACK、撤权、迟到回执、父进程死但子进程仍可写、错误绑定和恢复。不是 live 门禁通过。 |
| P0 回归 + A1 / P1-A / synthetic | Node 24.19.0 / Linux x64 | 根工作区 `npm run typecheck`、`npm test`（21 文件 / 308 项）、`npm run build`、`git diff --check` 均退出 0，时间 2026-10-13 00:00 UTC。构建为未提交工作区验证，不冒充已发布包。 |
| A1 独立差异审查 / P1-A / code-review | 本提交代码 | 未发现 A1 独立 Critical/Important 阻塞。发现 A3 Node 观察尚未提供所需退出状态，须在 A3 集成时修复并验证实际适配器形状。 |

候选识别：上述结果对应本提交中的 A1 源码与测试；提交 SHA 由 Git 历史给出。远端同 SHA 的 macOS CI、包摘要及产物在完成后另行记录，不以 Linux 构建替代。

## 尚未完成

- A2–A6 正在各独立工作树实现/集成，未在此切片宣称完成。
- A1 恢复后的真实 Run 保持 LOST，直到受信停写观察；没有新增基于不可信 alive 回执的恢复放行。
- 标准 macOS CI 的工具链、实际 Electron 包与未来 VM/CLI live 验证分别记录。
- Mac mini M4 与 `personal-codex-p1` 仅为 UNCONFIRMED 候选；设备操作、登录、账单来源、模型/数据/调用限制须有具名准入。无真实凭据、设备码或个人接入信息进入本仓库。
- P1-B、真实 Task A/B、真实隔离/审批/恢复门禁与人工 Mac 项均未执行；本记录不宣称 P1 完成。
