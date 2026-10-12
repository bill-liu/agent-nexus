# P0/P1 执行门禁与补充验收

修订日期：2026-10-13。配套 [实施计划](p0-p1-implementation-plan.md)；落实 Issue #1 第二轮审查 F01–F05。原 [165 项映射](v1.3-acceptance-map.md) 与 [CR01–CR13 历史评审](v1.3-design-review.md) 保留。本文是可执行规格，不是产品测试报告。

## 1. 使用方式、状态与分工

用户已允许 super bot 开发 P0，并允许并行修正文档；不需要因为本文再次暂停无账号 P0。真实 Mac 接入、登录、模型/费用与 P1 联调仍按具名目标及授权准入。不能把写完本文当成这些前提已经满足。

读取基点：`e7cd9797a6933761a84d06965285e461fe59ba3b`。已有 [P0 报告](../validation/p0-report.md) 与 [CLI 审批契约](../validation/cli-approval-contract.md)。报告包含 P0 自动化证据与未关闭门禁；本次没有重跑测试。已有离线 schema/审批持久化逻辑可复用，真实 CLI/网络/进程链不能凭离线测试判定通过。

文档修改者不改业务代码、依赖、CI、既有验证结果；实现者将本门禁映射到实际模块，按缺口补齐，不创建第二套审批/队列系统。阶段报告记录 requirement_id × stage × evidence_kind × runtime × platform × candidate，不以一个总开关抹掉未执行路径。

## 2. F01：环境启动、真实 Runner 与独立验收的依赖

### 2.1 分离三次准备，避免互相等待

| 准备 | 负责步骤 | 输入 | 成功只能证明 |
|---|---|---|---|
| VM bootstrap | P1-01 第一小步 | 已获准来源/许可的镜像或可重建配方、digest/签名依据、os/arch、磁盘/资源、Node 通道 | VM 与最小执行探针可运行；不是 Bot 可接任务 |
| 环境安装 | P1-02 | bootstrap 已可用、固定目录 manifest、缓存/下载通道、Bot ID/operation ID | 所需文件与环境状态可恢复；stub 不等于真实 Runner |
| Bot readiness | P1-03 后回验 P1-02 | 真实 Runner/Driver、health/version/protocol、适用 auth 与 ConnectionGrant | 首个真实任务的环境/运行时/授权准入均满足 |

第一份 bootstrap 材料不依赖完整 Resource Server 上线；可从已核实的官方分发材料或经过验证的本地构建配方取得。必须记录实际来源与构建/验证过程，而不是写一个待替换 URL 后视为通过。公共包不含用户秘密、账号缓存或私有资料。许可不足时不再分发 CLI，使用获准安装路径且固定版本。

建议 readiness 分别保存 `environment_ready`、`runner_ready`、`runtime_ready`、`auth_ready` 及对应版本。无认证任务可以按适用规则不要求 auth，但不得借此绕过会调用模型的工作。下载完成只能推进环境字段，不能设置整个 Bot READY。失败重试使用已有 Bot/operation，不重复创建实例。

### 2.2 最小 Verifier 前置到 P1-03V

P1-04 不能同时负责生成结果又自行认定结果合格。P1-03V 提前建立最小独立 oracle：由可信测试端选择固定断言，在隔离验证目录/只读快照或独立验证 Sandbox 中运行；不依赖开发 Bot 的自然语言结论或它写出的 PASS 文件。

每个验证绑定：`candidate_digest`、`task_revision`/验收契约版本、输入 manifest、验证器版本、允许的命令/断言、OS/arch/能力、开始结束记录和证据摘要。执行完再次核对候选未漂移。可使用固定脚本，不必先建完整的 P3 多 Agent 验证平台。

Task A/B 的初始测试项目、预期文件/功能和反例在首个真实调用前确定。允许未提交变更，但必须先生成精确文件清单和内容摘要/快照，不能一边被改一边验证。错候选、旧验收、报告篡改、缺平台能力必须拒绝。仅进程退出或仅文件存在不能证明功能正确。

VM readiness、最小验证器和两项任务均应使用各自可追踪 operation，P1-05 再汇总故障/备份回归，不能先将 P1-04 标完成再补验收依据。

## 3. F02：CLI 原生请求的双向审批链

### 3.1 复用与真实边界

已有离线映射采用固定 Codex 版本生成的 schema；以 [协议记录](../validation/cli-approval-contract.md) 和 `tests/fixtures/cli-approvals/` 为准。本门禁不把线上文档的新字段无条件加入旧 schema，也不要求再次创建等价 ApprovalService。版本升级须重新固定契约。

P1 Driver 必须把 CLI 发起的审批视作需回复的原生 RPC，而不是普通日志：

```text
CLI server-request
→ Runner 校验 schema，并登记当前活进程/transport/request
→ Core 校验作用域，创建或取得唯一 pending Approval
→ UI 显示准确命令/文件变化/目的地及范围
→ 用户在可信交互中批准或拒绝
→ Core 重验当前 Run/Turn、Grant/政策、参数和期限
→ Driver 仅回复原 transport 上仍有效的原请求 ID
→ 原生 resolved/终止/过期与实际效果分别回传
```

结构化用户补充输入不是权限审批；输入回答不能自动转换成批准，权限请求也不能被当普通聊天自动回答。涉及敏感值的补充仅走专用受限通道，不能进入普通日志或训练数据。

### 3.2 最小关联和状态

持久关联至少包括 `approval_id`、`run_id`、原生 thread/session/turn、`binding_generation`、`transport_instance_id`/可证明的进程代际、原生 typed request ID、动作/完整参数摘要、task/context/candidate、connection/grant revision、过期时间、操作者来源。

原生数字 ID 与字符串 ID 不混同；原生请求 ID 只在对应 transport/进程代际内有效。读取请求时若没有完整动作证据，先等待已知原生事件或阻塞；不得凭显示摘要猜测将执行的命令。文件审批需将实际变更证据与同 item/thread/turn 关联。

分别记录：收到请求、等待人、决定已持久化、响应待交付、响应交付状态、原生已解除等待/失效。批准、单次消费、RPC 送达、工具执行和任务验收不是同一件事。`resolved` 只证明原生请求生命周期，不能当作业务效果 PASS。

### 3.3 重连、取消与崩溃

Core 持久化决定及响应收据后可能在发回前崩溃，无法用一次数据库事务覆盖原生进程的外部效果。只有证明原来 transport 对应的请求仍 pending，才能重发同一已存响应；不能据旧 receipt 新建工具执行。

CLI 已重启、Turn 中断/取消、租约/Grant 撤销、请求 resolved/过期、内容变化或代际不符时，旧批准失效。不能把旧 ID 绑定到新 Session。无法证明是否执行则标 UNKNOWN 并对账，不自动重复动作。

拒绝/取消使用固定版本支持的正确响应，未知方法/字段或无法收窄的授权范围默认阻塞或回明确拒绝。禁止自动 `acceptForSession`、policy amendment 或把一个网络目的地批准描述成一个精确请求的授权。UI 不能通过“信任此 Bot”绕过这些边界。

### 3.4 回调不是完整安全边界

某些 CLI 行为不会触发审批回调。一个获准 shell 命令可能启动子进程或产生多次网络/文件副作用。因此 P1 必须另外验证真实挂载、工具、出口和进程限制；不能声称 ApprovalService 已经对全部 CLI 内部动作逐次中介。

## 4. F03：Mac 验证目标必须具名，但不自动接入用户电脑

在 P1-01 实际 VM 操作前，形成 `docs/validation/mac-target-preflight.md` 或等价现有记录；在凭据/账号操作前再完成 P1-00。以下没有实际证据的字段保留 `UNCONFIRMED/BLOCKED`，禁止填假机名、假连接或假可用时间。

| 项目 | 必须记录的内容 |
|---|---|
| 目标 | 具名 `validation_target_id`，机器用途、所有者/负责验证的人；敏感网络细节放私有配置，不入 public 仓库 |
| 系统 | 实际 macOS、CPU/架构、内存/磁盘余量，工具链与 Electron 包摘要 |
| VM | 实际验证的虚拟化能力、镜像/内核/bwrap、helper entitlement/签名要求、资源限制和失败证据 |
| 交互 | GUI 会话方式，IME/VoiceOver/外观/显示器/睡眠测试由谁完成，自动与人工分别记 |
| 授权 | 允许执行的探针、目录、安装/修改范围、网络与时限、停止/清理方法 |
| 接入 | 可用条件和接入方式已确认；不默认安装常驻 runner、打开公网端口或申请付费机器 |

开发包 CI 只证明该 job 实际执行的打包与 GUI 自动化。现有标准 arm64 CI 未被本项目验证为可用嵌套 VM 目标，不能据此关闭 Mac 本机执行门禁。不要为方便把 Linux bwrap 成功标成 Mac VM 成功。

缺目标时允许 P0/fake/通用逻辑继续，P1 实际 VM/人工项明确 BLOCKED。已经记录的 P0 自动化结果不删除，也不扩大其覆盖范围。

## 5. F05：早探针和 Runtime/Auth 用途分别判断

P0 首选 CLI 探针拆成：版本/离线 schema；隔离内无账号初始化；Mac 嵌套执行与实际交互。前两个也不能绕过当前 Sandbox 限制：已知 bwrap UID map 阻塞时保留失败，不改为宿主机启动 Agent 会话。禁止无意创建 turn、继承 Key、触发网页登录或模型请求。

Runtime/Auth preflight 分别列：本地个人验证、本地开源发行、商业/托管形态。对每条记录当前官方证据、版本、用途、允许的认证接口和有效期；不能把某一种商业接入的待审核条件套给所有个人路径，也不能把本地可运行推导成商业许可。本文不代替厂商现行条款审查。

真实 Connection 清单：具名 ID、用户选择的账号/工作空间、认证方式、账单/订阅来源及证据等级、direct/gateway/local 路由、模型/端点、节点/项目/Bot 范围、数据处理规则、调用/费用约束、备用策略。原始 Key/Token/设备码不写进 public 记录。

默认 no fallback 或 ask_user；网关不通不直连，订阅不可用不切 API。安全预算无法精确观测时标明可执行的硬限制与费用估算，不能只写一个金额字段就承诺零超支。许可/认证证据未知仅阻塞该路径；允许未选其他供应商保持 NOT_RUN。

## 6. F04：硬约束—执行点—负向证明

这些检查使用无秘密 canary 和受控测试接收端，不发送真实私有资料。负向用例必须配允许路径的正向对照：否则“接收端本来就坏了”“工作区根本不可用”会被误认成成功拦截。

| 硬要求 | 实际执行点 | 负向证明与限制 |
|---|---|---|
| Discussion 不写项目 | 只读挂载/工具能力、运行时配置与最小授权 | 经 shell/工具尝试写项目被拒绝；正常读成功。不要用命令名字判断只读 |
| local-only 不外传 | Context/连接选择，加 Node/Sandbox 网络出口和受控工具 | 云连接启动被拒；绕过 Resolver 的直接请求仍失败；受控本地允许请求成功。验证摘要/Embedding/子工具均在规则内 |
| 网关强制 | 网络出口只能到已批准网关/目标，网关逐请求验 Run/Grant | 网关断开后直连上游失败；不能用返回一个 resolver 错误当作出口证明 |
| 撤销即时限制新动作 | Core 最终启动检查、网关/工具逐请求检查、必要的进程中断 | 准备后撤权、新请求被拒；已发出/完成的外部请求保留事实，不能宣称撤回 |
| 不出现第二写者 | Node/Runner 进程树、写槽位、fencing/代际 | 父进程退出但可写子进程仍活时禁止放槽位；确认隔离或退出后才可重派 |
| 原生凭据不跨 Bot | 独立 Home/缓存/挂载与权限域 | A 无法读 B 的合成认证 canary；不能声称同 UID 内 CLI 和所有工具隔离了原始 Key |
| 认证方式准确 | 干净环境/config、官方状态检查、Connection snapshot | 放入冲突测试配置使 auth 不符时启动被拒，不借用其他凭据；记录来源等级，不伪造账单验证 |
| 无回调动作仍受限制 | 文件/网络/工具的真实控制面 | 即使不经过审批请求，越权写/出站也被实际阻断 |
| 普通导出无秘密 | 专用导出清单、日志脱敏与敏感备份路径 | auth caches、环境转储和 canary 不进入普通包；完整 VM/内存备份按含秘密处理 |

网络规则同时考虑实际可用的地址族、DNS、重定向/代理行为和批准目标；只把变量名设为 localhost 不算隔离。具体机制由受测 Provider 能力决定，不能实现时不开放对应策略承诺。

## 7. 补充验收 GATE01–GATE20

原 165 项保持不变；下面 20 项把实施缺口落实为具体证明，不代表多出了 20 个已存在的自动测试。以下真实/人工结果全部为 **NOT_RUN（本次未执行）**；已有 P0 相关证据可引用，但不能自动升级为 live PASS。

| ID | 原要求/审查关联 | 场景与通过条件 | 步骤/证据层 |
|---|---|---|---|
| GATE01 | F01，R06/R08/M08/UX16 | 在 Task A 前独立 oracle 已可运行；错候选、旧契约、Bot 自产 PASS、篡改报告与缺平台能力均被拒 | P1-03V；contract + 独立真实验证 |
| GATE02 | F01，B01/D03/UX52 | bootstrap → 安装 → 真实 Runner readiness 可追踪；stub 不报真实就绪，中断重试保持同 Bot/operation | P1-01/02/03 回验；真实 VM/安装 |
| GATE03 | F02，I01/UX17 | CLI 发起精确权限请求，UI 未答前工具不执行；原始请求 ID 与 Run/Turn 可关联 | P1-03；真实 Driver/效果观察 |
| GATE04 | F02，R07/UX17 | 用户拒绝后收到原生正确响应，目标文件/进程/网络效果未发生，任务可解释阻塞 | P1-03；真实拒绝 |
| GATE05 | F02，R04/UX18 | 精确批准只解锁对应动作；改参数、改候选、重复消费均失败 | P0-03 映射 + P1-03 实际效果 |
| GATE06 | F02，I03/UX11 | Turn 中断/Task 取消后迟到批准无效，不能恢复旧执行 | P1-03/05；真实取消竞态 |
| GATE07 | F02，R01/R02/R05 | 响应收据后断连，只对可证明仍 pending 原请求补传；不创建第二操作；状态未知先对账 | P1-03/05；传输故障注入 |
| GATE08 | F02，R04/C15 | CLI 重启、错 transport/generation/Turn/typed ID 拒绝旧响应；resolved 后不再重放 | P1-03；真实进程与关联检查 |
| GATE09 | F02，R07/C16 | 未知方法/字段/扩权、无法收窄的会话或网络批量授权不自动放行；普通输入不当权限批准 | P0-03 + P1-03；固定 schema/live |
| GATE10 | F04，A04/A05/CR04 | Discussion 正常读取成功，shell/工具对项目写入实际失败；不是仅 UI 禁编辑 | P1-01/03/04；真实文件隔离 |
| GATE11 | F04，A03/UX58 | 受控接收端正常时，禁用外发仍无 canary 到达；允许本地路径成功；覆盖摘要/Embedding/子工具及出口 | P1-01/04；真实网络 |
| GATE12 | F04，C09/C19 | 准备后、派工前撤 Grant 拒绝启动；运行中撤销拒新请求，已发送动作单独记录 | P1-03/04；真实网关或工具边界 |
| GATE13 | F04，R03/I03 | 父 CLI 停而子进程仍可写时不能释放槽位；隔离/退出确认后才允许下一写者 | P1-01/03/05；真实进程树 |
| GATE14 | F04，C08/C11 | A 不能读取 B 的合成 auth cache；日志/普通导出无 canary；同权限域原 Key 风险如实说明 | P1-01/03；真实缓存权限 |
| GATE15 | F04，C07/C20/UX68 | 冲突 env/config/auth 状态导致 AUTH_MODE_MISMATCH；实际来源未知不伪装已验证订阅 | P1-00/03；受控配置负向测试 |
| GATE16 | F03，M06/M08/UX28 | 具名 Mac 目标、所有者授权和实际 VM/GUI 能力有记录；IME/VoiceOver/睡眠为独立人工结果 | P1-00/01/05；真实/人工 |
| GATE17 | F05，C01/C02/C16 | 用途及具名 Connection/费用/资料/节点准入齐全；未知只阻塞对应真实路径，不阻塞 fake P0 | P1-00；授权记录+静态/实际分别记 |
| GATE18 | F05，E12/CR06 | 无账号初始化仅在获准 Sandbox 内，无继承认证、无 turn/模型调用；失败不宿主降级 | P0-00/P1-01；隔离探针 |
| GATE19 | F02/F04，R07/A03/C06 | 没有审批回调的内部/工具动作仍不能越权写入或绕过网关出站 | P1-01/03/04；真实执行点 |
| GATE20 | F04，R10/C08/CR12 | 普通备份/迁移不含 auth canary；敏感 VM 备份受单独授权；恢复后旧授权/旧写者不被自动复活 | P1-05；干净恢复 |

建议测试入口（实现时可映射等价现有文件，不要求空建目录）：

- P0 复用 `tests/contract/approvals.test.ts`、`cli-approvals.test.ts`、`runtime-policy.test.ts`、`connections.test.ts`、`context.test.ts` 与 recovery 测试。
- P1 补 `tests/integration/cli-approval-roundtrip.test.ts`、`enforcement-negative.test.ts`、`provisioning.test.ts`、`evidence.test.ts` 和 `persistent-bot.test.ts`。
- Mac 能力和人工步骤记录在 `docs/validation/mac-target-preflight.md` 或等价现有文件；最终结果入 `docs/validation/p1-report.md`。

文件名是实施契约建议；未实现时 NOT_RUN/NOT_IMPLEMENTED。运行命令先在 package.json 创建/验证，当前没有 test:integration 时不能伪造通过。

## 8. 完成判定、同步与参考

F01–F05 的“文档处理完成”只意味着本计划明确了依赖、协议、执行点和验收；真正关闭技术缺口须引用相应候选、命令、平台及效果证据。主 Issue 回复时分别说明“已写进计划”“P0 已有证据”“P1 仍待实测”。

保留已有 P0 成果，不把新文档当成要求返工所有已通过场景；变化影响的场景补回归即可。super bot 在下一次拉取或读取 Issue #1 时能发现本文件，不声称它已主动收到或读完。提交不改变账号、费用、节点权限或产品发布范围。

文档依据为仓库 v1.3 设计、Issue #1 审查、实际 P0 报告与固定 CLI schema。外部能力和许可入口沿用 [技术设计参考](../design/v1.3/technical-design.md)；真实接入前按当时官方资料和目标版本核验，本文不新增未经验证的厂商许可或性能结论。

**文档结束。**
