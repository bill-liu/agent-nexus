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

## A5：原生固定验证边界与结构验收

独立审查绑定干净 `43b7e644e30e387b3c608d9ce29b4956db4d8cb5`；原 Critical（stdout 冒充观察）在当前固定原生路径 **CLOSED**，原 Important（缺 tests/CHANGELOG 仍接受）在 v2 结构验收范围 **CLOSED**。没有新增已执行复现的 Critical/Important；这份结论不覆盖任意不可信 JavaScript 的通用安全，也不解除 B 门禁。

旧 `IsolatedVerifierExecutor`、`NodeVerificationService` 和 probe 前置 fail-closed，不再启动旧候选观察路径。新 Node/esbuild 只转换文本；JSC 没有注册 JS→native callbacks/classes，宿主入口求值前删除并封闭。实际函数返回、数组、引用 identity、错误 prototype、captured freeze 由 native C API 观察，Foundation 生成报告。候选自写 JSON/toJSON 不负责可信输出。当前 Main/Core 绑定、helper pin、immutable manifest、Core epoch/current candidate 与 WeakMap issuer/reportDigest 接线经源码及现有测试核对。

| 独立证据 | 实际结果 |
|---|---|
| Linux Node 24.19.0 现有 5 文件 | macos-evidence、isolated-evidence、verifier-review、evidence contract + evidence integration：44/44、exit 0；包含旧服务零效应、缺所需文件/B unchanged tests/替换 CHANGELOG/缺 A binding、raw report/改报告拒绝、immutable SQLite 与 A→B |
| 同 SHA [原生 run38349497052/job115138396119](https://github.com/bill-liu/agent-nexus/actions/runs/38349497052/job/115138396119) | 审查者直接读取作业与日志，macOS15.7.9 arm64；15/15 既有固定原生/实际 supervisor 对照通过，不是根转述或 Linux 静态断言 |

独立日志 SHA256：测试 `236726fd61b309a39e71ef03ae025260cc8f027a611d4536743351bf247fb72b`、Mac 原生日志 `e9fbd64680590a1c724aff8905fd860917d61f91e89f63c99fd95d257bddc140`。native source `c2099fa3ff737c0942791d1d6446ffd4342ad98924301ca396e8128d12187e5b`、canary `1dd3b5483457adb6a54edc0260ea74c3b43bc45aeeb09253480be59d45158c4a`。原报告与实际日志保留在工作区 `an-p1-work/reviews/a5-closure`。

精确范围与未证明部分：

- B 所需测试检查是内容变化/非空结构，不证明有意义覆盖、语法或项目测试已经执行；运行行为交由固定独立 oracle。
- CHANGELOG 以 UTF-8 **解码文本**比较 A 前缀与非空追加；没有直接 Buffer 字节比较，也未显式拒绝无效 UTF-8。不宣称任意字节 exact prefix；此边界未执行新增独立负例，不能作为已证实新缺陷。pre-B authenticated workspace 整体 SHA256 等于 accepted A 的输入 custody 是另一项已有检查。
- pure-computation sandbox、实际 file/socket 拒绝、CPU2秒、parent5秒和64KiB总输出有现有源码/固定控制证据；**硬物理内存上限未证明**，时间/快照上限不替代硬 RAM。
- 本地 Linux native 编译 NOT_RUN；完整 installed guest + native verifier + Core 的真实 Task A/B、资源/网络/子写者实际门禁均 NOT_RUN/BLOCKED。当前只可依据已发生的固定可信合成对照，任意模型候选及 B 继续 BLOCKED。

首轮审查结果交付被平台 content-safety 标记中断；最终完成的是收窄后的源码/现有测试/同 SHA CI 只读审查，没有运行新的对抗程序或扩大平台操作。该历史不是本地工具权限拒绝，也不把未交付一轮算通过。

## 闭环与待做项

| 项目 | 最终状态 |
|---|---|
| A2 原 pressure + 新 EOF/恢复 handoff 实证缺陷 | 三项独立 CLOSED，e4d11e8 提交 |
| A3 新过期/畸形/timeout:0 授权缺陷 | 独立 CLOSED，43b7e64 提交 |
| A3 原 helper #2/#3 | 保持源码关闭；真实 Darwin/VM 生命周期证据仍待具名目标 |
| A3 原 helper #1 same-boot recovery | PARTIAL / UNSUPPORTED / B3 BLOCKED；UNKNOWN 不放行新 writer |
| A5 原 Critical / Important | 固定原生 / v2 结构范围独立 CLOSED；不是通用安全或完整 B readiness |
| N2 / B1–B3 / 人工 Mac | 未启动 / NOT_RUN / BLOCKED，所选路径相关强制能力缺口仍保留 |

根代理全套与四组标准 CI 是独立记录来源；未参与实现的审查者只对上文明确集合和控制提供独立证据，不重命名为全套/真实场景通过。后续原生资源、实际 guest 自主关机退休、无账号正向隔离和 Task A/B 必须另行满足准入与实际门禁。

## 实际环境与剩余边界

用户 Mac/VM/CLI、账号/凭据、模型、实际 Task A/B 和人工 Mac 检查全部 NOT_RUN/BLOCKED。Mac mini M4、personal-codex-p1 仍 UNCONFIRMED。同主机启动内 helper 崩溃恢复、细粒度网关、每 Bot 文件配额、verifier 硬物理内存上限与受监督首装缺口维持原报告状态。此次未启动 N2、VM、登录或费用操作。

## 后续 B 的最小具名授权表

这张表只收集脱敏 ID 和批准引用；设备地址、账号细节、授权文件及秘密保存在获准私有配置，不写公开 Issue。当前候选均 UNCONFIRMED；没有填表或运行 B。

| 必需项 | 待填写内容 |
|---|---|
| 目标与窗口 | validationTargetId、所有者/测试者引用、可用窗口；实际 ARM64 macOS/VM/GUI 与私有安装根/资源限额的证据引用 |
| 分项设备操作 | 明确逐项允许：只读 preflight；准备/安装磁盘与 guest；create/start/connect/owned stop；无账号 initialize；故障/恢复；签名或清理仅另列具体范围 |
| 固定环境 | bootstrap/runtime/helper/verifier 版本、摘要、许可/用途准入与 N2 受监督准备证据；不把通用 Ubuntu 镜像当已安装 AN guest |
| Connection | connectionId、目的/主体与私有账号引用、认证方式、计费来源及证据；允许 node/project/Bot/模型、direct/gateway 路由与端点政策 |
| 数据与执行边界 | 仅公开/合成 Task A/B 项目或明确批准的数据范围/传送位置；Run/并发/调用/时长/费用边界及实际可执行控制，未知项明确阻塞，不以金额字段代替硬上限 |
| 撤销和恢复 | 批准引用、撤销入口、owned stop/保留数据/清理范围；保留 UNKNOWN 和失败历史，不能删除旧 journal 或允许替代 writer 以绕过恢复缺口 |

即使具名授权齐全，当前硬内存、实际网络/隔离、same-boot 恢复等与所选路径相关的强制缺口仍按门禁 BLOCKED。下一步 N2、B1/B2/B3 分阶段处理，不能用本次复审或标准 CI 推定通过。具体既有表见 [Mac 目标准入](mac-target-preflight.md) 与 [Connection 准入](p1-connection-preflight.md)。
