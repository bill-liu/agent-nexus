# P1 任务书：从 FakeRuntime 到一个可持续工作的真实 Bot

> **交给 super bot / supper bot。** 实施时使用 `superpowers:executing-plans`；有可用子代理时可使用 `superpowers:subagent-driven-development`，按独立模块分工。复用 P0，不建立第二套 Core、审批、连接或资产系统。

**Goal：** 在同一 Mac App 中，让一个长期 Bot 在专属 Sandbox 内使用一种获准 CLI/Connection，连续完成两项小型真实任务；通过独立验收、持续交互及停止/恢复检查。

**Architecture：** 保留 Electron Main/Preload/Renderer、单权威 Core、SQLite、版本化资产和 Connection。新增异步执行通路、Node/Runner/首个 Codex Driver、Mac VM Provider 与最小独立验证器；公共 Resource Server 只供应环境，不管理用户账号或私有 Goal。

**Tech Stack：** 复用当前 TypeScript、React、Electron、SQLite、Vitest/Playwright 及锁文件；Mac VM helper 按既有设计使用受控平台实现。具体版本以实际仓库及 preflight 为准，不为任务书升级全部依赖。

**Spec：** [技术设计 v1.3](../design/v1.3/technical-design.md)、[交互设计 v1.3](../design/v1.3/interaction-design.md)、[修订后的 P0/P1 计划](p0-p1-implementation-plan.md)、[执行门禁 GATE01–GATE20](p0-p1-execution-gates.md)。本文是这些规格的下一阶段执行切片，不替代原设计或降低验收。

**日期与基点：** 2026-10-13；编写时 `main = f27b8b17ea0828b265a2681ab8df08e8162116d5`。P0 自动化证据对应 `6667ec5a5166a7395007293faefca2f5f1e9f994`，详见 [P0 报告](../validation/p0-report.md)。本文未重跑产品测试，也不宣称 P1 已开工或通过。

## 0. 范围、授权与本次交接

用户要求给 super bot 下一阶段任务书，并沿用 GitHub 直接交接，不让用户搬运文件。P0 已获准开发。本文安排 P1 的工作顺序；**任务书提交本身不代表用户已授权接入某台 Mac、安装 VM、读取账号、登录、调用模型或产生费用。** 实现者按主线程已明确授予的开发范围推进无账号部分；若尚无 P1-A 业务实现授权，只需集中确认这一范围，不重问产品架构，更不能把未确认的真实环境条件当作已批准。

把 P1 分成两个执行范围，而不是两套架构：

| 范围 | 可做的内容 | 必须停下的边界 |
|---|---|---|
| P1-A：无账号实现与准备 | 在已授权开发/CI 环境写代码、合成数据测试、离线协议适配、构建 helper、生成预检和联调脚本、准备独立 oracle | 不连接用户设备、不默认安装 VM、不读取真实凭据、不登录或调用模型；缺 Mac 只阻塞对应实测 |
| P1-B：具名环境真实联调 | 在明确获准的目标上启动 VM/Sandbox、官方无账号初始化、获准登录和两项真实任务 | 每类设备/安装/账号/费用操作须有相应批准；无批准则 BLOCKED，保留已有代码成果 |

候选验证机为用户自有 Mac mini M4，候选连接标识为 `personal-codex-p1`；二者来自方案建议，**当前均标 UNCONFIRMED，不自动创建授权或写成有效配置**。账号路径建议个人 Codex 官方登录，是否适用及最终计费来源仍由用户和前置核验决定。不能因为更容易测试就改成 API。

## Global Constraints

- 一期只有 Mac 客户端；任务指挥台、Bots、成长三个一级入口不变。
- Sandbox 跟 Bot，不随 Task 完成销毁；一个 Bot 一个主动写槽位。
- 所有 Agent CLI 在 Sandbox 内运行。云开发环境的 uid-map 限制不通过宿主执行或关闭隔离绕过。
- 用户指定具名 Connection；无授权不订阅转 API、不绕过网关、不借用其他 Bot 账号。
- 私有知识/Skill/规约本地优先，按范围和版本装载；硬权限在实际执行点落实。
- 不做 P2 其他 CLI/远程产品扩展、P3 多 Bot 调度、P4 自动学习、P5 决策训练或 RRSI 搜索；不做完整资源市场、商业账号体系和生产发布。
- 无真实秘密进入 public 仓库、Issue、日志、Prompt、fixture、普通导出或 CI。设备码同样只进入专用临时授权界面。
- 维护旧测试与故障记录；不得删断言、宽松放行、把 UNKNOWN 当成功或把 fake PASS 计为 live PASS。
- 发布签名、公证、付费云机器、许可证变更和用户数据清理不在本任务书的自动授权范围。

## Review Focus

1. 同步 fake 接口接真实异步通信时，不能在 SQLite 事务中等待网络，或在丢 ACK 后重复执行。归属 A1/A2、B3。
2. Runner 退出、CLI 退出、全部可写子进程停止是不同事实；未经确认不能释放写槽位。归属 A1/A3、B1/B3。
3. 原生审批响应可能已消费但未送达；不能把旧响应重放给重启后的新进程。归属 A2、B2/B3。
4. 认证预检之后、真正启动之前撤销 Grant，或读取到冲突凭据时，不能仍用错误账号执行。归属 A4、B2。
5. Task 已产生成果但候选漂移、验证报告被改、App 恢复使用旧证据时，不能标为成功。归属 A5、B2/B3。

## 1. 先读取和复用哪些真实代码

先拉取最新 main，记录实际 SHA，检查本任务书之后的 diff。相同设计 blob 已有完整阅读回执可复用；实现涉及的源文件、修改过的章节和相邻契约必须重读。不要退回已验证代码 SHA 丢掉后续门禁。

| 已存在路径 | 复用内容及当前限制 |
|---|---|
| `packages/core/src/store.ts`、`control.ts` | SQLite、Outbox、幂等、写槽位和控制模型；当前 `RunnerTransport.receive/query` 为同步，`ExitEvidence.source` 仅接受 `fake-runner` |
| `packages/core/src/p0-application.ts` | P0 组装逻辑固定 FakeRuntime/FakeAuth 及本地演示连接；不直接改成偷偷读取真实账号 |
| `packages/core/src/approvals.ts` | 已有持久 ApprovalService，不能重新实现另一套 |
| `packages/execution/src/approval-adapter.ts`、`runtime-policy.ts` | 固定 Codex schema 的审批映射、精确动作约束；见 [离线协议证据](../validation/cli-approval-contract.md)；不是 live 执行证明 |
| `packages/execution/src/fake-runtime.ts` | 保留作无网络回归，不用它的自动退出行为推断真实进程已停 |
| `packages/connections/src/` | ConnectionResolver、Grant、AuthFlow、lease、元数据与测试；真实认证适配仍要补 |
| `packages/desktop-platform/src/secrets.ts` | 目前 `ProtectedSecretSink.storage` 和返回值固定为 `fake`；必须显式新增实际安全后端，不能改显示文案冒充 |
| `packages/assets/src/`、`packages/catalog-client/src/` | 资料范围、ContextAssembler、签名/摘要/安全解包、可恢复下载 |
| `apps/desktop/{main,preload,renderer,core-worker}/` | 既有中文桌面与进程边界；业务实接时保留演示与真实模式区分 |
| `package.json`、`.github/workflows/p0.yml`、`tests/` | 沿用可运行命令与现有测试；旧计划的拟建文件名不应强迫重命名已工作模块 |

以上代码限制是本次直接读取的现状，不等于发现安全漏洞。新增类型要扩大实际能力且保留信任校验，不能简单把 `fake-runner` 改成任意字符串。

## 2. 交付顺序与并行分工

```text
A1 异步执行契约与 Core 接口
  ├─ A2 Runner / Codex Driver / 原生审批往返
  ├─ A3 VM/Node Provider 与无账号环境探针
  └─ A4 安全存储与实际认证适配
A5 独立 Verifier + 固定测试项目（可尽早并行）
A6 最小桌面实接与操作清单（使用 A1–A5 的稳定接口）
                 ↓
B1 获准 Mac/VM/隔离内 CLI 初始化
                 ↓
B2 获准 Connection + live 审批 + readiness 回验 + Task A/B
                 ↓
B3 故障/备份/人工检查与 P1 总验收
```

可并行写 A2/A3/A4/A5，但先由 A1 固定公共类型；不同 worker 分开工作树和文件所有权。Core 迁移、`package.json`/锁文件、Main/Preload 接线及最终合并由同一集成负责人处理。子任务只提交自己的变化，不分别创建数据库或改全局依赖；共享文件变更集中集成。每次推送前刷新 main，禁止强推覆盖并发工作。

A 阶段的测试协议端只能描述为 scripted/fake transport；真实 Node 子进程测试也不自动证明真实 CLI 接入。B 阶段才关闭对应 live 门禁。暂缺设备或账号时继续可独立验证的 A 任务，提交可用代码和精确阻塞，不停在重新编写总体设计。

## 3. A1 — 异步执行边界与真实证据模型

**对应：** P1-03 的前置；GATE07/08/13/19。

**文件：** 修改 `packages/core/src/control.ts`、`store.ts`；新增 `packages/execution/src/runner-client.ts`、`packages/core/src/outbox-dispatcher.ts`；测试 `tests/contract/runner-client.test.ts`、`tests/recovery/async-outbox.test.ts`。保持 `P0Application` 演示行为，真实组装放 `packages/core/src/application.ts`。

**接口：** 使用既有 `ExecutionCommand` / `RunnerReceipt`，新增 `AsyncRunnerTransport`，其 `receive(command: ExecutionCommand): Promise<RunnerReceipt>`、`query(commandId: string): Promise<RunnerReceipt | null>`。保留同步 fake 适配器，禁止在事务内直接调用该异步接口。schema 新增字段须显式协议版本及兼容测试。

- [ ] 写 `ack_lost_reuses_command`、`revoke_between_prepare_and_send`、`dead_parent_live_child_keeps_slot` 和 `untrusted_exit_is_rejected` 的失败测试：一个 command 最多启动一次；撤权后不能新启动；没有 Node 可核实的停写证据不能释放槽位。
- [ ] 运行 `npm test -- tests/contract/runner-client.test.ts tests/recovery/async-outbox.test.ts`，确认失败来自待实现行为，而非无关环境错误。
- [ ] 将网络/进程预检、实际发送放在短事务之外；事务内只提交已核实快照、检查版本/槽位并写 Outbox，最终发送及执行侧重新校验 Grant/代际/有效期。无法保证新鲜的前置状态时阻塞，不持锁等认证。
- [ ] 新增真实退出观察及外部验证路径：绑定节点身份、sandbox generation、transport/process instance、Run、进程树状态和证据引用。Runner 自报字符串、exitCode=0 或父进程退出不能直接作为真实停写证明；OS 观察由受信任 Node/Provider 核对。
- [ ] 定向测试、现有 recovery 测试及 typecheck 通过后小提交；未有 live Node 观察时只标协议通过。

## 4. A2 — 持久 Runner、首个 Driver 与审批双向通路

**对应：** P1-03；GATE03–09/18/19。

**文件：** 新增 `apps/runner/src/{commands,spool,processes}.ts`、`packages/execution/src/drivers/codex-app-server.ts`；按需修改既有 `approval-adapter.ts` / `approvals.ts`；测试 `tests/contract/codex-driver.test.ts`、`tests/contract/cli-approval-roundtrip.test.ts`、`tests/recovery/runner-spool.test.ts`。固定 schema 位于现有 `tests/fixtures/cli-approvals/`。

**接口：** A1 的异步 RunnerTransport；Driver 新接口命名 `initialize`、`startTurn`、`steer`、`interrupt`、`inspectAuth`、`replyServerRequest`。对应入参须引用现有 Run/Session/Turn/Approval 绑定；在同一 contracts 文件中定义并被实现与测试共同引用，不以任意 JSON 透传。`replyServerRequest` 仅消费既有 ApprovalService 产生的已复验决定及原请求映射。

- [ ] 写 `pending_request_does_not_execute`、`denied_request_has_no_effect`、`late_approval_after_interrupt_is_rejected`、`old_receipt_new_transport_is_rejected`、`reconnect_replies_only_to_same_pending_request`；用固定 schema 的可控协议端先产生反例，数字/字符串 RPC ID 不混用。
- [ ] 运行上述两个 contract 文件及 spool recovery，先观察目标失败；禁止启动模型轮次来代替无账号测试。
- [ ] Runner 持久记录命令后 ACK，spool 有游标、上限、背压和重传；Driver 保存 transport instance 与原生 thread/turn/request 的对应关系。未识别字段、扩权、会话范围批准和无法缩小的网络批量请求按既有策略拒绝，不为了演示自动 accept。
- [ ] 实现 CLI 请求→Core/UI→原 RPC 响应→resolved/过期/取消；批准、消费、发送、效果、验收分开记录。回答普通用户输入不能授权工具；敏感输入不进普通事件。
- [ ] 无账号初始化探针仅在已经获准、能阻断模型出站且没有继承认证的 Sandbox 中执行；不具备条件就保留 BLOCKED。当前 uid-map 失败不得改成宿主机 app-server。离线 schema 记录和真实初始化记录分开。
- [ ] 测试通过后提交 Driver 和 scripted transport 证据；在 B2 以前明确未证明真实模型/原生工具效果，不能删除离线/模拟标签。

## 5. A3 — Mac VM Provider、Node 与环境准备

**对应：** P1-01/02；GATE02/10/11/13/14/16/18/19。

**文件：** 新增 `native/macos-sandbox-host/`、`apps/node-agent/src/{control,storage,limits}.ts`、`packages/execution/src/providers/macos-vm.ts`、`packages/core/src/bot-provision.ts`；测试 `tests/contract/sandbox-provider.test.ts`、`tests/contract/provisioning.test.ts`；真实测试入口 `tests/integration/sandbox.test.ts` 在 B1 使用。下载逻辑复用 `packages/catalog-client/src/`。

**接口：** `SandboxProvider.create/start/stop/inspect/connect/destroy`，每次绑定稳定 sandbox ID 和递增 generation；返回环境观察与通道引用，不接收 Goal 完成命令。readiness 分开记录 environment/runner/runtime/auth，下载成功只能推进 environment。Task 结束不调用 destroy。

- [ ] 先写 `task_finish_keeps_sandbox`、`retry_provision_keeps_bot_and_operation`、`wrong_generation_rejected`、`stub_health_is_not_live_ready`、`untrusted_bootstrap_rejected`，运行对应 contract 测试观察失败。
- [ ] 实现最小 VM helper 与 Node 通道代码；优先固定一套可核验来源/许可/摘要/架构的 bootstrap 配方，不建设大型镜像服务。真正下载大镜像、分配 VM 磁盘或启动 VM，必须在 B1 的设备操作范围批准后执行。
- [ ] Node 承担各 Bot 私有挂载、网络出口、进程组/子进程停止与资源约束；不能给 Bot 宿主 Home、管理 socket、Core DB 或管理 SSH key。受控只读讨论限制项目写入，但允许隔离的运行时缓存，不靠命令名字判断只读。
- [ ] 编写安装中断恢复、来源校验与只读预检脚本；记录实际所需路径、entitlement、临时文件和清理动作，不申请证书、不关闭系统防护。存在共享宿主服务时只停止 AN 所属实例。
- [ ] 在已获准的标准 CI 中完成能做的 helper 编译/单测，剩余真实 VM 测试标 BLOCKED/NOT_RUN；脚本/合同测试通过后提交。先证明 bootstrap，再安装环境，A2 到位后回验真实 readiness，不能互相循环等待。

## 6. A4 — 安全存储、认证状态与 Connection 实接

**对应：** P1-00/03；GATE12/14/15/17/20。

**文件：** 修改 `packages/desktop-platform/src/secrets.ts`、`packages/connections/src/{broker,resolver,types}.ts`，新增 `packages/desktop-platform/src/macos-secrets.ts`、`packages/execution/src/drivers/codex-auth.ts`；测试 `tests/contract/protected-secret-backend.test.ts`、`tests/contract/auth-runtime-binding.test.ts`。现有 Grant/AuthFlow/lease 必须复用。

**接口：** 将 fake-only 后端类型扩展成明确的 backend 判别类型；新增 Mac 安全后端，普通 Renderer 仍只有保存/撤销及非秘密引用，不增 readPlaintext API。CLI 官方登录由官方运行时维护；AN AuthAdapter 检查身份/方式/账单来源证据，不能把订阅 OAuth 改成通用 Broker 托管。

- [ ] 写 `fake_backend_cannot_admit_live_connection`、`secure_storage_unavailable_fails_closed`、`conflicting_env_blocks_selected_subscription`、`grant_revoked_after_auth_blocks_start`、`expired_login_preserves_workspace`。只使用合成 canary 与 scripted auth。
- [ ] 运行两个新增 contract 文件及现有 connections/auth-flow/secret-boundary 测试，先证实缺失行为。
- [ ] 实现实际 Mac 安全后端，系统保护不可用时不明文降级；保存状态必须返回真实后端类型。可以在获准 CI 用专用临时测试存储验证，不搜索或读取用户现有 Keychain/CLI 账号。
- [ ] 真实模式必须显式选择 Connection，默认不启用；清洗进程环境、HOME/配置/缓存查找路径并验证实际 auth。不得继承开发机账号；官方登录页/设备码只走适用官方流程，回调与 Bot/代际/连接版本绑定。
- [ ] 直连、网关和原生登录的通用失败分支以模拟方式测试，但 B 阶段只接一个用户选定的真实路径。未选网关就不建完整生产网关；未选 API 就不添加真实 Key。默认不切计费来源。
- [ ] typecheck、定向测试及 canary 泄漏扫描通过后提交；真实安全后端的操作系统验证、登录和账单观察仍分栏，不以一个总 PASS 合并。

## 7. A5 — 最小独立 Verifier 与两次任务的固定夹具

**对应：** P1-03V，必须先于两次真实任务；GATE01。

**文件：** 新增 `apps/verification-worker/src/{candidate,evidence}.ts`、`tests/fixtures/p1-export-project/`、`tests/fixtures/p1-oracle/`、`tests/contract/evidence.test.ts`、`tests/integration/evidence.test.ts`。调用验证命令属于受控验证目录/Sandbox，不是直接执行用户仓库任意宿主脚本。

**接口：** `verifyCandidate(input): Promise<EvidenceRecord>`；input 必须含 candidateDigest、immutableSnapshotRef、taskRevision、contractDigest、verifierVersion、oracleDigest 和实际 platform/capabilities。EvidenceRecord 含上述绑定、每项断言结果、开始/结束记录、command/exitCode、证据摘要及来源。具体类型在 `packages/contracts/src/evidence.ts` 统一定义并严格校验。

- [ ] 先写 `wrong_candidate_rejected`、`stale_contract_rejected`、`bot_written_pass_not_accepted`、`tampered_report_rejected`、`mutation_during_verification_rejected`；用已知正确/错误的合成候选证明 oracle 本身有效。
- [ ] 运行 contract/evidence 测试观察失败，再实现最小验证路径。报告由受信验证器写，Bot 不能改 oracle、伪造验证来源或通过新增 PASS 文件过关。
- [ ] 固定下述 Task A/B、输入与断言，将 oracle 摘要提前保存。对未提交代码使用精确快照/清单验证，不只以 Git HEAD 代替实际内容；验证期间不读并发可写目录。
- [ ] 如需 Task 增加 `SUCCEEDED` 与证据持久化，做显式迁移和受控 transition，只有核对当前契约/候选且已保存证据的 Core 能调用；保留既有 Run 退出仅进入 VERIFYING 的语义。新验证器复用同一 SQLite，不另建成功状态库。
- [ ] 正确候选通过、错误候选确实失败、旧证据不能推进新候选后提交。此时只说明独立验收机制就绪，不说明真实 Bot 已完成任务。

### 固定的测试项目与任务契约

使用无私密内容、无外部服务的小型 JavaScript ESM 仓库，导出入口为 `src/export-records.mjs`。Bot 可以改该项目源文件、项目单测和 `CHANGELOG.md`；不可改 Core/AN 主仓库、oracle 或认证目录。测试基于 Node 内置断言，无需为此新增业务依赖。

**Task A（正常导出）：** 实现 `exportRecords(records, maxRecords = 1000)`，对于数组输入和 1–10000 范围的整数上限，按原顺序返回前 N 条；不足 N 条全返回，空数组返回新空数组；总是返回新数组，不修改原数组。实现正常路径及项目测试，保持修改未提交以证明后续任务保留工作状态。

**Task B（在 A 上继续）：** 保留 A 的行为，增加非法输入校验：records 非数组抛 TypeError；上限为 0、负数、超过 10000、非整数、NaN、Infinity、字符串或 null 时抛 RangeError；省略/显式 undefined 采用默认 1000；补边界测试并追加 CHANGELOG。B 必须从 A 的确切输出快照继续，不能从初始模板另做一次。

oracle 在 A 阶段只验 A 契约，在 B 阶段验 A+B。它存于受信验证范围而非 Bot 可写工作区。实际调用之前冻结 task/contract/oracle 摘要；修改契约后旧报告自动失效，不通过改 oracle 放行错误实现。

## 8. A6 — 桌面最小实接、Mac 检查与授权资料准备

**对应：** P1-02/04，P0 人工收尾；GATE02/16/17。

**文件：** 修改 `apps/desktop/renderer/{bot-workspace,environment,connections}.tsx`、`main/`、`preload/index.ts` 和 `core-worker/entry.ts` 的实际接线点；新增 `tests/macos-e2e/p1-readiness.spec.ts`、`docs/validation/mac-target-preflight.md`、`docs/validation/p1-connection-preflight.md`、`docs/validation/p0-manual-mac-checklist.md`。

- [ ] 先测下载完成但 Runner 未到位、环境可用但待授权、两窗口重复批准、认证过期、Renderer 重载的视图状态；业务受理不冒充就绪，真实结果不带 Fake 标记，模拟数据不混入真实 Connection。
- [ ] 接通创建 Bot、环境状态、具名连接、资料/Skill/规约快照、队列、审批/拒绝/中断、结果证据；不扩展市场、其他 CLI 或成长功能。所有反向调用经既有 Main/Core 权限链，不开放任意 RPC。
- [ ] 准备人工检查清单：中文 IME、VoiceOver、Retina/缩放、多屏（具备时）、外观、系统链接唤起、⌘W/⌘Q、睡眠/唤醒及草稿恢复。记实际包 SHA 与测试者；无法执行保持 NOT_RUN，不代填通过。
- [ ] 准备具名设备和连接的非秘密准入记录，未知字段明确 UNCONFIRMED。不得往 public 仓库写家庭地址/IP、账号邮箱、Token 或设备码；私有接入细节保留在批准的私有配置。
- [ ] 在既有可用 Mac CI 运行实际包的自动化与 canary 场景，输出可复验材料及剩余人工清单；这一步不自动连接用户 Mac，也不把标准 CI 当成已具备嵌套 VM。

## 9. B1 — 真实 Mac/VM/隔离内无账号初始化

**进入条件：** 已有对应 Mac 所有者的明确操作授权；预检许可与安装/VM 启动许可分开记录。此前仅建议的 Mac mini 不能自动视为已同意。A3 代码与 bootstrap 来源已审查。

**执行与验收：**

- [ ] 先在批准范围只读探测 OS/CPU、内存/磁盘余量、工具链与虚拟化能力，输出脱敏报告。只有进一步获准才下载镜像、创建磁盘、设置 helper 或启动 VM。
- [ ] 在批准的专用目录建立最小 VM 与 Node，验证 bootstrap→环境安装→Runner 连接顺序。使用合成资料做挂载、资源和网络正/负向对照，关闭环境保留 Bot 私有数据。
- [ ] 在无认证 HOME、环境白名单和禁止模型出站的 Sandbox 中执行固定版本 CLI 初始化；不创建 turn、不触发登录、不发模型请求。记录版本/schema/transport 等无秘密证据。uid-map 再失败就提交日志和缺失能力，不宿主降级。
- [ ] 运行 `tests/integration/sandbox.test.ts`、`provisioning.test.ts`、`enforcement-negative.test.ts` 的适用场景；缺许可、不支持或未跑的场景不能合并为整体通过。
- [ ] 用同一实际包补人工 Mac 项，按单项 PASS/FAIL/NOT_RUN 记录。硬条件未通过时不进入真实模型调用。

## 10. B2 — 具名 Connection、真实审批与连续 Task A/B

**进入条件：** B1 对应环境通过，A2/A4 的选定路径就绪，A5 oracle 先于任务可运行；用户已明确批准账号用途、认证/计费、数据范围、节点、模型和调用限制。真实认证适用性按当时官方资料和实际版本核验，引用已有设计的官方入口，不凭此文宣称获得厂商许可。

**准入记录必须包含：** validationTargetId、connectionId、使用主体/用途、认证方式、账单来源及证据等级、允许项目/节点/模型/路由、调用/时长/费用可执行限制、撤销方式、备用策略。原始账号标识或秘密只在私有配置，public 文档用非秘密引用。没有确定额度/限制时不开展自动真实调用；无法精确限制费用时如实说明并取得相应批准，不承诺“必定零费”。

- [ ] 用户在适用官方流程完成授权；检查实际生效认证。清除冲突继承配置不是删除用户原始账号，而是使用隔离进程配置。订阅不可用不自动切 API，网关不可达不绕过。
- [ ] 用真实 CLI 验证一条精确审批的未答、拒绝、批准及迟到批准；独立观察目标效果。必须拒绝的危险动作放在受控合成测试目标，不能以测试名义访问真实私人数据。
- [ ] 回验 environment/runner/runtime/auth readiness；Task A 与 B 的上下文/连接/Grant 固定并在真正发出动作前复验。先运行 A、独立验收 A、回到 IDLE；保留环境后再运行 B 并独立验收 A+B。
- [ ] 验证同 bot_id、同逻辑 sandbox binding、同项目工作区和 A 的未提交修改得以保留；任务结束不 destroy、有效登录不每次重走。允许受控新 Session，不宣称隐藏上下文跨进程无损。
- [ ] 运行 `tests/integration/cli-approval-roundtrip.test.ts`、`persistent-bot.test.ts` 及实际包 `task-journey.spec.ts`。报告只有用户选定路径的 live 结果，其他路径保留 NOT_RUN。

## 11. B3 — 真实故障、备份与 P1 退出

**对应：** P1-05；GATE07/08/10–16/19/20。

**文件：** 新增 `tests/integration/{recovery,backup,enforcement-negative}.test.ts` 及 `docs/validation/p1-report.md`；复用已有 recovery、catalog、Connection 与审批断言。

- [ ] 配正向对照后做负向验证：讨论对项目的写入失败；禁用出口的 canary 不到达已正常运行的接收端；跨 Bot 无法读认证缓存；撤 Grant 后新动作被拒。用合成秘密，不外发真实资料。
- [ ] 杀掉父进程而留下可写子进程，确认不能释放槽位；处理 Runner/Core 崩溃、ACK/响应收据丢失、重复/乱序事件、磁盘或 spool 满、断网、取消迟到响应。不能重做未知外部副作用。
- [ ] 在获准测试窗口验证 App/VM 正常重启与恢复；执行期间的睡眠/强退需要用户同意，不能扰动用户其他工作。暂停后续派工、取消 Task、停止环境与清除数据不同。
- [ ] 一致备份 SQLite 和受控工作资料，普通包排除 auth canary；在干净验证目标恢复并重新核对授权，旧节点或旧租约不能复活。普通迁移不复制原生订阅 Token；需要重新登录时如实提示。
- [ ] 运行当前完整回归、实际包及选定 live 用例，汇总同一 candidate/契约/平台的证据；P1 报告列 PASS/FAIL/BLOCKED/NOT_RUN、未支持路径、已知限制和未关闭人工项。只有必需门禁具证据才宣称 P1 完成，否则交付实现并写清未通过项。

## 12. 命令契约：存在的可用，未实现的先创建

当前基础命令来自 `f27b8b1` 的 package.json；实际使用前核对最新脚本。不要把未定义的命令写成已运行。

```sh
npm ci
npm run typecheck
npm test
npm run build
# 仅在已获准且具备条件的 macOS 环境：
npm run package:mac
AN_PACKAGED_EXECUTABLE='<out/package-evidence.json 中的 executable>' npm run test:electron
AN_PACKAGED_EXECUTABLE='<同一 executable>' npm run test:mac
git diff --check
```

上面路径占位是操作者从实际证据文件取值，不是声称已有用户机器路径。现有 Node/依赖不全时先报告环境，不以测试命令缺失算通过。新增定向逻辑测试使用 `npm test -- <明确文件>`。

A 阶段增加集成测试时，可建立 `test:integration` 与专用配置，但必须默认排除真实模型调用。运行 live 模式须显式读取受保护的目标/授权配置，普通 PR/默认 CI、`npm test` 和 P0 演示启动绝不自动寻找真实账号。live 缺授权必须明确 BLOCKED/非成功退出，不能 silent skip 后整体绿灯；合成数据模拟子集继续可独立执行。未选验证路径在报告保留 NOT_RUN。

新增脚本依赖属于实现变更，需锁文件、来源审查和定向回归；本任务书提交不安装依赖、不触发真实认证。Mac CI、P0 人工、P1 VM 与生产签名始终分别记录。

## 13. 交付物、验收与首条回执

**每个任务的代码交付闭环：** 目标失败测试 → 观察失败 → 最小实现 → 定向及受影响回归 → 独立差异审查 → 小提交。公共模块变更后跑全套回归；不能用旧测试数替代当前结果。评审者在对应文件/候选读代码和证据，不只看 worker 自报。

**必须提交的材料：** 实际代码和测试；必要的数据库迁移；Mac/Connection preflight；固定 Task A/B 项目与只读 oracle；live-ready 的脚本入口；`p1-report.md` 与 Issue #1 的阶段回执。不再写一份重复总体设计，不把测试路径表当测试结果。

结果最小键：`requirement_id × stage × evidence_kind × runtime/version × platform × candidate_digest`，附设计 revision、命令/退出码、oracle/契约摘要、日志/产物引用、脱敏授权引用。原 165 项及 GATE01–20 不删除、不整体批量标 PASS；同一项 fake/离线/live/人工分别记。

**P1-A 交付定义：** 可用的代码与无账号验证材料已提交，异步 Core/Runner 接线、审批通路、Provider、AuthAdapter、独立 oracle 和桌面状态具对应测试；Mac/真实账号缺口明确列出。这不等于 P1 完成。

**P1 最终交付定义：** 获准的真实 Mac Sandbox + CLI/Connection 跑通 Task A/B，独立验收通过；真实审批/隔离/取消/恢复门禁通过；必要人工项有实际证据；无静默账号或费用切换；Bot 与长期工作区仍可继续接任务。未选的其他 CLI、网关、平台与生产发行不因此自动通过。

super bot 首条回执在 Issue #1 留下：已读取此文件及实际 SHA、复用模块与新增任务映射、按现有授权可先做的 A 项、缺少的具名设备/账号批准。设备和账号缺口集中列一次，不向用户索要仓库已有设计；后续每个切片提交证据及剩余阻塞。写入 Issue 不等于已向另一聊天发送主动消息，阅读完成须由接手者回执确认。

本文只把下一步安排落到可执行任务，不将任何未确认设备、账号、计费、测试或产品能力写成事实。

**任务书结束。**
