# P1-B 准备与推进计划

> 给 super bot / supper bot：复用现有 P1-A；使用 `superpowers:executing-plans` 按切片推进。延续最近报告中的单路集成方式，不默认增加并行模型任务；关键复审可独立、串行完成。本文不是新的总体架构。

**Goal：** 从已验证的 P1-A 代码候选出发，关闭关键复审与首次安装缺口，在一个获准 Mac/VM 和一条获准 Connection 上完成 Task A/B、真实审批、隔离与恢复验收。

**Architecture：** 沿用本地单 Core、长期 Bot Sandbox、Node/Runner/Codex Driver、固定 Context/Connection 快照和独立 oracle。Resource Server 不接管账号或任务。不新增第二套状态机、审批或验证服务。

**Tech Stack：** 沿用当前 TypeScript/Electron/React/SQLite、Swift Virtualization helper、guest Node/systemd/bwrap 和原生 JavaScriptCore verifier；固定版本仍以锁文件、协议 fixture 及目标环境实测为准。

**Spec：** [v1.3 技术设计](../design/v1.3/technical-design.md)、[交互设计](../design/v1.3/interaction-design.md)、[P1 任务书](p1-task-brief.md)、[执行门禁](p0-p1-execution-gates.md)。本计划只排序剩余工作，不取代既有验收条件。

**核验快照：** 2026-10-13，读取 main `f709381b54178c365dab7d252b0a9b1678087b1e`；代码候选 `2b187c74fea7b91d9cc30508197c78cb00b6dd5b`。依据 [P1 报告](../validation/p1-report.md) 及对应 CI 作进度核验，本次没有重跑产品测试，也未完成新一轮独立代码安全审计。

## Global Constraints

- 本次用户授权是核查进度、规划下一步和重写 README；不由此推导 P1-B 的设备接入、安装、登录、模型调用或费用授权。
- P1-A 无账号实现已有批准；在原范围继续补代码和合成测试，不重复询问已确认产品方向。设备和账号缺口集中一次列出。
- 只做单 Bot、单一首选 Codex 路径；先不扩展其他 CLI、模型市场、完整无人值守安装器、P3 编排或 P4/P5 学习。
- 所有 Agent CLI 留在 Sandbox 内；不能因 uid-map 或平台限制退回宿主执行。未获准的用户 Mac、账号和私有资料不自动连接、读取或配置。
- 默认不订阅转 API、不绕过网关、不扩大资料处理范围。准备界面的 local-only 资料不自动改为允许云模型处理。
- Task 完成不销毁 Sandbox；CLI 退出、Node 停写、Task 验收分别取证。已有失败历史与待验收项不删除。
- 安全规则可通过设计变更审查改进，但不能为使 CI 变绿而默默削弱。合成正反例不等于任意不可信代码安全。

## Review Focus

1. 关键原生代码已修改但未独立复审：先针对 A2 后续修复、A3 生命周期、A5 新验证边界复核，再引入真实凭据或未知候选。归属 N1。
2. 只支持已安装 guest，却将“有准入配置”误当完整安装：先补可复现的受监督准备流程，再做 readiness 正向验证。归属 N2/N3。
3. IP 级出口不等于域名/端口/请求限制，订阅登录与模型端点的实际需要可能不相容：选定路径必须实测，不能放宽为全网。归属 N3/N4。
4. helper/CLI 父进程退出而子执行仍存活：同主机启动内崩溃不允许双写或自动重跑。归属 N1/N5。
5. 验证器没有硬物理内存上限、快照有 160000 字节界限：评审并声明可用范围，超限阻塞，不让 B 的证明覆盖缺失能力。归属 N1/N5。

## 1. 当前基线与判断

P1-A 的 A1–A6 代码、准备界面和无账号材料已提交。已验证代码候选：逻辑 43 文件/525 项，Electron 11 项、Mac 自动化 9 项，原生 verifier 15 个固定合成对照，Swift helper 7 项策略测试及编译通过。详见原报告和 CI；数字绑定候选，不是所有未来提交的结果。

尚未完成：A2 压力修复、A3 完整链路和 A5 原生版本的独立复审；真实 VM/guest/CLI 初始化；真实登录及 Task A/B；人工 Mac 检查。当前 Mac/Connection 准入表仍是 UNCONFIRMED。没有证据说明仅缺一个 API Key，不能把代码交付表述为真实 Bot 已可用。

当前实现还声明：受监督安装而非无人值守首装；同主机启动内 helper 崩溃后保留 UNKNOWN；IP 级网络限制；无每 Bot 文件系统配额；verifier 硬物理内存上限未证明。先判断每项是否影响本次具名路径，不将所有后续平台能力变成无限前置，也不默默从总体验收删除。

## 2. 下一步顺序

```text
N1 关键复审收尾 ──→ N2 可复现首装与接入准备
                         ↓ 设备操作批准
                   N3 真实 VM / 无账号链路
                         ↓ 具名 Connection / 数据 / 费用批准
                   N4 登录、真实审批与最小正常调用
                         ↓
                   N5 Task A/B + 停止/恢复 + 独立验收
                         ↓
                   P1 退出报告；再评估 P2
```

N1/N2 的无账号工作可按既有批准继续。当前优先获得单一路径的正向运行证据，不再以增加大量模拟分支替代实际联调。若某个设备验证阻塞，继续其他有明确依赖边界的无账号工作；阶段状态保持准确。

## 3. N1 — 收尾关键复审，不重写 P1-A

**读取范围：** `apps/runner/`、`apps/node-agent/`、`packages/execution/`、`packages/core/src/p1-installed.ts`、`native/macos-sandbox-host/`、`native/macos-verifier/` 及关联测试。先查最新 diff 和 [P1 报告](../validation/p1-report.md)，锁定尚未独立复验的变更，不重新审完所有 P0 文件。

**输出：** 新增 `docs/validation/p1-critical-review.md`，每项注明文件/候选、威胁或失败条件、复现、结论和证据；自审与独立复审分栏。修复只改相关实现和测试，引用已有 GATE 编号。

- [ ] 复核 A2：spool 满、终态持久化、断线后同一 pending RPC 回复、撤权/取消期间 owned cleanup；不能重放到新 transport。
- [ ] 复核 A3：helper 私有通道与描述符生命周期、Node cgroup 停写证据、同一主机启动中的 helper 崩溃和旧进程隔离；UNKNOWN 时拒绝新写者。
- [ ] 复核 A5：候选 stdout 伪造是否不再影响可信判定、宿主桥隔离、intrinsics 污染、超时/输出/快照限制。确认原生 verifier 的硬内存限制缺口对所选路径的影响及受控方案；未满足要求时只运行固定可信合成对照，不把任意模型生成代码送进未审查路径。
- [ ] 发现问题先新增可失败的回归，观察失败，再最小修复并重跑受影响集合；没有发现新问题也只写实际覆盖的范围，不宣称通用安全。
- [ ] 以一个固定候选提交代码/复审结果，更新 P1 报告引用。Critical/Important 未解决项阻塞对应 live 路径，不阻止无关文档或普通逻辑工作。

### N1 本轮收尾回执（追加，不改历史快照）

代码候选 `43b7e644e30e387b3c608d9ce29b4956db4d8cb5` 已取得536逻辑/11Electron/9Mac、15原生固定对照、7helper和smoke同SHA CI成功。A2/A3/A5按GPT6.1-SOL high串行独立收尾，具体覆盖、失败历史与有限闭环见 [关键复审记录](../validation/p1-critical-review.md) 和 [P1报告](../validation/p1-report.md)。N1审查收尾不解除same-boot恢复、硬RAM、实际隔离/网络/具名授权门禁；N2及B尚未启动。最小脱敏授权资料集中在记录末尾的表，不因填表推定强制能力已满足。

## 4. N2 — 把首次安装从说明拼成可复现路径

**复用文件：** [BOOTSTRAP.md](../../native/macos-sandbox-host/BOOTSTRAP.md)、`scripts/mac-vm-preflight.mjs`、`scripts/prepare-vm-disk.mjs`、`scripts/start-guest-node.mjs`、`apps/node-agent/src/enforcement-gate.mjs`、`apps/node-agent/src/vsock-bridge.py`。

**输出：** 新增 `docs/validation/p1-bootstrap-runbook.md`；按需补现有脚本和合成测试，不建立新的镜像市场或通用安装框架。安装操作仍等待设备授权。

- [ ] 固定一个首选 bootstrap 来源和准备方式。沿用已记录的签名/摘要/许可检查；磁盘格式转换、guest 依赖安装、rootfs、Node/gate/vsock 配置逐步对应输入、输出、执行位置和失败处理。
- [ ] 明确哪些步骤在开发/镜像准备环境，哪些在 Mac，哪些在 guest。private key/authority 不放公开示例；配置样例不可被误认为有效授权。
- [ ] 配置校验失败、中途停止、目标文件已存在、旧 operation 重试都不得产生副作用或清理无关数据。检查所有入口实际实现，不将只能 BLOCKED 的占位探针称为可执行安装流程。
- [ ] 有监督的首次安装可以作为首轮方案，不要求先建无人值守安装器；但需能在干净目标由相同步骤复现，不能只写“自行准备一台已配置机器”。
- [ ] 汇总 device、bootstrap、runtime、verifier、Connection 的相容要求，输出一个简洁的联调准入清单。真实 secret/backend/gateway 缺项按选定路径区分，不安装所有供应商。

### N2 本轮准备回执

[受监督首装runbook](../validation/p1-bootstrap-runbook.md)给出固定cloud盘→ARM64 Linux离线配置→Mac交接的单一路径、目录/配置、失败与已有目标行为。磁盘发布不覆盖新出现的目标，guest初始监听/policy/authority及管理journal准入在DB前校验。包级锁/BOM、验签、安装/UEFI启动未实际执行；桌面仍缺同一helper首次create/start接线且prepare入口绑定model.request；runbook列明initialize-only独立业务入口/准入映射的N3-0下一代码切片，另启helper不能绕过单写锁。N2文档/合成验证不意味着N3可立即运行；具名准备环境/Mac分项授权与实际实现/证据缺口分别保留。

## 5. N3 — 在获准 Mac 上先完成无账号正向链

**前置：** [Mac 目标准入](../validation/mac-target-preflight.md) 中的目标、所有者、操作范围和批准引用已落实。Mac mini M4 仍只是候选；此计划不代替授权。

**接口与输出：** 使用现有 Provider/Node/Runner 和 `BotProvisioner.adoptInstalled`，分别记录 environment/runner/runtime/auth readiness；更新原准入与报告，不新建另一套授权数据库。人工项使用 [现有清单](../validation/p0-manual-mac-checklist.md)。

- [ ] 先在批准范围执行只读 preflight，确认真实系统与虚拟化条件。只有获得安装/启动许可后，按 N2 准备磁盘和 guest。不得因标准 CI 编译通过而自动推定能在其中启动 VM。
- [ ] 跑通 helper → vsock → 私有 Node 通道 → Runner → 固定 Codex `initialize`。使用空认证目录、受控环境和禁止模型出站；不发起 login 或 turn。
- [ ] 用普通可信测试负载做实际文件/网络/进程正反例：允许读取成功、禁止写入失败、已确认工作的接收端收不到禁止出口 canary、父进程退出仍有子写者时不释放槽位。
- [ ] 检查 kernel/systemd/bwrap/cgroup/BPF 和当前 attestation 的实际字段。缺能力输出准确原因，禁止关闭隔离或改用宿主 CLI。
- [ ] 保存同一候选的日志、退出码、目标配置摘要和 readiness。得到无账号正向证据后才推进 N4；auth 仍保持未就绪，不能以初始化成功代替登录。

## 6. N4 — 只接一条明确授权的真实 Connection

**前置：** [Connection 准入](../validation/p1-connection-preflight.md) 已确定账号用途、计费来源、节点/项目、模型、route、资料流向和可执行限制。候选 `personal-codex-p1` 不自动成为有效连接；不向用户索要公开粘贴 Key/Token。

**读取/修改范围：** 现有 `packages/connections/`、Codex auth Driver、`packages/core/src/p1-admission.ts` / `p1-installed.ts` 及其测试；修复确有证据的单一路径不兼容，不建全部认证方式。

- [ ] 静态核验所选官方集成路径的当前适用条件；准备数据仅用公开/合成测试项目。需要云模型时显式批准该项目出站，不能把现有 local-only 资产整库改为可上传。
- [ ] 将所选模型/登录端点和网络约束逐一对应。当前 IP allowlist 不能宣称域名/端口或逐请求控制；若本路径要求的控制尚不存在，先补受测控制或保持 BLOCKED，不临时放全网。
- [ ] 在具名批准后走官方授权，核对实际 auth/账户来源。冲突环境变量或缓存拒绝；登录失败、额度不足、网关断线都不切换费用来源。
- [ ] 验证未批准、拒绝、批准、取消后迟到批准、重连等真实 RPC 往返；观察真实工具效果，不只看 SQLite 决策状态。
- [ ] 设置并验证能够实际执行的 Run/时长/并发/调用约束。不能用金额字段宣称硬费用封顶；未知部分显式写明并取得相应使用批准。无约束的循环重试不准入。

## 7. N5 — Task A/B 与 P1 退出

**复用：** [任务书 A5/B2/B3](p1-task-brief.md)、现有固定测试项目与 oracle、候选快照和 Evidence 机制。不得新造一个更容易通过的演示替代已有 A/B 契约。

- [ ] 先用已知正确/错误的合成候选确认 oracle 自身有效。运行模型生成候选前满足 N1 的验证边界审查及资源要求。
- [ ] 同一 Bot 完成 A：正常导出、独立验证、回 IDLE，保留未提交修改与工作区。B 必须在 A 的确切成果上继续输入/边界校验，重新通过 A+B 验证；只看文件存在不算成功。
- [ ] 验证快照未被截断且不超过当前 160000 字节协议界限；超过时明确阻塞，不减少验证内容后偷偷通过。
- [ ] 实测取消、App/Runner/helper 崩溃、断线和重启、旧授权/子进程残留、备份恢复；活动任务不得与替代执行双写。无损恢复未实现时说明安全停止和人工恢复路径，不假冒自动恢复通过，也不删除既有必需门禁。
- [ ] 必要人工 Mac 检查逐项记录；没有设备/操作条件的项目仍 NOT_RUN。每 Bot 磁盘配额和细粒度网关等未支持能力不得在 UI/报告宣称可用；影响当前强制要求则保持 BLOCKED。
- [ ] 形成同一候选的 P1 退出报告：已过门禁、待做项、实际数据/计费路径、资源限制、复审与 CI 链接。所有必需真实验证满足后才声明 P1 完成，否则交付已实现部分和剩余阻塞。

## 8. 已有验证命令与证据规则

以下入口在读取基点存在。默认命令不得触发真实凭据、VM 或模型；真实接入必须通过已实现的显式准入入口，不能假设 `test:integration` 已定义。

```sh
npm run typecheck
npm test
npm run build
git diff --check
# 仅在获准且具备条件的 Mac/CI 上：
npm run package:mac
export AN_PACKAGED_EXECUTABLE="$(node -p "require('./out/package-evidence.json').executable")"
npm run test:electron
npm run test:mac
swift build --package-path native/macos-sandbox-host
swift test --package-path native/macos-sandbox-host
node native/macos-verifier/canary.mjs
```

定向测试用当前实际文件路径执行 `npm test -- <file>`，先检查它不会意外调用真实环境。新的 live 测试脚本须显式 opt-in，缺授权非成功退出；普通 CI 中不因静默 skip 而宣布真实验证通过。

结果键沿用 `requirement × stage × evidence_kind × runtime/version × platform × candidate`。引用 GATE01–GATE20 及原 165 项，不再新增一批重复总指标。Linux/macOS 重复跑同一测试不相加成独立能力数量，提交后的 CI 不使用父提交包摘要冒充本次产物。

## 9. 向 Issue #1 的交接

super bot 先读取本计划、最新 main 和 P1 报告差异，继续已获准范围内的 N1/N2。首条回执集中列出：未完复审的负责人/范围、首装步骤及真实缺口、设备与 Connection 尚需批准的事项。设备信息和凭据留在受保护私有配置，公开 Issue 只放脱敏引用。

保留原来的单路集成和必要独立复审，不因新计划重复分派 A1–A6，不重新询问 Electron/Mac-only/长期 Sandbox/本地 Core 等已确认方向。一个小切片一份可复验结果；遇到主分支前进先合并并复核，禁止强推覆盖。

本次文档发布不启动上述 live 操作、不更改原报告结果；用户可直接通过仓库和 Issue 跟踪，无需搬运附件。

### 外部核验入口

环境限制以本仓库实际 preflight 和官方资料共同判断：[GitHub 托管 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。认证在真实接入前按当时官方资料复核：[Codex Auth](https://developers.openai.com/codex/auth/)、[App Server](https://developers.openai.com/codex/app-server/)。引用不表示本项目已获得商业认证许可，也不改变当前受测协议版本。

**计划结束。**
