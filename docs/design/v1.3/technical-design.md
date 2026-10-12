# Agent Nexus 2.0：产品与技术详细设计

版本：Architecture v1.3 · Electron / Mac-first / Desktop + Resource Server  
日期：2026-10-12  
状态：已确认方向的设计规格；不是功能完成声明。具体库版本、厂商认证许可和兼容性须在实施前验证。

本文与 [界面与交互设计](interaction-design.md)、[设计入口](README.md)、[super bot 交接](../../handoff/super-bot.md) 配套，完整替代先前附件中的 v1.0、v1.1、v1.2 实施基线。保留既有长期 Bot、动态任务图、可靠执行与学习设计，合并资源服务器、知识/Skill/规约、连接选择和认证生命周期；不需要依赖另一段聊天才能理解。

> AN = Persistent Bot + Goal/Task Graph + Learning + Runtime Kernel。
>
> 用户给目标而不拆步骤；可以直接给指定 Bot，也可以交 Orchestrator Bot。Bot 的工作环境持续存在，工作结果与成长都必须可验证。

## 01. 决策、范围与非目标

### 1.1 已确认方向

- 从零建设，不兼容旧 AN 数据库、固定 Workflow 或旧 Session 模型；不因此删除现仓库的环境检查资产。
- Electron 桌面产品，一期仅 macOS。未来扩展其他桌面平台，不做浏览器主客户端或手机/平板首发。SwiftUI 主界面不再是硬约束。
- 一级入口只有任务指挥台、Bots、成长。项目、资源、连接、节点、权限属于设置或上下文管理。
- Bot 为统一长期主体，不新增 DigitalEmployee、Department、Position。Orchestrator 也是 Bot。
- 每个长期 Bot 绑定专属逻辑 Sandbox；任务完成不销毁工作环境，能够持续接任务与交互。
- Codex CLI、Cursor CLI、Claude Code 均在 Sandbox 内运行。Electron Main/Core 不能在宿主机直接启动它们代替隔离执行。
- 同一 Mac App 支持本地与远程执行。Mac-only 限制的是客户端，不是执行节点。
- 增加 AN Resource Server，管理基础环境、模板、版本和下载；不因为增加服务端就把私有任务、记忆、授权或调度迁到公共云。
- 知识库、Skill、规约属于一期能力。用户私有资产默认本地管理，公共资源由服务端分发。
- 用户决定连接及账号/计费来源。系统检查实际可用性，Bot 不自行选择付款账号；默认关闭跨计费来源自动切换。

### 1.2 实施建议与一期边界

建议 Electron Main + React/TypeScript Renderer + 最小 Preload，独立 TypeScript Core Worker，SQLite + 文件存储；执行侧 Node Agent/Runner 使用合适的固定运行环境。Mac 本地执行可使用受管理 Linux VM + Bubblewrap，虚拟化 helper 可用 Swift。远程 Linux 节点共用协议，E2B 作为受测 Provider 分期接入。[S1][S2][S3]

首发单用户、单权威 Core；不做多客户端双向同步、多租户 SaaS、固定流程编辑器、通用电脑操作引擎或自动人格蒸馏。公共下载服务不是常驻 Goal 调度服务，也不是用户秘密托管平台。模型训练与完整 Harness 候选搜索后置，但从第一条任务起记录证据和版本。

这些是设计选择，不是已安装或已验证的软件。最低 macOS、CPU 架构、框架版本、环境模板大小与性能目标均在 P0 固定并实测。

## 02. 产品与端到端验收

指挥台回答事情如何推进、哪里阻塞、需要用户决定什么、成果是否可信；Bot 工作台提供长期对话、Inbox、工作区与运行状态；成长展示来源、采用和评测，而非虚构等级。

首条研发验收：用户只给一个小型软件 Goal，一个 Orchestrator 调用 design、developer、review 三个长期 Bot；独立证据触发至少一次真实重规划；同一候选版本通过测试与评审；后续相似任务实际检索并采用本次确认经验。指定场景需要重规划，不要求每个任务故意绕路或多人协作。

首页展示“3/5 项验收已验证”而非无依据的完成百分比。状态来自系统观察，不来自模型自述。模板、连接、私有资料和基础环境就绪分别显示。

## 03. 总体架构与唯一事实来源

```text
Agent Nexus.app（一期仅 Mac）
  React Renderer：任务指挥台 / Bots / 成长 / 设置
       ↓ 最小 Preload，类型化业务命令
  Electron Main：窗口 / 菜单 / 系统文件面板 / 凭据桥 / 退出协调
       ↓
  AN Core Worker（一个权威实例）
  Bot / Goal / Task / Inbox / Kernel / Learning
  AssetRegistry / ContextAssembler
  ConnectionRegistry / ConnectionResolver / CredentialBroker
       ├── SQLite + 私有文件/Artifact Store
       ├── CatalogClient → AN Resource Server → 对象存储/CDN/Registry
       ├── 用户受控模型网关（选配，不等于公共资源服务）
       └── SandboxProvider / RunnerClient
               ├── Mac Linux VM + Node Agent
               └── 已授权远程 Node / 云 Provider
                        ↓
                 Bot 专属长期 Sandbox
                 Runner → RuntimeDriver → CLI
```

Core 拥有 Bot/Goal/Task/授权/验收/资产绑定的权威状态；Node/Provider 报告环境状态；Runner 报告执行观察；Resource Server 拥有公共资源版本目录；原生 CLI 管理其获准的原生登录态。任何一方不得用聊天或模板更新覆盖另一方的事实。

服务端断线不使已有 Bot 自动销毁；已安装环境可按本地策略继续使用。下载、新安装或更新可暂不可用；云端模型和远程节点是否可用另行判断，不能宣称所有能力离线可用。

## 04. 桌面进程、安全与平台适配

Renderer 仅管理显示、输入、导航与受限读模型。显式设置 nodeIntegration=false、contextIsolation=true、sandbox=true、webSecurity=true。生产界面资源随签名 App 分发，不以远程管理网站充当桌面主体。[S1]

Preload 暴露有类型的业务方法，不暴露 ipcRenderer、任意 invoke、require、exec、任意 SQL 或任意路径读写。Main 校验实际 frame/origin、schema、负载和窗口上下文，Core 再验业务授权与对象版本。Bot 的输出、Markdown、HTML、SVG、日志和链接均是不可信内容；预览无业务桥接权限，不自动执行脚本或加载跟踪资源。

Main 只处理桌面事务与受信任 Core/helper 生命周期。扫描、构建、日志解析、压缩和模型推理不阻塞 Main/Renderer。Core 可用 utilityProcess 承载，但这不是任务安全沙箱；禁止把第三方 Skill 动态 require 到 Core/Main。[S1]

所有窗口连接一份 Core；第二 App 实例、Renderer 重挂载、窗口重开不能启动第二个调度器。Core 崩溃后先限制写命令、确认旧实例退出、恢复数据库并与执行侧对账，再恢复派工。平台无关包不依赖 Electron UI API；系统能力通过 DesktopPlatformAdapter 注入。

## 05. 核心对象与关联

| 对象 | 含义与关键边界 |
|---|---|
| Bot | 长期身份、职责、默认 Runtime/Connection、资产绑定、Harness 和权限 |
| SandboxBinding | bot_id、node、provider_instance_id、generation、持久数据引用；逻辑绑定稳定 |
| Goal | objective、constraints、acceptance、owner_bot、contract_version、预算与停止条件 |
| Task | 一块可验收工作；parent 表示拆解，dependency 表示先后，不混为一棵树 |
| Run | 一次实际尝试；固定 Task/输入/代码/环境/模型/Harness/连接/权限版本 |
| Conversation | 用户与 Bot 的持续对话，可关联多个 Task |
| RuntimeSession | 某个 CLI 的原生会话，不跨 CLI 宣称无损兼容 |
| Artifact / Evaluation | 不可变成果及针对确切候选版本的验证 |
| Asset / AssetVersion / AssetBinding | 知识、Skill、规约、版本及项目/Bot 绑定 |
| Connection / ConnectionGrant | 账号、认证方式、请求路径与使用授权，分别建模 |
| AuthSession / CredentialLease | 环境登录状态的非秘密记录；或网关/执行授权租约 |
| Memory / HarnessVersion | 有来源、范围、撤回和评测的长期资产 |

一个 Bot 一个长期逻辑 Sandbox，一个 Task 多个 Run，一个 Goal 多个版本化 Task。一个 Connection 可以被授权给多个 Bot，但原生登录是否能共享由运行时许可及实际能力决定，不能据此共享整个认证目录。

Bot 能力不是自报分数。冷启动显示样本不足，使用清楚的输入、产出、限制和受测能力。Work Unit 不作为首发重型注册系统；优先用 Skill 和 Task 契约表达。

## 06. Bot、任务、App 与环境生命周期

分别保存 Bot desired_lifecycle、工作槽位状态、Sandbox observed_state、Runtime readiness、Auth readiness。UI 可合成“在线空闲”“执行中”“等待授权”“状态未知”，不能数据库只有一盏 ONLINE。

```text
创建 Bot → 建立持久目录/绑定 → 准备 Sandbox/Runner
       → 环境就绪（可等待授权） → IDLE
       → Task A / Run → IDLE → 继续对话 → Task B / Run → IDLE
```

Task 结束只释放已确认停止的执行槽位，不调用 destroy。首发一 Bot 一个主动可写槽位；其他任务进入持久 Inbox。普通状态查询、浏览文件、接收消息不占写槽位。Orchestrator 派出工作后结束本轮决策 Run、释放槽位，等待结果事件；不能占着槽位等待子任务导致死锁。

长期保留身份、工作区、未提交变更、相关会话文件、Inbox、产物与版本。进程、socket、锁、内存状态不保证跨重启保留。持久不等于永远推理、每个 Bot 都加载一份模型或不允许重启。

关闭窗口/⌘W 不等于退出 App；Main/Core 可继续处理已授权任务，Dock 重开仅恢复界面。⌘Q 使用 QuitCoordinator：停新派工，显示活动工作，允许取消退出或停止并保存；对本 App 所属 Run 请求停止并对账，保存数据后退出，不停止共享远程主机的其他服务。断线无法确认时明确记录 UNKNOWN；强退/睡眠依靠租约与恢复，不假称全已停止。

Resource Server 的存在不改变退出语义；无独立常驻 Core 时不承诺 Mac 关机后继续 Goal 调度。未来常驻工作空间模式须另立单一权威控制与授权设计，不能本地、云端同时指挥同一 Goal。

## 07. SandboxProvider、Node 与长期环境

SandboxProvider 只管 create/start/stop/inspect/connect/destroy；suspend/resume/snapshot/restore 为可选能力。RunnerClient 管执行、消息、订阅与取消，不能把业务 Task 直接塞进 Provider 生命周期接口。

能力声明包含 persistentFilesystem、filesystemCheckpoint、memorySnapshot、processResume、interactiveChannel、networkPolicyLevel、cpu/memory/pids/disk limits。界面按实际能力展示，不伪造暂停或快照。

Mac 本地实现建议受管理 Linux VM 中由 Node Agent 构造 Bubblewrap 挂载及长期 Runner。Bubblewrap 依赖 Linux，其隔离、网络与资源策略由 AN 的受信任执行侧负责；不是 macOS 原生内核沙箱。VM 可共享基础容量，各 Bot 私有可写目录和凭据域隔离。[S2][S3]

Node Agent 不给 Bot 通用宿主 shell、容器管理 socket、Core 数据库、整份用户 Home 或管理 SSH 私钥。执行通道经过节点身份认证、代际校验与访问控制；本地同样鉴权。远程 Provider 的暂停、期限、续期与连接需按固定版本及账户实测，不承诺无限在线免费。

迁移只在排空写 Run 或安全检查点后进行：保存可迁移工作数据、校验、目标恢复、增加 generation、撤销旧实例权限。普通迁移包排除认证缓存；原生登录优先在新环境重新授权。必要的受信任秘密迁移需单独许可与安全通道，不能做通用复制所有 CLI 登录目录。

长期 Bot 不销毁，不排斥临时独立验证 Sandbox、候选 Harness 环境和隔离构建环境。后者不成为用户需要管理的新“员工”。

## 08. AN Runner 与 CLI 驱动

Runner 常驻 Bot Sandbox，执行受控请求、映射原生 Session/Turn、输出统一事件、处理交互、取消及检查点。它不是新的通用 Agent，也不裁决 Goal 成功。

首个参考驱动可使用 Codex app-server；独立非交互任务使用单独受测的 exec 驱动。Claude Code、Cursor 各有自己的程序化接口，不能共用一个假设一致的 stdout 解析器。具体能力以官方接口及固定版本契约测试为准。[S4][S5][S8]

| 方法 | 要求 |
|---|---|
| capabilities | 流式、续接、插话、审批、结构化结果、用量、认证检查能力，附版本 |
| openSession/resumeSession | 使用确切 ID，不恢复“全局最近一次” |
| startTurn | 输入 Run/Task/上下文/连接快照，返回原生映射 |
| steer | 绑定 expected_turn_id；目标已结束则拒绝或重新确认 |
| streamEvents | 保留未知原始事件，终态/审批不丢失 |
| interrupt/cancel | 等待退出证据，不以 ACK 当作已停止 |
| exportCheckpoint | 明确恢复级别、材料与不支持项 |
| inspectAuth | 返回脱敏实际认证状态/来源，不返回 Token |

不支持中途插话时提供“本轮后追加”或用户确认的“中断后续接”，不能随意写 stdin。消息状态区分 RECEIVED/QUEUED/DELIVERED/APPLIED/REJECTED；只有明确依据才 APPLIED。

持续 Sandbox 不要求 CLI 进程永不退出。按 Run 注入新连接时，若驱动不支持安全更新认证，就新开进程并按许可续接原生 Session；不能以修改配置文件代替修改正在运行进程的实际凭据。

## 09. 对话、Inbox、工作区与接管

Conversation、Task、RuntimeSession 三者独立关联。用户“继续刚才工作”优先当前明确上下文，多个候选时先选目标。新工作、当前补充、讨论、状态查询、硬控制、长期偏好有不同处理；改变验收或权限必须修订契约。

Inbox 接受用户、Orchestrator 和获准 Bot 的请求，记录来源、优先级、available_at、dedup_key、项目。accepting_tasks 控制是否收单，dispatch_paused 控制是否派工；当前 Run 不因暂停后续派工被中断。

每 Bot 保留 Home，每项目/Goal 使用独立工作目录和分支/worktree；跨 Bot 通过 commit、patch、不可变 Artifact 交接，不共享并发写目录。合并候选后对确切集成版本验证。

文件默认只读，终端默认日志。接管前停止 AI 写入并获得写锁；未确认旧节点停止不允许“强制接管”。交回后比较 HEAD、未提交变更、人工操作摘要，相关旧证据标 STALE。关闭工作区窗口不等于交回控制权。

## 10. Goal Contract 与动态 Task Graph

Goal 包含 objective、项目/资料、constraints、acceptance、owner_bot、预算、风险、stop_conditions、contract_version。用户不给步骤，系统可辅助提出可验证标准；缺少关键事实进入 WAITING_INPUT，不伪造可验证结果。

Task 状态：DRAFT、READY、QUEUED、RUNNING、WAITING_INPUT、VERIFYING、SUCCEEDED、FAILED、BLOCKED、CANCELLED、SUPERSEDED。Run 状态记录准备、分发、接受、执行、取消请求、退出、丢失；Run 正常退出不等于 Task 成功。

当前依赖图为 DAG。历史反馈用新增修复 Task、Run、GraphRevision 表达，不把反馈环塞回执行依赖图。GraphPatch 带 expected_graph_revision，在事务内校验授权、同 Goal、成环、依赖、预算和状态。运行节点不能直接删除抹历史；先安全停止再替代。

Task 输入绑定资产/Artifact 版本与摘要。上游变更不能静默替换活动 Run 的输入；生成 INPUT_SUPERSEDED，决定继续、中断或重做。已证明无效的上游会使相应下游证据过期，不再计入当前验收。

## 11. Orchestrator：有界事件驱动决策

```text
Goal 创建 / 子任务结果 / 验收失败 / 用户修订 / 超时
    → 聚合新事件，读取一致状态快照
    → 一轮有界语义决策
    → Decision + GraphPatch + 证据依据
    → Kernel 事务校验 → Scheduler 分发就绪工作
    → 结束本轮，等待下一个有效事件
```

Scheduler 负责确定性依赖、槽位、资源与租约；Orchestrator 决定需要什么、谁负责以及如何调整；内部 CLI 自主决定任务内的具体动作。外层不逐行指挥内层，也不让内层扩大整个 Goal 范围。

动作限定 DELEGATE、ADD_DEPENDENCY、REQUEST_REVIEW、REASSIGN、CANCEL、WAIT、ASK_HUMAN、PROPOSE_COMPLETE。REPLAN 是有依据的一组图变更，不是一条无内容的文字标签。

同 Goal 一个决策租约，记录观察事件游标；晚到决策不能覆盖新图。先硬过滤权限、资源、Runtime、连接、数据政策，再排序能力、项目熟悉度、等待与历史效果。不得因便宜或快绕过连接/计费批准。

子 Bot 默认提出协助请求而不无限递归委派。重规划需新证据、失败假设、改变和预期作用。重复无进展、预算耗尽、不可恢复错误则停止、升级或询问；升级模型必须仍在已授权连接范围内。

## 12. 可靠执行、事务与故障恢复

Core 在同一短事务写 Task/Inbox/Outbox。领取工作检查派工标志和依赖，分配 run_id、写槽位、租约并写命令；网络发送在提交后，事务内不 await 网络/模型。SQLite 单写入口与短事务，不能照搬 PostgreSQL SKIP LOCKED/行锁。[S10]

Runner 先持久记录 command_id/run_id/generation 再 ACK；同命令去重，不再启动第二个 CLI。事件以 run_id+sequence 去重；同 command_id 不同请求哈希必须冲突。

租约携带 owner/expiry/fencing_token。旧 token 的控制请求被拒绝，但数据库 fencing 不能阻止失联进程继续改本地文件。因此未确认旧写入停止，不得重派相同工作区；必要时隔离、撤权、终止进程或保持 UNKNOWN。

| 故障 | 正确处理 |
|---|---|
| ACK 丢失 | 查询/重发同一 command_id，不能生成新 Run 代替查询 |
| Core 重启 | 扫非终态 Run，和节点对账，再恢复派工 |
| Node 失联 | 记录 UNREACHABLE/UNKNOWN，不擅自判成败或双重执行 |
| CLI 崩溃 | 收退出证据、Git 状态、检查点，再决定续接 |
| 产物上传失败 | 本地有界 spool 续传与校验，未持久化不能最终成功 |
| 取消请求 | 维持 CANCEL_REQUESTED，确认退出/隔离后释放槽位 |
| 外部动作结果未知 | 查询外部事实或人工核验，不自动重复发送/发布 |
| 事件丢失/乱序 | 按游标补传与去重；原始时间不代替因果序列 |
| 磁盘满/缓冲区满 | 背压、停止新工作并告警，不静默丢终态 |

目标是至少一次传递加业务幂等，不承诺任意外部副作用 exactly-once。恢复区分重连仍活进程、原生 Session 续接、材料恢复后新 Session；比较输入、代码、版本、连接及权限，展示实际等级。

## 13. 成果与独立验收

Artifact 不可覆盖，记录 content hash、类型、范围、来源 Run、输入版本、访问标签。代码绑定 base/candidate commit 或精确 patch+未提交清单。测试、评审、最终交付指向同一 candidate_digest。

验证分文件有效性、确定性测试/构建、语义与人工评审。开发 Bot 自测只是候选证据；受控 Verifier 在独立环境检出确切候选运行测试，检查删测、跳门禁及关键断言。Reviewer 与开发独立工作区/Session；同一模型不能自动等同独立可靠性。

全部必需验收 PASS、对应当前 Contract 与候选、无未解阻塞/待审批、成果已持久可访问，Kernel 才能设置 SUCCEEDED。Bot 仅能 proposeComplete；不得自己删验收项或改数据库宣布成功。

AN 自举修改必须额外有真实 macOS 打包后 Electron App、相关 helper 和交互测试；Linux tsc/test 不证明 Mac UI、签名、公证与 VM 集成。签名发布属于受保护流程，开发 Bot 不持有签名凭据。

可合并、已合并、已部署分开。默认交付到可合并；推送、PR、合并、生产发布是不同授权。最后改代码会使旧验证过期。

## 14. AN Resource Server：环境与下载分发

### 14.1 服务范围

服务端提供 SandboxTemplate、RuntimeProfile、BotTemplate、公共 Skill/规约模板、发布版本、兼容性信息及下载授权。不是用户运行中的 Bot、私有知识库、OAuth 仓库或第二个 Goal Scheduler。

SandboxTemplate 是无用户秘密的基础环境配方/制品清单；Bot Sandbox 是有独立私有数据的长期实例。模板共享，实例、登录态、工作区不共享。VM 基础镜像、rootfs/执行组件、Runner/CLI 版本、Bot Harness/Skill 分包；更新指令不强制重新下载整套 VM。

客户端依实际执行节点 os/arch/provider/protocol 选择包，而非仅依据 Mac 客户端。每条目录记录 immutable version、digest、size、来源、签名信息、最低 App/Runner 协议、权限需求、发布通道及撤回状态。

### 14.2 下载与安装

```text
Core 确认节点/权限/资源 → Catalog 查询兼容清单
→ 节点检查缓存 → 获取缺失制品下载授权
→ 节点直接从对象存储/CDN/Registry 下载
→ 校验签名来源、摘要、平台、磁盘和包内容
→ 安全安装到版本目录 → 原子激活 → 创建私有实例
```

AN API 返回清单和授权，不默认代理全部大文件。OCI 适用制品可用现成 Registry，VM 磁盘等可用对象存储。[S12] 下载支持取消、断点重试、过期 URL 重新申请，不重复创建 Bot。禁止解压路径穿越、符号链接逃逸或直接执行任意 catalog 命令。

签名验证与 hash 完整性分开；仅“同服务器返回 hash 匹配”不能证明发布者可信。公共环境中不含用户 Key、OAuth、Git 凭据或私有代码。版本撤回阻止新安装并告知已使用对象，不自动销毁持久 Bot。

### 14.3 发布和升级

App 更新、VM/rootfs、Runner/CLI、Harness/Skill 使用独立版本。升级环境前排空、检查兼容与数据迁移、保存恢复点；不覆盖 Bot 数据。回退二进制不代表数据库/环境迁移可逆。基础镜像中再分发某厂商 CLI 必须另核其许可证；不能从“有安装脚本”推导允许随产品重分发。

首发一个轻量服务加制品存储，维护者用受保护发布流水线/接口管理，不必做新业务 Web 台。公开制品可匿名下载；私有目录按需授权，不强迫离线用户注册公共账号。服务端只记录必要下载信息，默认不收任务内容、私有资料和用户秘密。

## 15. 知识、Skill、规约与经验资产

### 15.1 类型与归属

| 类型 | 用途 | 权威存储/管理 | Sandbox 如何使用 |
|---|---|---|---|
| 知识 | 项目事实、文档、接口、代码资料 | 本地私有文件+元数据/索引 | 授权片段、只读材料或查询工具 |
| Skill | 可复用方法、脚本、模板 | 本地已安装固定版本；公共目录在 Server | 受测版本包，脚本只在 Sandbox 执行 |
| 规约 | 行为指导与约束 | 本地 Core，分层/版本/范围 | 指导编译给 CLI，硬限制由执行点落实 |
| 经验 | 做过什么、条件下有效的方法 | 本地 Learning，来源/审核/采用记录 | 本次相关经验快照 |

私有内容不因启用 Server 自动上传。公共发布必须显式确认、脱敏、检查许可和秘密。未来团队私有存储是独立后端，不等于一期改 Web 客户端。

### 15.2 知识库一期

支持文档/目录/项目资料导入、更新、删除、项目与 Bot 授权、来源预览和关键词检索。原件与派生索引分开，记录 source、content_digest、version、updated_at、scope、data_policy。初期不要求向量平台；中文检索质量需专门测试，不假设默认 tokenizer 已满足。

读取前按项目/授权/版本过滤；索引也不能泄漏未授权文档标题。检索、Embedding、摘要、执行模型遵守同一数据规则。资料存在本地不等于不会发往云端；local-only 项目必须限制所有出站处理阶段，不能只限制最后模型调用。

### 15.3 Skill 管理

优先兼容 Agent Skills 的 SKILL.md 与附带资源格式，再增加 AN 的 publisher/digest/runtime compatibility/permissions/version 元数据，不声称所有 CLI 的装载语义一致。[S9]

安装、启用、授权是三件事。可安装但未启用；启用也不自动获得生产权限。固定版本、允许卸载/撤回、显示执行脚本与风险。禁止 Skill 改写 Kernel、窃取凭据或作为主进程插件运行。

### 15.4 规约与硬权限

行为指导包括代码风格、输出格式、架构偏好；通过 Driver 使用相应项目指令机制，装载时保留原有用户文件，不无条件覆盖 AGENTS.md/CLAUDE.md/项目规则。硬权限包括目录、网络、工具、账号、审批和资源，必须在 Core/Node/网关执行。

作用域：系统安全边界、用户/团队、项目、Bot、Task。下层可收紧或细化，不可扩大被上层禁止的权限。有效权限取交集；普通偏好冲突使用显式优先级并显示来源；无法同时满足的要求进入 RULE_CONFLICT。知识内容不是更高优先级指令。

## 16. ContextAssembler 与任务装载

```text
锁定 Task/项目/数据规则
→ 筛选可访问资产与有效版本
→ 合并规约，检查冲突
→ 固定 Skill 与 Harness
→ 检索相关知识/经验
→ 构造 ContextManifest
→ 只读材料 + 受限检索工具 + Driver 指令适配
→ Run 记录装载与采用证据
```

ContextManifest 保存 asset_id/version/digest、rule_set、skill_versions、检索来源、允许的模型处理位置和上下文预算。核心事实/约束先于可选经验，长材料按需读，不把整个历史塞入每轮。

变更分为新任务生效、下轮续接生效、硬撤权立即限制。撤回资料访问后停止后续查询，处理已有挂载/缓存和会话；不能宣称已读进模型的内容被远程抹除。严重秘密暴露需结束相关 Session、清理受影响材料并轮换，而非只删除索引。

同步到远程节点的私有资料必须有显式项目授权，按内容摘要传输、限定范围与保留期限。卸载公共 Skill 不删除 Bot 的正常成果；回收 Run 材料不清空长期工作空间。

## 17. Connection：账号、认证和路由分开

### 17.1 用户的选择模型

用户选择“用哪份连接及账号权益”，不是每次执行回答“网关还是登录”。一个 Bot 绑定一个 default_connection_id；Task 可由用户显式覆盖，受项目授权限制。默认 fallback_policy=ask_user，不在失效时搜索机器上其他凭据自动付款。

Connection 至少分开：

| 字段 | 含义 |
|---|---|
| provider / runtime_profiles | 哪个提供商，哪些受测驱动可用 |
| auth_method | runtime_managed_login / api_key / gateway_credential / local_endpoint / 扩展 |
| billing_source | 订阅/Console/API/组织网关/本地/未知；记录来源，不只看认证字段推断 |
| account/workspace reference | 用户选择及可验证的账号域，非秘密 |
| route | direct / gateway / local，批准的端点与允许模型 |
| credential_ref | AN 被允许保管的 API 等秘密引用；无真实值 |
| data_policy / allowed_nodes | 资料处理边界和可用位置 |
| fallback_policy | deny / ask_user / 明确批准的具名备用连接 |
| status / revision | 当前验证状态与不可静默变更的版本 |

官方浏览器登录可能进入订阅，也可能进入 Console；有 API Key 也不意味着它是任意模型商的 Key。Cursor 用户 Key 是 Cursor 身份，不可误用为其他模型 Key。[S6][S8]

ConnectionGrant 保存 user/project/bot/node/action 范围、批准者、期限和限制。连接有效不等于任意 Bot 有权使用；检测到登录缓存也不等于用户授权该任务使用。

### 17.2 ConnectionResolver：确定性解析

```text
显式 Task 连接（若有）否则 Bot 默认连接
→ 查 ConnectionGrant 和项目数据/计费限制
→ 查 RuntimeVersion + 模型协议 + 节点 + 认证/网关兼容性
→ 准备隔离运行配置，排除冲突凭据
→ RuntimeAuthAdapter 检查实际生效方式
→ 固定 ResolvedConnectionSnapshot
→ 授权有效才启动 Run
```

快照含 connection_id/revision、auth_method、billing_source及其证据来源、account_ref、route、endpoint_digest、runtime/model、grant_revision、auth_session/lease_ref，不含秘密。用户声明与官方报告必须区分，不能宣称已探测上游未暴露的账单身份。无法证明符合要求的认证/计费/数据限制时阻塞，不能猜测或默认直连。

语义决策模型不控制付款账号和权限。Intelligence Router 只能在获准候选中选择模型。项目要求公司网关优先于 Bot 的个人连接；拒绝不兼容，而不是“个人账号更快所以先用”。

## 18. 凭据、网关与 CLI 官方认证

### 18.1 AN 管理的 API 凭据

ConnectionRegistry 存元数据，CredentialBroker 用 Keychain helper 或系统保护加密存储保管允许托管的秘密，普通业务表只有 credential_ref。设置输入期间的明文为临时敏感值，保存后不提供通用读明文 API；不进 React 状态持久化、localStorage、草稿、日志、Prompt、学习或导出。

Electron safeStorage 在 Mac 的保护方式是实现参考；不是自动跨机同步，也不防御所有已控制同用户进程的攻击。不可用时失败，不明文降级。[S11]

### 18.2 网关优先，但有兼容性条件

API 连接在受测兼容时优先走用户受控网关：真实上游 Key 在网关侧，Sandbox 获取受 bot/run/model/endpoint/time/budget 限制的调用凭证。网关校验短期租约与撤销，限定上游，防止成为任意开放代理。公共资源 Server 默认不兼任用户模型网关、不持有请求正文。[S7]

网关可以是 Mac 可信进程或已批准私有节点，远程 Sandbox 通过认证通道访问。Mac 休眠/退出影响本机网关，应阻塞/停止相应执行，不能绕过它直连。网关必需策略写入 Core 与执行出口，UI 按钮禁用不算限制。

短期凭证必须由网关实际执行限制；给长期 Key 外包一个 expires_at 不会使上游 Key 真过期。网关协议、流式事件、工具请求、计费和恢复需契约测试；不能保证任意 CLI 兼容任意模型。网关不可达默认有界重试后暂停。

### 18.3 受控直连

用户明确选择、项目允许且驱动支持时，可通过官方 auth API/helper/受控环境提供 Key。避免命令参数、shell history、全局配置和基础镜像。清洗继承环境，只给本 Run 必要变量；不把全部宿主环境透传。

直接持有 Key 的 CLI 与同 UID 任意 Shell 可能读到它；环境变量和文件权限不是绝对秘密隔离。此路径必须标明风险。AN 撤销本地授权不能令已外泄原始 Key 自动失效，必要时在上游撤销/轮换；结束进程也不撤回已发出的网络操作。

### 18.4 原生 CLI 登录与厂商边界

AuthSession 绑定 bot、sandbox binding generation、runtime profile、官方会话的非秘密引用、账号/认证元数据、验证时间和状态。首次使用目标环境时发起官方流程；后续先检查，有效就复用，失效再授权。任务完成不注销。不要复制整份宿主认证目录到所有 Bot，不把 OAuth 做成通用模型网关。

Codex 官方提供 ChatGPT 与 API Key 两种身份；无头环境有设备码方案，需账号/工作空间允许。AN 优先由实际 Sandbox 中官方 CLI 发起，Mac 系统浏览器完成人机授权。具体协议/回调/缓存方式随受测版本，不自行发明刷新令牌代理。[S4]

Claude Code 的终端认证方式和环境优先级独立适配；例如非交互执行中已设置的 API Key 可优先于保存的登录，因此必须验证有效方式，不能只信 AN 下拉框。[S6]

重要发布门禁：Claude 官方条款对第三方提供 Claude.ai 登录或代用户使用订阅凭据有明确限制。AN 面向用户发布时不能仅因“沙箱运行的是官方 CLI”就认定嵌入式订阅登录集成被允许；产品集成默认采用获准 API/受支持提供商。原生登录入口只有在相应用例获得当前条款或明确授权支持后启用，否则显示 POLICY_RESTRICTED，不集中收集/转发订阅 OAuth，不绕过限制。[S13]

Cursor 原生浏览器登录和其用户 API Key 按官方认证接口适配。无浏览器流程不等于必须换计费来源；CLI 实际命令名、状态输出与可用认证方式在 preflight 确认，不据旧版文档硬编码。[S8]

用户账号登录通常与多个 Bot 共享上游限额；不宣称每个 Bot 有独立订阅额度。第三方 CLI 安装、运行、分发和账号用途各有许可，认证技术可行不等于商业分发许可。

## 19. 授权时机、失败与切换

### 19.1 生命周期表

| 时机 | API/网关 | 原生登录 | 数据/资产 |
|---|---|---|---|
| 制作公共模板 | 无秘密 | 无登录态 | 仅公共受测资源 |
| 添加 Connection | 安全保存获准秘密或网关引用 | 记方式/范围，按目标环境授权 | 不上传私有资料 |
| 创建 Bot | 绑定连接引用和 Grant | 环境可先就绪，等待授权 | 绑定资料/Skill/规约 |
| 每次 Run 前 | 校验并签发租约/受控注入 | 检查有效登录与实际身份 | 固定 ContextManifest |
| Run 中 | 同授权范围续租，撤销停止新调用 | 官方 Runtime 自行维护；失败请求授权 | 按权限追加读取 |
| Task 完成 | 回收 Run 租约、临时秘密 | 不自动注销 | 保留正常工作区和成果 |
| 重启/唤醒 | 新授权检查，旧租约不得复用 | 检查缓存，必要时重登 | 对账输入与版本 |
| 撤权/删除 | 禁新租约，处理活动请求，必要时上游轮换 | 官方注销与可验证的本地清理 | 不清空无关成果 |

Runner 长期存在，授权按 Run/会话范围管理。一个环境的原生 auth refresh 只有受控写者，不让多个进程并发修改共享认证文件。跨账号/计费来源切换默认新建 RuntimeSession；能否复用材料要再次满足数据授权，不能宣称身份切换无损继承隐藏上下文。

### 19.2 默认失败决策

| 情况 | 处理 | 禁止 |
|---|---|---|
| 未登录/失效 | AUTH_REQUIRED/AUTH_EXPIRED，保留环境与任务 | 自动找别人的 Key |
| 订阅受限/额度不足 | 等待或请求指定替代连接批准 | 静默切 API 计费 |
| API Key 无效 | 提示更新此连接 | 静默使用环境中其他 Key |
| 网关不可达 | 有界重试后阻塞 | 绕过网关直接上游 |
| 认证与选择不符 | AUTH_MODE_MISMATCH，停止启动 | 宣称仍在用订阅 |
| 模型/Runtime 不兼容 | CONNECTION_INCOMPATIBLE | 仅凭同名 API 字段假设兼容 |
| 连接或数据规则撤销 | 禁止新动作，停受影响执行并审计 | 新 Bot 绕过撤销 |
| 外部副作用未知 | 对账后决定续接 | 为换连接重跑整任务 |

### 19.3 备用连接

一期默认 ask_user；允许用户提前配置具名备用 Connection、项目、触发原因、费用约束、数据规则、有效期。无批准的 fallback 不可执行。切换前停旧执行、确认未知副作用、重新解析连接、建立新 Run/会话和记录，保留 Task 身份。不能一边旧 Run 仍写文件一边换连接重启。

网关凭证失效与上游 Key 失效分别记录；额度未知不显示零。费用来源 provider_reported、runtime_estimated、gateway_measured、user_declared、unknown 分开；累计报告需要去重。未具备上游或网关强制能力时不能承诺精确费用硬封顶。

### 19.4 登录界面与秘密传递

AuthFlow 由可信操作触发，绑定 flow_id、Bot、节点代际、Runtime、期望账号与有效期。只打开 RuntimeAuthAdapter 认可的官方域名/回调；任务输出中的任意“登录链接”不可伪装系统授权。设备码/验证码仅进入专用临时界面与官方流程，不能记录到 Bot 对话、分析、遥测或通用事件。

采用厂商支持的回调/设备码机制，必要的回调绑定正确 flow/state，禁止公网无认证回调或跳过 TLS 校验。关闭对话框、取消流程、超时和迟到回调分别处理，不能登录到另一个 Bot。原生 Token 由官方运行时保留，AN 只读取获准的状态元数据。

## 20. Learning、决策策略与 Harness 进化

原始 Trace、当前工作状态、事实知识和可复用经验分开。MemoryItem 记录内容、type、scope、来源、适用条件、局限、验证状态、有效期与 supersedes。任务结束提炼候选，去重/冲突/权限检查，低风险验证或人工确认，再发布版本。

检索命中、装入上下文、Bot 声明采用、结果关联、配对评测是不同证据。经验不是越多越强；错误经验撤回后停止检索并标记衍生 Skill/Harness。人类偏好不是无条件事实。

智能路由：L0 代码处理权限/依赖/预算；L1 受限决策模型排序允许动作；L2 本地 LLM 处理受控语义；L3 获准强模型用于陌生复杂问题。ConnectionResolver 不交给模型。首个训练场景建议合格 Bot 排序，低覆盖/分布外 ABSTAIN。

保存 state/actions/choice/selector_version/outcome/cost/override，覆盖成功和失败。教师 LLM 选择不等于真标签；按 Goal/项目/时间分割数据，未被日志覆盖的反事实不能仅离线回放证明。先 shadow，再校准灰度；质量门禁高于节省调用。

RRSI 式优化作为后续设计：固定模型/环境对比 H0 与小范围候选，经泄漏/安全检查、回归和留出集比较、批准发布/回滚。不能改 Kernel、验收、秘密、审计或生产权限。候选跑独立环境，新任务用新版本，活动 Run 固定旧版本。本文不采用早先对话中未经核实的 RRSI 日期/基准分数作为事实。

不能因 CLI 在 Sandbox 中就声称可替换其内部全部推理；只能优化 AN 实际掌控的外层和公开接口。

## 21. 安全、备份与权限执行

信任 Core、受控 Node、凭据/工具网关、Verifier；CLI、仓库、资料、MCP、Skill、模型输出都可能错误或受污染。有效权限是用户、项目、Bot、Task、节点的交集。能力声明与安装模板不能授予秘密。

审批绑定 action_digest、资源、候选版本、有效期、次数。批准创建 PR 不等于合并；批准模型连接不等于允许资料发向任意第三方。高风险工具在执行点验权，网络出口限目的地，资源由 Node 限制，不能仅 Prompt 声明。

秘密分类必须覆盖官方认证缓存。此前“凭据不在 Agent 可写目录”的目标不代表官方 CLI 必定能外置全部缓存；实际默认位置须按 Driver 核实并记风险。若同权限域能读取秘密，不宣称强隔离；高风险任务优先网关/更强工具隔离。

普通导出/公共模板排除凭据、auth caches、环境变量转储和敏感日志；完整 VM/进程快照可能包含秘密，必须按敏感备份加密、受限保存。公共资源 Server 不承接此类备份。原生订阅凭据不做通用云端备份，迁移重新授权。

SQLite 使用一致备份 API/机制，不在活动 WAL 下只复制主文件。恢复需同时核对 DB、Artifact、Bot 数据清单、密钥恢复与认证状态；恢复一个真实 Bot 并继续任务才算备份验收。删除 App 与清除持久数据分开。

## 22. 协议与服务接口

### 22.1 三段边界

桌面 IPC：Renderer → Preload → Main → Core。执行协议：Core → Node/Provider → Runner。资源 API：CatalogClient → HTTPS Resource Server。模型网关是独立授权通路，不混入公共资源 API。

桌面无需运行浏览器业务后端；可以为资源下载、受控模型网关或官方回调存在专用 HTTP 服务，但不得把整个 Main/Core 任意 RPC 暴露到公网。所有写命令具 command_id、expected_version、scope；长操作返回 operation_id，受理不是完成。

### 22.2 应用业务方法

| 类别 | 建议方法与限制 |
|---|---|
| Bot/工作 | bot.create/inspect/lifecycle/setDispatchPaused/setAcceptingTasks、work.submit |
| 交互 | conversation.send、run.control、events.subscribe、artifact.open |
| 图/验收 | graph.proposePatch、goal.proposeComplete、approval.decide |
| 资产 | asset.import/search/bind/unbind、skill.install/enable/revoke、rule.preview/publish |
| 连接 | connection.create/update/grant/revoke/verify、connection.resolvePreview |
| 认证 | auth.begin/status/cancel/logout，仅获准方法、状态无秘密 |
| 下载 | catalog.query、download.start/status/cancel、environment.upgrade |
| 成长 | memory.review、harness.evaluate/promote/rollback |
| 生命周期 | app.requestQuit，由 Main 协调而非 Bot 自裁 |

拒绝任意 shell、任意 URL 代理、任意数据库调用。Resource Server 可暴露 GET /v1/catalog/templates、GET /v1/releases、POST /v1/download-authorizations；管理员发布 API 独立授权。资源 manifest 不能携带隐式任务控制命令。

### 22.3 执行与事件

```json
{
  "protocol_version": "1",
  "command_id": "cmd_example",
  "type": "run.start",
  "bot_id": "developer",
  "run_id": "run_example",
  "binding_generation": 3,
  "fencing_token": 42,
  "task_revision": 2,
  "execution_bundle_ref": "bundle_example",
  "resolved_connection_ref": "connection_snapshot_example",
  "expires_at": "2026-10-12T23:59:00Z"
}
```

以上为协议示意，不是真实凭据/命令。ExecutionBundle 仅有引用与固定版本，真实秘密通过受控通道提供，不随 Task JSON 广播。Runner 拒绝过期、错代际、错租约与不匹配的连接快照。

事件含 event_id/type/source/run_id/sequence/causation/occurred_at/received_at/safe payload。run.completed 仅执行退出；Task/Goal 成功来自独立验收。快照+游标一致订阅，背压、限长和分页；终态/审批不能丢。AUTH_REQUIRED、AUTH_MODE_MISMATCH、POLICY_RESTRICTED、CONNECTION_INCOMPATIBLE、GATEWAY_UNAVAILABLE、RULE_CONFLICT、STATE_UNKNOWN 等有明确恢复策略。

## 23. 持久化与数据约束

| 领域 | 主要表 |
|---|---|
| Bot/环境 | bot、sandbox_binding、execution_node、environment_install |
| 工作/交互 | goal、acceptance_criterion、task、task_dependency、task_assignment、conversation、message、runtime_session、bot_inbox |
| 执行/证据 | run、execution_command、run_event、outbox_event、artifact、evaluation、approval |
| 资产 | asset、asset_version、asset_binding、rule_set_version、context_manifest |
| 连接 | connection、connection_grant、auth_session、auth_flow、credential_lease、resolved_connection_snapshot、connection_switch |
| 成长 | memory_item、memory_usage、skill_version、harness_version、eval_case、eval_run、promotion |
| 公共目录侧 | template_release、artifact_manifest、release_channel、revocation；不混入私有业务表 |

秘密实际值不入上表、事件和 Prompt。AuthFlow 临时验证材料与正常审计分离并短期销毁；AuthSession 表只存元数据和非秘密引用。ContextManifest 和 ResolvedConnectionSnapshot 为每个 Run 留下可审计不可变引用。

条件唯一索引或等价约束保证一 Bot 一个未释放写槽位；LOST 未确认停机仍占槽位。command_id、run_id+sequence、task_id+assignment_version、scope+idempotency_key 唯一。相同 key 不同请求摘要冲突。

GraphRevision/资产版本不可覆盖；跨 Goal 依赖禁止；新增边事务内检查成环。派工暂停与领取共用单写入口/版本约束，不在读取旧值后异步绕过暂停。Grant 撤销与启动存在竞态时，在最终启动授权及网关请求再次校验 grant revision，不能只在提交 Task 时检查一次。

## 24. 部署、版本与资源

交付签名 Mac .app，用户无需安装 Node/npm/数据库服务器；环境包按需下载。内部开发环境可以使用构建服务器，但生产主界面依赖打包资源。Mac 签名、公证、原生模块 ABI、helper 架构和 Gatekeeper 必须验证，不以开发模式成功替代。

公共 Resource Server 和制品存储由维护者部署，用户通常不需自行搭建；可预留私有目录地址和离线已验证包。任意目录地址/网关端点变更要审查 HTTPS/来源、资料流向及费用，不给 Renderer 任意请求私网地址的通道。

不为每 Bot 创建隐藏 BrowserWindow，也不各加载一份模型。主窗口 Renderer、设置/详情按需创建，Core 一份。长日志/任务列表/diff 虚拟化，昂贵工作有界调度；分别统计 Electron、Core、VM、构建和模型资源。一个 Bot 一个写槽位，重型构建初始并发保守为 1，再以实测提高。

参考工程目标：约定 Mac 和负载下普通命令受理 P95 ≤500ms、已抵达 Core 的事件展示 P95 ≤2s，不包含模型/网络/镜像/VM 启动；不是已有性能。记录冷/热启动、空闲 CPU/内存、IME、长日志输入响应、窗口关闭资源回落与恢复。

## 25. 实施阶段与代码边界

| 阶段 | 内容 | 退出证据 |
|---|---|---|
| P0 | Electron/Core/SQLite/协议/FakeDriver，资产/连接 schema，目录清单规范 | 打包 Mac 骨架、IPC/幂等/恢复/认证解析与费用不切换测试 |
| P1 | 一个长期 Bot、VM/Node/Runner/首个 CLI，基本资料/Skill/规约、连接授权、可验证下载 | 同 Bot 连续两真实任务，身份环境保留，授权检查有效 |
| P2 | 剩余 Driver、远程节点/Provider、接管、目录发布与下载升级完整链 | 受测能力表、厂商认证门禁、本地远程同协议、秘密不进包 |
| P3 | Orchestrator + 三长期 Bot，动态图与独立验收 | 不拆 Goal，真实重规划，同候选验证通过 |
| P4 | 经验审核/检索采用、Skill/Harness 版本与回滚 | 后续任务真实采用、撤回有效、可重建评测 |
| P5 | 决策 shadow/灰度、受控 Harness 搜索 | 独立留出与质量门禁，不以成本掩盖退步 |

V1 范围 P0—P4；公共资源服务是配套设施，不是让 P1 等大型账号/云平台。P0 就设计认证解析、资产范围与审计，P1 不得带明文测试 Key 先跑，P3 才补权限。P5 不进入首版假功能 UI。

```text
apps/desktop/{main,preload,renderer,core-worker}
apps/resource-server/
apps/node-agent/
apps/runner/
apps/verification-worker/
packages/{contracts,domain,core,persistence,execution,learning,ui}
packages/{assets,connections,catalog-client,desktop-platform}
packages/model-gateway/          # 仅在选定兼容路径需要时实现
native/macos-sandbox-host/
tests/{unit,contract,recovery,electron-security,macos-e2e}
harnesses/  evals/  infra/  docs/design/  docs/plans/  docs/handoff/
```

这是职责建议，不是一包一个服务，不要求预建全部空壳。正式实施计划列文件、命令、平台、失败与验收；当前文档交接不授权任意安装依赖、删除代码、修改计费或发布 App。

## 26. 保留的核心验收场景

以下都是待执行规格，不代表已通过。

| ID | 场景与门禁 |
|---|---|
| B01 | 创建 Bot 得到稳定身份/环境绑定及真实初始化状态 |
| B02 | 两次任务复用长期身份、目录及项目，不清空 Home |
| B03 | App 重启先对账，保留 Inbox/工作区/会话引用 |
| B04 | 停机唤醒保存未提交变更，明确冷启动限制 |
| B05 | 忙碌时连续交任务仅一个写执行，其余持久排队 |
| B06 | 任务结束不调用 Sandbox.destroy |
| B07 | 删除先排空/取消、撤权；清持久数据单独确认 |
| I01 | 活动插话正确绑定 Turn，显示真实交付状态 |
| I02 | 不支持插话时排队或确认中断，不假 APPLIED |
| I03 | 取消确认退出/隔离后才释放写槽位 |
| I04 | 人工接管写锁与交回变更观察有效 |
| I05 | 换 CLI 保留业务身份但新建原生会话，不假无损迁移 |
| I06 | 本地远程使用同一 Task/Run/Artifact 协议 |
| R01 | 重复 run.start 仅一个真实 CLI 进程 |
| R02 | ACK 丢失按原 command_id 查询/重试 |
| R03 | 节点失联不双重派相同写工作区 |
| R04 | 旧 fencing token 不污染新状态 |
| R05 | 乱序/断流/重复事件恢复无关键终态丢失 |
| R06 | 候选代码变化使旧 PASS 过期 |
| R07 | 仓库提示注入无法读取宿主秘密 |
| R08 | Agent 自报完成不能绕过独立证据 |
| R09 | 回放使用外部服务替身，不真实重复发送/发布 |
| R10 | 干净环境恢复备份后继续真实任务 |
| G01 | Orchestrator 在不手工拆解下调度三长期工作 Bot |
| G02 | 新证据触发具体图变化，保留历史 |
| G03 | 简单任务单 Bot 可完成，不强制多人 |
| G04 | 预算/无进展明确停止并交代已有成果 |
| L01 | 经验来源、检索、采用与后续结果可追踪 |
| L02 | 经验撤回停止检索且衍生资产待复核 |
| L03 | 退步 Harness 不发布，活动 Run 不受影响 |
| L04 | 决策低覆盖/分布外 ABSTAIN，不擅自选账号 |
| M01 | 实际 Mac .app，无用户 npm/数据库服务前置 |
| M02 | Mac 窗口/系统菜单/设置与键盘可用 |
| M03 | ⌘W 和 ⌘Q 具有不同且真实的保存执行语义 |
| M04 | 强退/睡眠/唤醒对账，不凭缓存报运行 |
| M05 | 多窗口一份 Core，草稿和命令不串作用域 |
| M06 | Mac 本地 CLI 在 VM 内 Sandbox，不退化宿主执行 |
| M07 | 远程执行不依赖其他终端客户端 |
| M08 | Mac 包/helper/UI 证据绑定同一候选 |
| M09 | 文件授权有效，保存的秘密不回传普通 Renderer |
| M10 | 升级可恢复，删 App 与删 Bot 数据分开 |
| E01 | Renderer 不可直接调用 Node/SQLite/shell |
| E02 | 非信任 frame/origin IPC 被拒绝 |
| E03 | 恶意产物/链接不获脚本和桥接权限 |
| E04 | Renderer 崩溃不重复运行任务 |
| E05 | Core 崩溃对账恢复，拒绝旧实例写入 |
| E06 | 多窗口/第二 App 实例不产生第二控制核心 |
| E07 | 日志/预览/状态无测试秘密泄漏 |
| E08 | 打包原生模块/helper 在目标 ABI/架构可用 |
| E09 | 更新安装经过排空/保存与 schema 检查 |
| E10 | 大日志和多 Bot 长运行事件有界、输入可用 |
| E11 | 通用 domain/core 不依赖平台 UI，未来平台不假支持 |
| E12 | Electron Renderer sandbox 不替代 Bot Sandbox |

## 27. 新增资源与认证验收

| ID | 必测场景 | 通过条件 |
|---|---|---|
| D01 | 模板发布 | 不含用户秘密/私有数据，版本不可覆盖 |
| D02 | 目标架构不同 | 按执行节点选择包，不按 Mac UI 固定 |
| D03 | 下载中断/URL 过期 | 按现有 operation 续传/续签，不重复建 Bot |
| D04 | 签名/hash/解压异常 | 拒绝激活，不运行包内任意安装命令 |
| D05 | 资源服务不可达 | 已安装 Bot 不销毁；未安装项明示等待 |
| D06 | 模板更新/撤回 | 不覆盖工作区、不强停活动 Run，列影响对象 |
| A01 | 私有资料导入 | 默认留本地，可见范围和模型处理政策 |
| A02 | 未授权检索 | 连标题/片段/索引也不泄漏 |
| A03 | local-only 项目 | Embedding/摘要/工具/最终模型均不能绕过 |
| A04 | 安装脚本 Skill | 安装不授予权限，脚本不在 Main/Core 执行 |
| A05 | 指导与硬权限冲突 | 不能靠下层规约放宽限制，返回冲突 |
| A06 | 运行中资料更新/撤回 | 固定快照且标受影响 Run，不声称已忘记 |
| C01 | 默认连接 | 一个 Bot 引用具名连接，不在 Task 保存原 Key |
| C02 | Task 显式覆盖 | 有授权、兼容/数据检查及费用提示后生效 |
| C03 | 官方登录有效 | 复用目标环境状态，不每任务重登 |
| C04 | 登录失效 | 保留环境/成果，AUTH_REQUIRED/EXPIRED，不切 API |
| C05 | 订阅额度不可用 | 未授权备用时阻塞，不静默计费 |
| C06 | 网关不可达 | 不绕过网关直连 |
| C07 | 环境有冲突 Key | 选择订阅却实际 API 时拒绝 AUTH_MODE_MISMATCH |
| C08 | 私有 Key 输入/导出 | 不进日志/草稿/Prompt/模板/普通导出 |
| C09 | 网关租约撤销 | 新调用被拒绝，不能继续用旧 bot/run 授权 |
| C10 | 直连原 Key 撤销 | 明示本地撤权不等于上游失效，有轮换流程 |
| C11 | 目标节点/账号不符 | 拒绝，不共享其他 Bot 认证目录 |
| C12 | 多 Bot 同账号 | 显示共享上游限制，不虚增额度 |
| C13 | 备用连接已批准 | 核对范围/期限/数据/费用，安全边界新 Run 留痕 |
| C14 | 旧 Run 副作用未知 | 切换前对账，不重复写/发送 |
| C15 | AuthFlow 迟到/串 Bot | flow/代际/域名检查拒绝错误绑定 |
| C16 | 厂商许可未明确 | POLICY_RESTRICTED，不以能运行当获准集成 |
| C17 | 本机网关随 App 停止 | 远端安全停止/阻塞，不秘密换路线 |
| C18 | Run 级凭据在长期进程 | 驱动真实更新或新进程续接，不假修改 env 已生效 |
| C19 | 认证前后 Grant 被撤销 | 最终启动/请求二次校验，不能竞态放行 |
| C20 | API/网关账单信息缺失 | 显示来源/未知，不显示零费或确定账号假信息 |

## 28. 首批 Bot、交接与资料依据

首批 rd-orchestrator、design-bot、developer-bot、review-bot 从职责、项目知识、受测工具/连接、获准 Skill/规约及少量好坏案例组装，不预置专业分数。普通专业 Bot 无生产发布/主分支合并权限，负责人也不能绕过验收或借别的账号。

贯穿 Goal：“为 AN 增加暂停派工，达到可合并；暂停不终止当前任务，新工作排队，恢复后继续，重启不丢设置。”在已有基础调度后自举，不在尚无系统时假设它能完成自身全部开发。

设计与评审先给影响/验收场景，开发产出 C1；独立并发测试发现竞态，Orchestrator 记录证据并新增事务修复/回归 Task，旧验收失效；C2 在独立环境和 Mac App 验证后交付。提炼项目范围经验，经确认在下一次并发限制工作中采用。实现中所有 Run 记录连接、上下文与版本，不因自举而给特殊权限。

先阅读 [super bot 交接](../../handoff/super-bot.md) 和配套 [交互设计](interaction-design.md)。当前仅提交设计与阅读入口，P0/P1 实施计划仍需按仓库现状形成，不把文档验收矩阵标成已完成测试。

### 官方参考与核验范围

以下链接用于能力核验，不代表 AN 已实现对应功能。2026-10-12 重新核对认证、网关、Skill 相关官方文档；其他基础链接沿用为 preflight 入口。厂商登录/重分发许可会变化，发布前必须复核。架构、状态机、数据结构与验收是 AN 的工程设计。

- [S1] [Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[安全](https://www.electronjs.org/docs/latest/tutorial/security)、[IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)。
- [S2] [Bubblewrap 官方仓库](https://github.com/containers/bubblewrap)。
- [S3] [Apple：在 VM 中运行 Linux](https://developer.apple.com/documentation/virtualization/running-linux-in-a-virtual-machine)；[E2B 持久化](https://e2b.dev/docs/sandbox/persistence)。
- [S4] [Codex 认证](https://developers.openai.com/codex/auth/)、[App Server](https://developers.openai.com/codex/app-server/)。
- [S5] [Codex 非交互执行](https://developers.openai.com/codex/noninteractive/)；[Claude Code 程序化运行](https://code.claude.com/docs/en/headless)。
- [S6] [Claude Code 认证与凭据优先级](https://code.claude.com/docs/en/authentication)。
- [S7] [Claude Code 模型网关](https://code.claude.com/docs/en/llm-gateway)。
- [S8] [Cursor CLI 认证](https://cursor.com/docs/cli/reference/authentication)、[Headless](https://cursor.com/docs/cli/headless)。
- [S9] [Agent Skills 规范](https://agentskills.io/specification)。
- [S10] [SQLite 事务](https://sqlite.org/lang_transaction.html)。
- [S11] [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。
- [S12] [OCI Distribution Spec](https://github.com/opencontainers/distribution-spec/blob/main/spec.md)、[Electron 更新](https://www.electronjs.org/docs/latest/tutorial/updates)。
- [S13] [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)。不从“官方 CLI 在沙箱里运行”推导 AN 可代用户提供订阅登录。
- [S14] 用户提供研究线索 [RRSI](https://github.com/google-research/rrsi)：作为待独立核验参考，本文不据此宣称性能提升或即插即用能力。

**文档结束。**
