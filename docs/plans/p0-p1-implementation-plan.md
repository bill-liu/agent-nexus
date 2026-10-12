# AN v1.3 P0/P1 实施计划

**修订：2026-10-13，落实第二轮审查 F01–F05；本次只修订文档，不修改业务代码。**

**授权与状态：用户已批准 super bot 先开发 P0，并授权并行修订计划。P0 不再等待一次重复的方案确认。P1 的真实 Mac 接入、官方登录、模型调用和费用仍需相应前置条件与具名授权，不能由 P0 授权推导。**

设计基线仍为 `b70301983334770ddaceb1706822e28ca47352da` 的 [技术设计](../design/v1.3/technical-design.md) 与 [交互设计](../design/v1.3/interaction-design.md)。原始 [设计评审与 CR01–CR13](v1.3-design-review.md) 保留为历史阅读记录；本计划和 [执行门禁及补充验收](p0-p1-execution-gates.md) 落实后续审查裁决。原 [165 项验收映射](v1.3-acceptance-map.md) 是规格追踪，不是实时测试结果表。

## 0. 当前工程与本轮修改边界

本轮读取的仓库基点为 `e7cd9797a6933761a84d06965285e461fe59ba3b`。该基点已经包含 P0 工程、锁文件、FakeRuntime/FakeAuth/FakeGateway、离线 CLI 审批映射和验证记录。因此原稿中“没有工程、全部文件尚不存在、等待批准 P0”等描述不再适用。

实际进展以 [P0 报告](../validation/p0-report.md)、[preflight](../validation/p0-preflight.md)、[CLI 审批协议记录](../validation/cli-approval-contract.md) 及其绑定提交的证据为准。本轮读取这些记录，但没有重跑其产品测试，不把读取报告等同独立复验。报告仍列出人工 Mac、VM/真实 Runner、真实 Connection、真实资源来源等缺口。

保留 super bot 已提交的代码、锁文件、CI 和验证历史；后文 P0-00–07 是持续适用的要求与差距核对清单，不是要求清空重建或重复已具备证据的实现。旧文件规划可由等价现有模块承担，记录映射即可。P0 已有离线审批测试不能覆盖 P1 实际双向 RPC、进程和网络验证。

**Goal：** 可信、可恢复的单 Core 桌面骨架；随后一个长期 Bot 在 Mac 管理的 Linux VM Sandbox 内，使用一种获准 Runtime/Connection 连续完成两项有独立验收的真实小任务。

**Architecture：** Electron Main / 最小 Preload / Renderer / 独立 Core Worker；本地 SQLite 与文件为权威；Provider、Node、RunnerClient、RuntimeDriver 分层。Resource Server 仅分发公共环境/模板；用户受控模型网关是另一条授权通路。公共服务不接管私有调度、知识或账号。

**不可变边界：** 一期只有 Mac 客户端；三个主入口；Sandbox 跟 Bot 而非 Task；所有 Agent CLI 在 Sandbox 内；一个 Bot 一个主动写槽位；用户选择账号与费用来源；失败不静默切 API、不绕过网关、不借其他 Bot 凭据；Bot 自报完成不能替代证据。

## 1. 阶段与真实依赖

| 阶段 | 产出与退出门禁 | 不能替代的证据 |
|---|---|---|
| P0 | 桌面/Core/SQLite、模拟执行、资产/连接/下载策略与离线审批契约；实际 Mac 开发包及对应测试 | Linux 单测或 Swift smoke 不能替代 Mac 包；自动化成功不能覆盖人工 IME/VoiceOver/睡眠门禁 |
| P1 | 获准 Mac VM、长期 Sandbox/Runner、第一种真实 CLI/Connection、最小资料/Skill/规约、独立验收及两项任务、故障与恢复 | FakeRunner、仅下载完成、仅远程 Linux 跑通、CLI 正常退出都不能替代 |
| P2 | 其他 Runtime、远程 Provider、人工接管、完整目录发布/升级/撤回及维护 | P1 单一路径不能宣称全部供应商或生产发行获准 |
| P3/P4 | P3 Orchestrator/三长期 Bot/动态图/独立 Goal 验收；P4 真实经验复用 | 不在 P0/P1 页面伪造多人调度、成长或 P5 自训练 |

修订后的关键顺序：

```text
P0-00 → P0-01/02 → P0-03/04/05/06 → P0-07

P1-00（Runtime/Connection 准入，静态检查可先做）
P1-01（先固定合法来源的最小 VM 启动材料，再验证 VM/隔离）
  → P1-02（下载与初始化；此时只证明环境，不能假称真实 Runner 就绪）
  → P1-03（真实 Runner/Driver，包括双向审批；真实认证必须先过 P1-00）
  → 回验 P1-02 的完整 Bot readiness（真实 Runner health/version/auth）
  → P1-03V（最小独立 Verifier/Evidence；可在前面以合成候选并行建设）
  → P1-04（两次真实任务）
  → P1-05（完整故障、备份和阶段复验）
```

P1-01 的启动材料是经过来源、许可、摘要/签名和架构验证的 bootstrap 输入，不依赖尚未完成的完整 Bot 初始化。它不包含真实用户秘密或强行预装未获准分发的 CLI。P1-02 可以使用受控本地 fixture/server 验证分发协议，但必须区分测试信任根与实际发布者准入。

环境、Runner、Runtime、认证分别记录 readiness。P1-03 到位后，必须重新经过真实初始化检查，才能进入可接真实任务状态。不能用临时 health stub 的成功沿用为真实 Runner 成功。具体启动闭环见补充门禁 §2。

## 2. 验证命令与平台契约

在本轮基点，`package.json` 已定义以下命令。它们的具体可用性以实施时同一提交的脚本、锁文件和参数为准；不要为了旧计划文件名重命名已工作脚本。

| 命令 | 当前用途与边界 |
|---|---|
| `npm ci` | 在已授权开发/CI 环境按当前锁文件安装；不借文档修订更改版本 |
| `npm run preflight` | 当前工程/平台探测；不能假设已经支持旧稿中的 runtime-auth 参数 |
| `npm run typecheck` | 当前 TS 类型与包边界检查 |
| `npm test` 或 `npm run test:logic` | 当前逻辑全集；定向示例 `npm test -- tests/contract/approvals.test.ts` |
| `npm run build` | 构建已存在的桌面工程，不能视作 Mac 交互通过 |
| `npm run package:mac` | 在受测 Mac 生成开发 `.app`；架构由实际脚本/目标决定，未知参数不得假用 |
| `AN_PACKAGED_EXECUTABLE='<package-evidence.json 中的 executable>' npm run test:electron` | 测试实际包内程序，不启开发服务器；比对源码 SHA、dirty 标志和包 digest |
| `AN_PACKAGED_EXECUTABLE='<同一 executable>' npm run test:mac` | 同一开发包的 Mac 自动化；人工验收另记，不能被覆盖 |
| `git diff --check` | 当前修改的空白/冲突检查，不证明产品行为 |

P1 可新增 `test:integration`、Runtime/Auth preflight 和 Swift helper 测试入口，但必须先实现命令、验证参数与退出语义，再在计划中作为可运行接口引用；当前缺失一律 NOT_RUN/BLOCKED，不能宣称已运行。测试不能从默认环境自动找到真实凭据；运行真实用例必须显式选择已授权测试目标和 Connection。

平台分层：Linux/macOS 通用逻辑；具备条件的 macOS CI 开发包自动化；经授权的实际 Mac VM 与人工交互。CI 的真实能力以探测和证据为准，不把已有 arm64 开发包 CI 当成已获准的嵌套 VM 环境。现有 Swift smoke 继续独立，不采购 larger runner、不自动注册用户电脑或注入真实账号。

## 3. P0：已授权推进，保留已有工作

### P0-00 — 兼容性与低成本探针

核对当前锁文件、Electron/内含 Node、SQLite 实现、打包器、测试器、最低系统与目标架构，不重新开启主 UI 选型。检查 utilityProcess 的环境白名单、原生模块/内置模块加载、单 Core 重启和实际 `.app`。

尽早做无真实账号的首选 CLI 探针：版本及离线 schema，与获准隔离环境中的初始化分别记录。初始化不得继承宿主认证缓存、发起登录、创建 turn 或调用模型；不具备无调用保障或 Sandbox 权限就保持 BLOCKED。P0 报告中的 bwrap UID map 阻塞不因 schema 生成成功而关闭。

P0 可继续无账号模块开发；人工 Mac、VM 能力、真实认证的缺失只阻塞相应验证和 P1，不要求整项 P0 空等。

### P0-01 — 单 Core 与最小 IPC

维护 Main/Preload/Core/Renderer 职责、typed command/scope/expected_version，真实 sender/frame/origin/schema/大小检查；Renderer 不获得 Node、SQL、shell 或泛用 invoke。单实例、Core epoch、多窗口、草稿和订阅作用域分别测试。

Core 重启先确认旧控制者不再写入，再对账恢复；通用 core/domain 不依赖 Electron UI。保留 `tests/contract/ipc.test.ts`、平台边界和实际包 security 测试证据。

### P0-02 — 持久队列、唯一写槽位与事件恢复

Task/Inbox/Outbox 同一短 SQLite 事务；领取事务同时检查派工、依赖、版本、槽位、授权和输入。command_id 绑定请求 hash；重复收到只查询同一执行。事务内不等待网络。

LOST 未确认停止仍占槽位；租约过期不是进程退出。snapshot/cursor 同水位，sequence 去重与补传。Bot 接单/派工和未来 Goal 暂停作用域分开。维护 dispatch/events/core-restart 故障测试，不降低断言来消除竞态。

### P0-03 — 意图、控制与审批契约

讨论、新任务、补充、控制分别建模；消息绑定 bot/conversation/task/revision/run/session/turn，过期补充不落入下个任务。RECEIVED/QUEUED/DELIVERED/APPLIED 不混同。讨论的只读要求以后由真实执行点验证，不只依赖 Prompt。

审批冻结动作/参数摘要、候选、连接/Grant、节点代际、期限与原生请求 ID；批准、消费、发回响应和实际执行是不同事实。复用已经形成的 [P0 CLI 审批协议](../validation/cli-approval-contract.md) 与其固定 schema，不重写第二套审批服务。

新增/保留真实驱动接口：pending server-request → Core/UI decision → 原 JSON-RPC response → resolved/cancel/expiry。P0 只证明模拟与离线映射；P1-03 必须验证活传输和原生请求仍待答复。不得默认 acceptForSession、网络批量放行或未知扩权。细节和负向场景见补充门禁 §3、§7。

### P0-04 — 资产与上下文

维护原件/索引、版本/digest、作用域、中文检索、local-only 处理规则、规约冲突和撤回。生成指令保留用户 AGENTS/CLAUDE 等既有文件；Skill 安装/启用/授权分别记录，脚本不在 Main/Core 运行。

ContextManifest 固定实际资料、Skill、规约与处理政策。更新影响后续 Run/安全续接点；硬撤权立即限制新的读取或调用，同时列出受影响会话，不声称已读内容被抹除。P0 模拟拒绝不代替 P1 文件/网络负向验证。

### P0-05 — Connection、秘密与费用边界

确定性 Resolver：用户显式任务连接或 Bot 默认 → Grant/数据/计费 → Runtime/节点 → 清理冲突继承配置 → 检查实际 auth → 固定 snapshot。最终启动及网关请求再次检查 Grant revision，测试撤销竞态。

执行租约、网关凭据租约和上游 Key 分开；本地 revoked 不等于上游撤销。AuthFlow 绑定 Bot/代际/Runtime/Connection revision/state/expiry/认可域名，取消、晚到、串 Bot 和错误回调拒绝。秘密输入独立短生命周期通道，普通 Renderer 只有引用与安全元数据。

以合成 canary 检查 IPC、日志、预览、Prompt、导出、快照；不得为测试申请真实 Key。长进程换授权需要真实协议或停止后新进程，不能写文件后假称环境变量已更新。各真实路径由 P1-00/03 收口，不必为了覆盖全部 C01–C20 购买或启用全部账号。

### P0-06 — 公共分发最小契约

维护 manifest、架构/协议、摘要与签名、续传/过期 URL、operation 幂等、解包越界/symlink/大小限制和原子激活。P0 仅使用无秘密 fixture 与测试信任根，不证明实际包已经许可或可信。

P1-01 先确定 bootstrap 来源，P1-02 再接完整安装流程；现有缓存可用与首次建立信任是不同条件。资源目录不是模型网关或第二控制中心。

### P0-07 — Mac 开发包、最小 UI 与差距报告

以 S00/S04/S05/S06/S08/S09 为主，S15/S17/S18/S19 只提供相应已实现的最小状态与导航。保留三个入口；未启用的 Goal/成长/真实登录不能做成假功能，不提前造资源市场。

⌘W、⌘Q、设置/详情关闭、Renderer/Core 崩溃、第二实例、恢复草稿、资料预览、深链接和日志背压用实际包验证。中文 IME、VoiceOver、缩放/Retina、多屏、外观和睡眠有独立人工记录；缺条件留 NOT_RUN/BLOCKED。

报告分别列已验证自动化、人工缺口、隔离初始化阻塞、P1 未实现项。引用 [P0 报告](../validation/p0-report.md) 的确切提交和证据，不将原 165 项规格全部改为 PASS。本次文档修订不重新认证该报告的结果。

## 4. P1：条件满足后才进入真实路径

### P1-00 — Runtime/Connection 与测试目标准入

形成 `docs/validation/runtime-auth-preflight.md`，记录用途（本地个人/本地开源发行/商业或托管分别判断）、官方依据与核验时间、CLI/协议版本、配置与环境白名单、节点/代际、账号与费用证据等级、允许资料流向、缓存隔离和失效条件。

首选 Codex app-server；exec 作为独立 Driver。许可、认证方式和商业注册适用范围逐路径判定，不能以“SIWC 待审核”阻塞所有个人无账号开发，也不能以官方二进制可运行推导所有第三方集成都获准。未知只阻塞该真实路径，不妨碍 fake。

在真实登录或调用前，必须取得具名 Connection、目的、账号/组织、订阅/API/网关、调用/费用范围、节点与数据范围授权；预先验证 [Mac 目标和授权清单](p0-p1-execution-gates.md)。发现凭据不等于有权使用。不能为跑通自动选另一个账号。

### P1-01 — 先启动环境，再构建完整初始化

新增或接入 `native/macos-sandbox-host/`、Node Agent、Provider 及 sandbox integration。第一步固定最小 VM 镜像/配方的实际来源、许可、digest/可信签名、架构、磁盘/资源、内核和 bwrap；由隔离探针启动，无私有资料或认证。

先用受控探针证明通道、挂载、CPU/内存/PID/磁盘约束、网络出口、停止/启动和稳定持久目录。此时可以没有真实 Runner；报告明确 bootstrap 可用，不宣称 Bot 已能工作。

测试宿主 Home/DB/socket、跨 Bot 目录、CLI 内部沙箱与外部 bwrap、旧 generation、子进程和网络。失败保留 BLOCKED，不退回宿主 shell。开发 helper 所需 entitlement/签名需求明确列出，与对外发行签名分开，新增授权事项先取得用户同意。

### P1-02 — 下载与可恢复初始化

维护同一个 Bot/operation 的下载、校验、安装、失败和重试；缺认证不销毁环境。P0 fixture 仅证明协议；实际包要有来源/许可准入，CLI 不允许再分发则按获准官方安装方式处理。

本步骤可以先验证到 ENVIRONMENT_READY；FakeRunner/stub 只能标模拟。P1-03 实际 Runner 到位后必须重跑 health/protocol/runtime/auth readiness，之后才允许真实任务派工。不得先把 Bot 设为已授权可运行，再等后面补驱动。

### P1-03 — 真实 Runner/Driver 与审批往返

接通 Runner command receipt/spool/process、RunnerClient 和首个 Codex app-server Driver。真实认证前必须满足 P1-00，环境须通过 P1-01 和 P1-02 对应准入。

固定协议测试包括 start、steer、interrupt、inspectAuth、checkpoint，以及 **接收原生审批/输入请求、持久关联、用户决策、回复原 RPC、resolved/取消/过期清理**。复用 P0 映射与状态服务，新增活 transport/process binding，不只把请求转换为日志。

请求绑定 Run/Session/Turn、节点 generation、transport instance、原生 typed request ID、动作/参数、Connection/Grant revision 和期限。未知方法/未知授权范围不自动放行。普通补充输入与权限批准分开；用户输入不能当作权限令牌。重连只重发已验证仍 pending 的同一响应，不能在新 CLI 进程复用旧请求 ID 导致再次操作。

实测未答复、拒绝、精确批准、迟到批准、重复响应、断线、resolved 后响应、撤权、错代际及批量授权被拒绝。必须观察实际文件/进程/网络效果；收到消费记录不等于已经执行。CLI 可能不对每个操作发审批，硬限制仍由 Sandbox/出口/工具控制，不能依赖回调完成全覆盖。

验证缓存重用/过期/重新登录/撤销及跨 Bot 读取，使用受控合成 canary；不泄漏原认证响应。选定网关则实测出口拒绝和不绕过；选定直连则明示原 Key 与同 UID 风险，并验证上游轮换边界。未选路径保留模拟/NOT_RUN，不宣称全部真实通过。

完成后回验 P1-02 的真实 readiness。driver/auth-cache/connection-leases integration 与补充门禁中的实际审批测试均须留下相同候选的证据。

### P1-03V — 最小独立 Verifier/Evidence（前置，F01）

在 P1-04 真实两任务之前实现最小验证器、`tests/contract/evidence.test.ts` 和相应集成 oracle。可以与 Runner 建设并行，用无账号合成候选先测；无需提前建设 P3 完整验证平台。

验证器由受信任测试控制端调用，在独立只读快照/隔离验证目录或临时验证 Sandbox 中检查确切候选，使用固定断言/测试清单。不得运行 Bot 生成的任意宿主脚本，也不依据 Bot 的自然语言、退出码或自产 PASS 文件作终结。

Evidence 固定 candidate_digest、Task/contract revision、输入上下文、验证器版本、平台能力、命令/断言、退出码与产物摘要。负向测试至少包括错候选、旧合同、篡改报告、自报通过、缺少平台能力均被拒绝。没有独立证据时 Task 保持 VERIFYING。

先确定两项真实小任务的独立可观察断言和起始测试仓库；P1-04 引用该 oracle。完整故障、备份与恢复仍留 P1-05。新增场景 GATE01/GATE02 不能仅因为有这个章节就标 PASS。

### P1-04 — 两项真实任务与最小资产体验

前置：真实 readiness、具名连接与 Mac 授权、P1-03V oracle 全部可用。Task A 在授权测试项目修改一个可测试的小行为并保留成果；Task B 验证并继续同一项目成果。第二项可排队，不并发写同一工作区。

两项任务各自先保存精确候选，再由独立 oracle 判断；验证器不能读一个不断变化的可写目录充当冻结证据。需要保留未提交变更时生成可确认 digest/快照。不同任务可新建分支/会话，但 Bot、SandboxBinding 和正常项目资料保持。

接通 S00/S04/S05/S06/S08/S09 与最小 S15/S17/S18/S19/S20；资料、Skill、规约、Connection/Grant 和上下文版本可追踪。真实测试 local-only 与云端连接冲突、资料撤回、规则冲突、秘密不入材料；硬限制必须在执行点验证，见补充门禁 §6。

验收 task-A → IDLE → task-B，不重新 clone/清空 Home，不每任务重登；App/VM 重启后先对账。必要的重新授权不损害 Bot 身份。task-journey 与 persistent-bot 测试绑定同一候选，不把模拟 UI 成功盖成真实执行。

### P1-05 — 故障、备份、平台复验与退出

在已有最小 Evidence 基础上扩充独立验证、恢复与一致性备份，不到此时才首次实现 oracle。注入 Renderer/Core/Runner 崩溃、断线、磁盘满、spool 重传、取消但子进程未退出、睡眠/强退/⌘Q；未知副作用先对账。

SQLite 一致性备份加工作区/Artifact 清单，普通导出排除 auth cache；含秘密 VM 快照单独保护。干净环境恢复同 Bot 后继续任务，并验证旧节点/旧授权不能继续写。不能仅复制活动 WAL 主文件。

执行 P0 回归与全部已选 P1 路径，人工补 Mac 输入/辅助/文件/生命周期。未选 Runtime/网关/架构、未验证真实发布者、生产签名/公证不能被一条路径覆盖。记录每一前提、失败、NOT_RUN/BLOCKED 和证据位置；阶段通过不能混用不同候选。

P1 新增真实能力或费用须按本节前置授权；完成后汇报并等待下一阶段指令，不因 P0 批准而无限扩张。

## 5. 证据、验收与并行协作

最小证据键为：设计 revision、源码/包/candidate digest、验收 ID、阶段、fake/offline-schema/真实/人工、OS/arch/Runtime/协议、连接来源等级（无秘密）、命令与退出码、日志/产物引用、结果、负责步骤。

原 [165 项映射](v1.3-acceptance-map.md) 保持规格性质；[补充门禁](p0-p1-execution-gates.md) 增加 GATE01–GATE20，不替换原 ID。P0 fake PASS、P1 live NOT_RUN 和人工待验可以同时成立；不得合并成一个虚假的整体 PASS。没有证据时只确认“要求已写入”，不确认“功能已通过”。

本轮文档修改者不改 apps/packages/tests/scripts/锁文件/CI 或已有 validation 结果。super bot 继续 P0 代码；同步最新 main 后仅核对涉及的新要求，已完成同版本协议与测试可复用，真实运行缺口不得复用为已通过。

并发提交以最新 main 为父提交，变更前核对文档 blob；main 前进则重新读取差异、保留双方变化，禁止 force push。交接通过仓库 [AGENTS](../../AGENTS.md) 与 Issue #1，不要求用户搬运文件。该协作方式不意味着两个 Agent 自动共享会话或后台消息已读。

## 6. 修订对应关系与范围声明

| 审查项 | 本版落点 |
|---|---|
| F01 启动依赖与验收前置 | §1；P1-01/02/03 回验；新增 P1-03V；补充门禁 §2 |
| F02 真实 CLI 双向审批 | P0-03 复用；P1-03 活链路；补充门禁 §3、GATE03–09/19 |
| F03 实际 Mac 条件 | §2；P1-00/01；补充门禁 §4、GATE16 |
| F04 硬约束执行与负向验证 | P1-01/03/04/05；补充门禁 §6、GATE10–15/20 |
| F05 早探针与许可分场景 | P0-00；P1-00；补充门禁 §5、GATE17/18 |

本轮只修订计划与验收要求；未运行产品测试、未登录、未使用真实 Key、未调用模型、未配置用户 Mac/付费节点、未改变 v1.3 产品方向。当前 P0 结果由原验证记录承担，不能把这次文档提交当成新的产品验证结果。

**文档结束。**
