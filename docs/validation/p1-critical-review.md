# P1 关键独立复审记录

范围：P1-B readiness N1；按用户要求 GPT6.1-SOL high 串行独立审查，审查者未参与对应实现。复用 v1.3 相关完整章节、既有报告与失败实验；本记录不授权或宣布 B/live 通过。保留 [P1 验证记录](p1-report.md) 的历史结果。

## A2：终态压力、EOF 与恢复

审查基点 `f709381b54178c365dab7d252b0a9b1678087b1e`；补丁基点 `f66d756b60d80fa7c69170c57e4ba2918b6b2fae`（中间仅 README/readiness 文档变化）。三文件补丁 diff SHA256：`d1e4b210fb38db272d46a926ffe7f444726b7bc32ba59b8d2d11e9a6cbb37520`。

| 问题 / 条件 | 独立复现与闭环 | 状态 |
|---|---|---|
| 原 Important #4：满 spool 时 terminal journal 被回滚 | 独立重开磁盘、ACK 腾出容量后 cursor 1001 唯一终态、一次 handoff；再次重开无重复 | CLOSED |
| 新 Important：Core receive 延迟，已接收 completion 后 native EOF | 旧代码 journal/spool 均 0；新增回归 RED；补丁同步校验并 journal，独立同场景 journal 1/spool 1，EOF 后效应 0 | CLOSED |
| 新 Important：64 个已发布但失败 handoff 占满恢复窗口 | 旧代码第 65 条 journal 永不发布；新增回归 RED；补丁分开未发布与 handoff 窗口并轮转，独立复现 publication 1/new hook 1，旧失败仍可重试 | CLOSED |

涉及实现：`packages/execution/src/drivers/codex-app-server.ts`、`apps/runner/src/processes.ts`；回归：`tests/recovery/runner-spool.test.ts`。同步 journal 不等待 Core RPC；只保留完整绑定、原生 thread/turn/status，不把原生完成当 OS 停写或 Task 成功。

独立补丁边界实验：5 类错绑定/非法 terminal 均零 journal、关闭传输、零效应；已消费 Core 批准延迟返回跨 EOF 拒绝；注入 publication receipt 失败时 spool 同事务回滚、journal 保留，重试恰有一条 publication/receipt；旧失败 handoff_done 保持 0 并重试。Core 丢 ACK 实验独立证明 cursor/event 先提交、重放不重复、4 个远程 IO 边界没有 SQLite 事务，slotHeld 仍 true。

| 验证来源 | 实际结果 |
|---|---|
| 独立审查者 / Node 24.19.0 / Linux x64 / synthetic | 原压力恢复、Core 丢 ACK、两个失败复现的补丁重跑、直接边界实验均 exit 0；指定三个测试文件 55/55 |
| 根代理自验 / 同补丁 / Linux x64 | 新增两项 RED→GREEN；全套 43 文件/527 项、typecheck、build、diff 检查 exit 0 |

上述证据是逻辑/协议/SQLite 的合成证明，不是 live GATE07/08/19。任意外部效应没有 exactly-once 保证；hook 成功后 receipt 未提交的崩溃仍可能重试 hook。审查原始失败/补丁实验与 SHA256 清单保留在工作区 `an-p1-work/reviews/a2-closure`，发布仓库中的两个回归可由 `npm test -- tests/recovery/runner-spool.test.ts` 复验。

## A3：完整现有实现与磁盘准备授权

独立审查基点 `e4d11e80a0e0b11dae98d1e7962c3a83ec513a72`；完整覆盖原 30 文件与 Node bootstrap、installed Core、停写/固定 workspace 捕获的必要接线。相关 v1.3 文档没有变化。旧 helper #2 过期授权仍可 inspect/stop owned、#3 shutdown→worker 退役→物理 close 保持源码关闭；**旧 #1 仅不同真实 kernel boot UUID 可恢复，同启动内崩溃保持 UNKNOWN，仍是 B3 能力阻塞**。

新 Important I-A3-01：大型哈希期间授权过期，或 expiresAt 缺失/非数值，旧磁盘脚本仍 mkdir/convert/resize/rename。独立控制流实验以私有临时授权、合成源摘要和记录转换器桩复现；未执行真实 qemu、镜像或大磁盘。修复在每个副作用前重读同一受保护授权内容、权限、路径与期限，并为 converter 传入不超过剩余期限的 timeout/SIGKILL；不删除中断 staging。

首补丁复验又发现两次读取时钟可能返回 timeout:0（无超时），保留该失败历史。新增第 9 个 RED 回归后改成单次计算 remaining 并要求安全正整数；最终三文件补丁 SHA256 `baee4a94a5a466fb2431ebb703b513915a93373016a36827c393ad04ff809623`，脚本 SHA256 `d5115b10756ace61880e626b49bb4e0236670ad189801862750c066ed640021e`。I-A3-01 **独立 CLOSED**。

| 验证来源 | 实际结果 |
|---|---|
| 独立审查者 / Linux x64 / synthetic | 原 A3 四文件 32/32、接线两文件 3/3；实际小 workspace 捕获与 UNKNOWN/子写者形状阻塞实验 exit 0 |
| 同审查者对最终补丁 | 独立 9 项回归、12 个额外边界（含同大小授权替换、convert 中权限变化、resize 中撤权）exit 0；旧四种非法/过期授权无 staging 或 converter 调用，中断阻止后续作用/发布并保留 staging |
| 根代理自验 | 第 9 项 RED→GREEN；最终全套 44 文件/536 项、typecheck、build、脚本语法、diff exit 0 |

回归入口 `npm test -- tests/contract/disk-preparation.test.ts`；harness 仅以合成 source pin 和小输出 size 代替真实镜像/磁盘，converter 是桩，实际 protected file/path 和脚本控制流被执行。它不证明真实 qemu 超时/磁盘转换成功。独立原报告、两轮失败与最终复验保留于工作区 `an-p1-work/reviews/a3-closure`。

无确认未关闭的新 Critical/Important。另一个 **未证实平台条件** 保留：guest 自主关机后，helper inspect 的 stopped 与其 machine/持久 running 记录退休是否一致。须在获准 ARM64 Mac 用合成 guest 实测自主关机→inspect→确切代际 stop→再 start；不能仅凭 Linux 源码判断通过或默默放行 UNKNOWN。vsock、真实 cgroup/BPF 正负例、子进程停写和完整恢复仍 NOT_RUN。

## A5

原生 Critical 修复的独立复审尚待串行完成。固定原生 canary 不冒充完整独立闭环。

## 实际环境与剩余边界

用户 Mac/VM/CLI、账号/凭据、模型、实际 Task A/B 和人工 Mac 检查全部 NOT_RUN/BLOCKED。Mac mini M4、personal-codex-p1 仍 UNCONFIRMED。同主机启动内 helper 崩溃恢复、细粒度网关、每 Bot 文件配额、verifier 硬物理内存上限与受监督首装缺口维持原报告状态。此次未启动 N2、VM、登录或费用操作。
