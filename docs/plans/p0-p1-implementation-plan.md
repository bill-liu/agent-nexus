# AN v1.3 P0/P1 实施计划

**状态：待用户确认。本文提交不启动实施；所有任务框和产品验收均未完成。**

**Goal：** 先证明安全、可恢复的本地单 Core 桌面骨架，再让一个长期 Bot 在 Mac 管理的 Linux VM Sandbox 内，使用一种经确认的 Runtime/Connection 连续完成两次真实任务。

**Architecture：** Electron Main / 最小 Preload / Renderer / 独立 Core Worker；本地 SQLite 与文件为权威；Provider、Node、Runner 和 Driver 分层。Resource Server 仅公共分发。平台桥接从 domain/core 注入，不把模型、私有资料或调度移到公共服务器。

**Tech Stack：** Electron、TypeScript、SQLite 是 v1.3 方向；React、utilityProcess、SQLite binding、Vitest/Playwright、Electron 打包工具和 Swift VM helper 为待 P0-00 固定版本及验证的实施候选。没有现存依赖或工程可直接运行，当前不安装或生成它们。

**Spec：** [`b70301983334770ddaceb1706822e28ca47352da`](https://github.com/bill-liu/agent-nexus/commit/b70301983334770ddaceb1706822e28ca47352da) 的 [技术设计](../design/v1.3/technical-design.md) §01–28、[交互设计](../design/v1.3/interaction-design.md) §01–28、根目录 AGENTS 与[交接](../handoff/super-bot.md)。[设计理解/冲突/阅读记录](v1.3-design-review.md)和[完整验收映射](v1.3-acceptance-map.md)为配套文件。

**Global Constraints：** 本轮只写文档。实施前等用户确认；不自动登录、调用付费模型、选择许可证、购买服务、创建 secrets、签名或发布。普通专业 Bot 不获主分支合并/生产发布权。云端开发与编译不改变本地 Core；用户交互调试需要 Mac 时再接入，不自行转到用户电脑。CLI 不能因 VM 失败转到宿主执行。

**Review Focus：** 跨进程授权、一个写执行、未知副作用、同候选证据、秘密及账单不切换、持久环境、Mac 生命周期和设计 §25 与认证前置门禁的衔接。

## 1. 阶段、平台与顺序

| 阶段 | 产出与退出条件 | 明确不计入通过的替代结果 |
|---|---|---|
| P0 | 可打包 Mac 骨架、typed IPC、单 Core/SQLite、fake Provider/Driver、真实数据约束、资产/连接/下载最小策略测试；崩溃、幂等、恢复和无静默费用切换测试 | 浏览器预览、Linux 单测或现有 Swift smoke 不能代替 Mac Electron 骨架运行 |
| P1 | 第一种获准 CLI/Connection，真实 Mac VM+Sandbox，长期 Bot 的两次任务与停止/重启恢复；最小知识/Skill/规约、下载、认证、独立证据和 Mac 交互 | fake 任务、远程 Linux 运行、单次成功或进程可启动不能代替上述门禁 |
| P2 | 其他 Runtime、远程 Provider、人工接管、资源发布/升级/撤回及完整版本维护 | P1 为协议/约束打基础，不假称支持全部供应商或发行 |
| P3/P4 | P3 有界 Orchestrator、三 Bot、动态 DAG 和独立验收；P4 经验/Harness 证据与复用 | P0/P1 不做伪成长、伪重规划；P5 不属于 V1 基线 |

依赖：P0-00 → P0-01/02 → P0-03/04/05/06 → P0-07；P1-00/01/02 通过后才可进入 P1-03 的真实认证和调用 → P1-04 → P1-05。代码审查可以拆小提交，但每个阶段必须回到同一候选核对整体验收。

所有下面的文件均为**实施后拟新增/修改路径**，现在不存在。按纵向切片建必要文件，不预建所有服务空壳。验证先写能失败的场景，再写最小实现，运行对应测试，审查差异后提交；禁止靠降低断言、改变账号或扩大权限让测试变绿。

## 2. 实施时统一命令契约

P0-00 获准后建立以下脚本及锁文件，再执行下列命令。这里是拟议接口，不是本轮已运行命令；文件缺失或平台不符必须报告 NOT_RUN/BLOCKED，不能算 SKIP 后整体通过。依赖版本、npm 版本、macOS 最低版本和目标 CPU 在 preflight 中记录。

| 命令 | 预期用途 / 平台 |
|---|---|
| `npm ci` | 仅安装经 P0-00 评审的锁文件；干净 Linux/macOS 开发或 CI 环境 |
| `npm run typecheck` | contracts/domain/core/UI 的类型边界检查 |
| `npm run test:logic -- tests/contract/ipc.test.ts` | 拟用 Vitest；路径参数可替换为任务表所列 `.test.ts`；Linux 与 macOS，不依赖真实账号 |
| `npm run test:logic -- tests/unit tests/contract tests/recovery` | 可移植回归全集；故障注入使用 fake 时明确标注 |
| `npm run package:mac -- --arch=arm64` | 拟用 Electron 打包脚本，macOS 开发 `.app`，arm64 为首轮候选，最终跟 preflight 目标走；x64 若声明支持需独立验证 |
| `AN_APP_PATH='/absolute/path/Agent Nexus.app' npm run test:electron -- tests/electron-security/boundary.spec.ts` | 拟用 Playwright Electron adapter；启动实际包内可执行文件，校验包 digest，不启动开发服务器；macOS |
| `AN_APP_PATH='/absolute/path/Agent Nexus.app' npm run test:mac -- tests/macos-e2e/lifecycle.spec.ts` | 实际 Mac 包的生命周期/E2E；自动化之外需人工 IME/VoiceOver 记录 |
| `npm run preflight -- --profile runtime-auth --connection-id reviewed-connection` | 先只做静态/无调用检查；真实认证或花费步骤单独经授权启用，不在 argv 放秘密 |
| `npm run test:integration -- tests/integration/persistent-bot.test.ts` | 已批准的节点/连接及配额，真实两次任务；未获前置授权明确 BLOCKED |
| `swift test --package-path native/macos-sandbox-host` | 若选 Swift helper，macOS 原生单测；成功不等于 VM/helper entitlement 和签名发行已验证 |

CI 后续分 Linux 可移植检查、标准 GitHub-hosted macOS 开发包检查、需要实际 VM/交互能力的 Mac 验证。先探测标准 runner 的架构、虚拟化和 GUI 能力；不假设具备嵌套 VM，不买 larger runner。缺 VM/VoiceOver 条件保留待接入 Mac 门禁。现有 `toolchain.yml` 保持独立，不改名暗示产品通过。任何真实连接调用不进入无条件公共 PR CI。

## 3. P0：无真实模型的可信骨架

### P0-00 — 固定可复现的兼容性基线

依据：技术 §01/04/07/24/25；交互 §24/28。依赖：用户确认计划。

拟新增 `package.json`、`package-lock.json`、`tsconfig.json`、`electron.config.ts`（打包工具选定后命名）、`scripts/preflight.ts`、`docs/validation/p0-preflight.md`，及只为后续测试必要的配置。

- [ ] 先列失败矩阵：缺 Mac、Electron 内置 Node 与 SQLite addon ABI 不匹配、目标架构不符、helper/VM 不可用、Core 容器重启并存；每项都有可观察结果，未知不写可用。
- [ ] 小型隔离探针比较并固定 Electron/Node/SQLite binding、React、打包器、测试器及最低 macOS/CPU；验证 utilityProcess 可加载模块且环境白名单有效。性能目标按技术 §24 定义负载后测，当前没有结果。
- [ ] 记录标准 runner 可做/不可做的项目；选择首个开发包架构。探针不做产品功能、登录或模型调用。
- [ ] 在锁定版本的干净 Linux 和 macOS 执行 `npm ci`、`npm run typecheck`，Mac 打出最小开发 `.app`；记录版本、命令、artifact digest、退出码。不可验证则保留 BLOCKED，审查后提交最小脚手架。

### P0-01 — 单 Core 与最小 IPC 安全边界

拟新增 `apps/desktop/main/{bootstrap,ipc,windows}.ts`、`apps/desktop/preload/index.ts`、`apps/desktop/core-worker/entry.ts`、`packages/contracts/src/{commands,events}.ts`、`packages/desktop-platform/src/adapter.ts`。

- [ ] 先写 `tests/contract/ipc.test.ts`、`tests/contract/platform-boundary.test.ts`、`tests/electron-security/boundary.spec.ts`：陌生 frame/origin、超大/错误 schema、过期版本、无权限窗口被拒绝；Renderer 没有 Node、SQL、shell、泛用 invoke。
- [ ] typed 方法封装 command_id、scope、expected_version；Main 校验 sender/frame/origin，再由 Core 判权限及版本。设置 nodeIntegration=false、contextIsolation=true、sandbox=true、webSecurity=true；不传原始 ipcRenderer。
- [ ] 单实例入口与 Core epoch 保证多窗口只连一个权威；Core 重启须证明旧进程退出并先对账。Core 不直接依赖 Electron/UI，Main 不跑长事务；utilityProcess 环境显式白名单。
- [ ] 运行三项定向测试和 typecheck；真实包安全测试不过不能以 mock 通过收尾，审查后提交。

### P0-02 — 持久排队、事务、唯一写槽位和恢复

拟新增 `packages/persistence/src/{schema,migrations,unit-of-work}.ts`、`packages/core/src/{dispatch,outbox,reconcile,subscriptions}.ts`、`packages/domain/src/{bot,task,run}.ts`。

- [ ] 先写 `tests/recovery/dispatch.test.ts`、`tests/recovery/events.test.ts`、`tests/recovery/core-restart.test.ts`：双提交、ACK 丢失、崩溃点、旧 epoch、乱序/断流及 LOST 槽位均能失败。
- [ ] Task+Inbox+Outbox 同事务；唯一槽位覆盖 RUNNING/LOST；command_id 与 payload hash 绑定。短 SQLite 写事务内无网络等待；Runner ACK 丢失查询原命令。
- [ ] Bot 接单/派工开关独立；暂停指令按 scope/version 生效，调度在取槽位同一事务检查。snapshot 和 cursor 使用一致水位；重放去重，不因视图重建生成命令。
- [ ] fake Runner 持久 command receipt 后 ACK；租约过期不证明旧写者退出。重启和分区时无法确认即阻塞新写，不声称外部 exactly-once。
- [ ] 三个定向测试先失败后通过，再运行 recovery 目录，审查提交；不以关闭恢复检查解决竞态。

### P0-03 — 消息意图、控制与不可伪造的终态

拟新增 `packages/contracts/src/control.ts`、`packages/core/src/{inbox,run-control,approvals}.ts`、`packages/execution/src/fake-driver.ts`。

- [ ] 先写 `tests/contract/control.test.ts`、`tests/contract/approvals.test.ts`：旧 Turn 插话、重复取消、取消 ACK 但进程未退出、双窗口审批和参数变更。
- [ ] 区分讨论/新任务/补充/控制，校验 task revision、Run/Session/Turn；状态 RECEIVED/QUEUED/DELIVERED/APPLIED/REJECTED 不互相冒充。Discussion 的只读能力由 Runner 执行，不能只依赖 prompt。
- [ ] 分开 Run interrupt、Task cancel、Bot/Goal dispatch pause；退出或隔离证据到达前保留写锁。Goal 取消传播留 P3 细化，当前不露未完成控件。
- [ ] 审批绑定参数摘要、对象版本、范围和次数；菜单与按钮共享同一命令。跑定向 contract 测试后审查提交。

### P0-04 — 本地资产与可追踪上下文

拟新增 `packages/assets/src/{registry,bindings,rules,context-assembler}.ts`、`packages/persistence/src/assets.ts`。

- [ ] 先写 `tests/unit/assets.test.ts`、`tests/contract/context.test.ts`：无授权连标题/索引不泄漏、中文检索、local-only 全链阻止外传、规则冲突、更新/撤回。
- [ ] 本地原文和索引分开保存；版本/digest/授权范围固定；规则只能收窄硬约束，偏好冲突报错；生成指令保留用户 AGENTS/CLAUDE 文件。
- [ ] 安装/启用/授权三状态；Skill 脚本能力仅出现在受许可 Sandbox 执行包。ContextManifest 记录资料/规约/Skill、检索来源、处理位置和预算，无秘密。
- [ ] 快照对新 Run/Turn 生效，硬撤权立即拦截后续读取/请求；不谎称已读模型忘记。运行上述两项逻辑测试，审查提交。

### P0-05 — 连接解析、秘密边界与费用不切换

拟新增 `packages/connections/src/{registry,resolver,grants,broker,auth-flow,leases}.ts`、`packages/desktop-platform/src/secrets.ts`。

- [ ] 先写 `tests/contract/connections.test.ts`、`tests/contract/auth-flow.test.ts`、`tests/contract/secret-boundary.test.ts`；fake provider 验证所有 C01–C20 的可模拟协议分支，不能记为真实认证通过。
- [ ] Resolver 固定显式覆盖/默认 → Grant/数据/计费 → Runtime/模型/节点 → 清除冲突继承凭据 → inspectAuth → snapshot；最终启动和网关请求再次查 Grant revision，封住 TOCTOU。
- [ ] 分开执行租约、网关凭据租约、上游 credential reference。fake 网关验证撤销后的出口拒绝；本地 revoked 不代表原 Key 上游失效。长进程换凭据必须有实际更新协议或新进程/Session。
- [ ] AuthFlow 绑定 Bot/generation/runtime/connection revision/state/expiry/域名；测取消后回调、错 Bot、旧连接、恶意 URL。原始响应/设备码不进入通用事件、draft 或崩溃日志。
- [ ] 用 canary 扫描 IPC、日志、预览、Prompt、导出和快照；秘密输入为独立短生命周期平台通道，普通 Renderer 仅拿 reference/安全元数据。未知费用和账号来源明确标记。
- [ ] 跑三个定向逻辑测试及安全包测试；无凭据、无登录、无真实调用即可完成 P0。审查后提交。

### P0-06 — 最小公共分发契约与校验

拟新增 `packages/catalog-client/src/{manifest,download,verify,extract}.ts`、`tests/fixtures/catalog/`。不创建常驻付费服务。

- [ ] 先写 `tests/contract/catalog.test.ts`：目标节点架构、URL 过期/中断、digest/签名失败、越界路径/symlink 解包、重复 operation、离线已装资源。
- [ ] 本地 fixture 充当最小 Resource Server 协议端；manifest 版本不可覆盖，下载续传后校验并原子激活；不运行包内任意安装命令、不包含私有资料/认证、不自动二次创建 Bot。
- [ ] 写明 fixture 信任根只是测试信任根；P1 实际发布者/来源 preflight 未完成不能装真实公共包。目录与模型网关协议分开。
- [ ] 跑 catalog 定向测试，确认失败不改变已激活版本；审查提交。

### P0-07 — Mac 开发包、最小视图与阶段验证

拟新增 `apps/desktop/renderer/{app,bot-workspace,inbox,environment,connections}.tsx`、`apps/desktop/main/{menu,quit-coordinator,files}.ts`、`tests/macos-e2e/{lifecycle,workspace,accessibility}.spec.ts`。

- [ ] 先写 `tests/electron-security/{lifecycle,preview,secrets}.spec.ts`，及 Mac 三个测试文件的失败场景；fake 数据明确标“演示”，不得混入真实 Connection。
- [ ] 实现 S00/S04/S05/S06/S08/S09 与最小 S15/S17/S18/S19 展示骨架；三个主入口可保留未启用说明，不假做成长或动态目标。草稿按窗口/对象保存，危险控件受 Core 状态控制。
- [ ] Main QuitCoordinator 区分 ⌘W 与 ⌘Q；关闭设置只卸载视图。退出停止新派工，明确取消退出或停止保存，远端未知不显示已停。安全预览无脚本、外部跟踪或桥接。
- [ ] 实际开发 `.app` 验证菜单、文件授权/symlink、深链接作用域、第二实例、Renderer/Core 崩溃、React 重挂载、日志背压；人工验证中文 IME、VoiceOver、缩放/Retina、多屏及外观。记录自动/人工证据和目标 Mac。
- [ ] 运行 P0 逻辑全集、typecheck、package:mac、electron 和 mac 测试。P0 退出材料为同一 SHA/包 digest 的结果及未解决项，不能引用本仓库 Swift smoke 代替。审查提交并报告阶段结果。

## 4. P1：长期 Bot 的真实纵向切片

### P1-00 — 首个 Runtime/Auth 准入（先于真实登录）

拟新增 `docs/validation/runtime-auth-preflight.md`、`packages/execution/src/runtime-capabilities.ts`、`tests/contract/runtime-policy.test.ts`。依赖 P0-05。

- [ ] 先写 capability/许可状态为 unknown 时 POLICY_RESTRICTED、未选具名连接时阻塞、配置变化使旧检查失效的测试。
- [ ] 首选 Codex app-server 协议；exec 是独立 Adapter，不能当作相同 Session/Turn 能力。固定 CLI/协议版本、配置摘要、环境白名单、实际 auth 源/endpoint/账号/账单证据等级、节点及检查时间。
- [ ] 按[评审中的官方核验](v1.3-design-review.md#4-认证与工具官方核验)分别核实本地个人、本地开源发行、商业/托管的适用范围。当前机器已装 Codex 只说明可执行文件存在，不证明 AN 集成准入。SIWC 待审核，不假定 client ID，不自建订阅 token 代理。
- [ ] 用户选择实际 Connection/账号/订阅或 API/用户网关及允许的调用费用与数据范围后，才进行必要真实检查；原始秘密通过受保护流程。未获满足条件的路径就报告具体 BLOCKED，不改账单路线。Claude/Cursor 仍属 P2，前置规则同样适用。
- [ ] 静态 preflight 与授权后的真实结果分栏；许可、凭据优先级或成本来源不明停止本路径；审查提交无秘密的证据。

### P1-01 — Mac VM、Node 和持久 Sandbox

拟新增 `native/macos-sandbox-host/`、`apps/node-agent/src/{control,storage,limits}.ts`、`packages/execution/src/providers/macos-vm.ts`、`tests/integration/sandbox.test.ts`。

- [ ] 先在实际 Mac 用临时数据验证失败场景：VM 停止/唤醒、旧 generation、宿主 Home/DB/socket 越权、跨 Bot 读写、CLI 内部沙箱与 bwrap 冲突、资源上限。
- [ ] 实现 Provider create/start/stop/inspect/connect/destroy 与稳定 Bot binding，私有 Home/项目/auth 缓存隔离；任务结束不 destroy。文件共享用明确最小授权路径，不挂宿主管理 socket/完整 Home。
- [ ] 评估 helper entitlement 和安装路径；涉及签名/设备授权时单独报告实际需要，不自动申请或操作。Mac VM 路线不满足即 BLOCKED；不悄悄改为 host shell 或云权威 Core。
- [ ] 执行 sandbox integration、helper 单测和 Mac 目标架构测试；记录 OS/VM 内核/bwrap/资源配置/恢复限制。Linux bwrap 单独跑通只作补充。审查提交。

### P1-02 — 下载到可恢复的 Bot 初始化

拟新增 `packages/core/src/bot-provision.ts`、`apps/desktop/renderer/{create-bot,downloads}.tsx`、`tests/integration/provisioning.test.ts`。依赖 P0-06、P1-01。

- [ ] 先测断网、过期 URL、错误架构、校验失败、半完成创建、缺授权与重复按钮；回到同一个 Bot/operation。
- [ ] 接入经核验、许可允许分发的最小环境包；若 CLI 不允许再分发，用获准官方安装路径并固定来源/版本，不把二进制许可与模板许可混同。
- [ ] 明确实际信任根、离线缓存策略和发布者身份；分阶段显示下载/校验/安装/环境可用/待授权，未知大小不编百分比。最小资源端可为本地受控 fixture/server，完整托管发布、市场和升级仍 P2。
- [ ] 运行 catalog 回归、provisioning integration、Mac 创建流程；公共目录失联不破坏已有 Bot。审查提交。

### P1-03 — 持久 Runner 与第一种真实 Driver

拟新增 `apps/runner/src/{commands,spool,processes}.ts`、`packages/execution/src/{runner-client,drivers/codex-app-server}.ts`、`tests/integration/{driver,auth-cache,connection-leases}.test.ts`。依赖 P1-00/01/02 所有真实调用门禁。

- [ ] 先测持久 command 收据、重复 start、ACK 丢失、事件 spool、旧 fencing token、超时取消、Turn 结束、未知事件保留及结构化秘密过滤。
- [ ] Driver 实测 start/steer/interrupt/inspectAuth/checkpoint 能力；不支持的动作明确排队/拒绝。目标 Sandbox 内用官方获准授权流程，Main 只打开已验证官方 URL，不拷贝宿主认证目录。
- [ ] 检查真实环境变量/config/缓存优先级；注入冲突测试凭据应阻塞而非走错账号。授权状态重用、过期、退出重开、撤销、旧 AuthFlow 回调、跨 Bot 缓存读取均实测。日志与通用事件不能有原始登录响应。
- [ ] 实测长进程凭据更新，或者安全停止后新进程/Session；ExecutionLease、GatewayCredentialLease、原始 Key 的撤销分别验证。若选直连，明确同 UID 可读及上游轮换边界；若选网关，证明旧租约出口拒绝且断网/退出不绕过。未选路径继续 fake/NOT_RUN，不声称全部真实通过。
- [ ] 运行 driver/auth-cache/connection-leases integration 与 Runtime policy 回归；实际付费调用受已授权限额，触限阻塞不换计费。审查提交脱敏证据。

### P1-04 — 两次真实任务与最小知识/Skill/规约体验

拟新增 `packages/core/src/run-bundle.ts`、`apps/desktop/renderer/{assets,effective-snapshot}.tsx`、`tests/integration/persistent-bot.test.ts`、`tests/macos-e2e/task-journey.spec.ts`。

- [ ] 先设计 task-A 在授权测试项目写入文件并保留未提交修改，结束后 task-B 验证和继续该成果；唯一写槽位下连续提交两件事，第二件持久排队。独立验收读取真实输出和上下文 manifest，不能让 Bot 自称通过。
- [ ] 在 S00/S04/S05/S06/S08/S09 及最小 S15/S17/S18/S19/S20 接通真实路径；资料默认本地，中文授权检索、规约冲突、Skill 权限、连接费用/路由和来源明确可见。一次导入多 Bot 引用不共享私有写目录。
- [ ] 每个 Run 固定 assets/rules/skills/connection/Grant/candidate snapshot；中途撤回禁止后续使用并显示受影响会话。local-only 与云 Connection 冲突在执行前阻塞，包括 Embedding/摘要/工具。
- [ ] 验证 task-A → idle → task-B 的同 Bot/同 binding/同目录；无重新建环境或每任务重登。重启 App 和 VM 后按证据恢复，不能把缓存 Running 当事实。
- [ ] 跑 persistent-bot integration、context/assets/connections 回归与实际包 task-journey；用户体验及业务证据同一 candidate。审查提交。

### P1-05 — 故障、备份、独立证据与 Mac 阶段退出

拟新增 `apps/verification-worker/src/{candidate,capabilities,evidence}.ts`、`packages/persistence/src/backup.ts`、`tests/integration/{recovery,backup,evidence}.test.ts`、`tests/contract/evidence.test.ts`、`docs/validation/p1-report.md`。

- [ ] 先写候选变更/合同版本变化使旧 PASS 过期、自报完成被拒绝、验证器缺平台能力被拒绝的失败测试。验证结果保存完整命令、退出码、日志摘要/产物位置及 digest，不混合不同候选。
- [ ] 注入 Renderer/Core/Runner 崩溃、节点失联、磁盘不足、spool 重传、取消未退出、Mac 睡眠/强退/⌘Q；先对账，不重做未知外部动作。mock 外部服务用于故障重放，不重复发送/发布。
- [ ] SQLite 一致性备份加工作区恢复；普通导出排除 auth cache，敏感完整 VM snapshot 单独保护。干净目标恢复同 Bot 并完成下一任务；保留旧节点/凭据撤销检查。不得用复制 sqlite 主文件代替 WAL 一致性备份。
- [ ] 运行所有 P0/P1 有效命令与实际 `.app`/helper/VM 集成；人工补 IME、VoiceOver、文件授权、生命周期、日志输入响应，记录是否达到 §24 的负载目标。没有 Mac 或权限记 BLOCKED。
- [ ] 报告 P0/P1 通过、失败、未执行与平台；未选供应商/网关/架构、生产签名与 Gatekeeper 发行验证明确仍未通过。只在每项门禁有证据时宣布该阶段完成；审查提交并等待下一阶段授权。

## 5. 失败处理、证据与交接

每个结果最小记录：commit/candidate digest、设计 revision、测试 ID、真实/fake/人工、OS/arch/SDK/CLI/协议/配置摘要、连接来源等级（无秘密）、命令和退出码、日志/产物 digest、PASS/FAIL/BLOCKED/NOT_RUN、责任任务。P0/P1 的结果不得将 P2–P4 未实现项计入完成；映射表不是结果表。

失败时保存状态与脱敏证据，定位最早失效的边界；修复后先跑失败场景，再跑受影响集合。身份/数据/计费约束不满足时阻塞，保留队列/成果；平台缺失时保留 Mac 门禁，不换技术路线制造通过。运行中的连接切换需显式范围/期限/费用授权、安全退出或隔离旧执行，并以新 Run 留链。

P0/P1 不要求先做全部目录、十种供应商、远程产品服务或自我训练。P2 的人工接管、资源升级等须继续遵守已有锁/版本契约；P3 的 Goal GraphPatch 必须 expected_revision、同 Goal、无环、预算及授权检查，已有独立证据设施可复用；P4 经验收益必须来源—检索—采用—结果链，不能用检索次数冒充效果。

未来委派任务须提供实际 revision、完整源文件路径、相关章节**全文**及本任务验收；摘要只是导航，不能替代阅读。接手者先看最新 AGENTS、差异和阅读记录，变更涉及原设计时重读对应上下文。

## 6. 本轮实际验证范围

本轮仅检查 Markdown 内容、源文件 hash、验收编号覆盖、内部链接/空白，以及保留工具链脚本可解析、Linux skip 行为。提交后读取该提交的原有 macOS smoke CI 并在任务回执报告实际结果；此处不预填成功。未执行上文 npm/Swift helper/VM/模型/产品测试，没有新产品代码。
