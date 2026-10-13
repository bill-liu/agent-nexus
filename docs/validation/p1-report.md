# P1 验证记录

设计基线：AN 2.0 v1.3；本阶段任务书及门禁读取版本 `5aa3e5a547985342a147e36f0904912ee6735765`。本记录按提交追加，保留 [P0 记录](p0-report.md) 的既有结果。P1-A 无账号实现已获授权；P1-B 真实设备、VM、登录、账户和模型操作未获授权。

## A1：异步 Core 与可信停写证据

2026-10-13 UTC，本提交实现并独立审查：异步预检/发送不占用 SQLite 事务；Query-first Outbox 保留命令身份；发出前复验撤权、取消、代际、租约和 epoch；v1→v2 迁移持久保存执行绑定。Runner 接受回执与可写进程树停止是不同事实。真实 Run 拒绝旧 fake 退出/存活报告，只有受信 Node 观察经完整绑定和新鲜度校验后才可释放槽位；退出码 0 只推进 VERIFYING。

| requirement_id / stage / evidence_kind | Runtime / 平台 | 实际验证与结果 |
|---|---|---|
| A1；GATE07/08/13/19 协议子集 / P1-A / scripted | Node 24.19.0 / Linux x64 | 新增两个文件 42 项通过；涵盖丢 ACK、撤权、迟到回执、父进程死但子进程仍可写、错误绑定和恢复。不是 live 门禁通过。 |
| P0 回归 + A1 / P1-A / synthetic | Node 24.19.0 / Linux x64 | 根工作区 `npm run typecheck`、`npm test`（21 文件 / 308 项）、`npm run build`、`git diff --check` 均退出 0，时间 2026-10-13 00:00 UTC。构建为未提交工作区验证，不冒充已发布包。 |
| A1 独立差异审查 / P1-A / code-review | 本提交代码 | 未发现 A1 独立 Critical/Important 阻塞。发现 A3 Node 观察尚未提供所需退出状态，须在 A3 集成时修复并验证实际适配器形状。 |

候选识别：A1 提交为 [`fcd3cd9dd6f5416bb3eb925462b5725080e385bc`](https://github.com/bill-liu/agent-nexus/commit/fcd3cd9dd6f5416bb3eb925462b5725080e385bc)。同 SHA 的 [工具链 smoke](https://github.com/bill-liu/agent-nexus/actions/runs/38325207244) 与 [逻辑/实际 Electron 包 CI](https://github.com/bill-liu/agent-nexus/actions/runs/38325207136) 均已 SUCCESS。macOS 15 arm64、Electron 44.7.0：308 逻辑、11 Electron 安全、6 Mac 自动化通过，构建 `dirty: false`。这些仍是 P0 桌面与 P1-A 协议回归，不是 VM/CLI live 证明。

该候选 `app.asar` SHA256：`104b224c9287578a9fe02e1e6410d29c2595ac6c6b94df2663cfdcda268e92d3`。证据产物 ID `11780372569`，归档 SHA256 `931d8f966963e8d0512fff9ecbb344ecb4b0242fbdb23e00208bc162f1ea2ef1`，到期时间 2026-10-20；工作流产物保留包摘要和自动化报告，不是签名发行包。

## A3 helper 的先行编译切片

新增 Swift Virtualization helper 源码、7 项策略单测和标准 `macos-15` 编译工作流。此切片经过独立代码审查后提交用于取得编译证据；Linux 环境没有 Swift/macOS SDK，尚不能据此宣称编译或 VM 运行通过。工作流只 build/test 和只读 `--preflight`，不分配 VM 磁盘、不下载 ISO、不启动 VM、不签名、不登录。

首次候选 `c4a74cbfc105d4323a6b9e9c998946ef8e3a2153` 的 [helper CI](https://github.com/bill-liu/agent-nexus/actions/runs/38326337505) 在 Swift 6.1.2 编译失败：`VZVirtioSocketDevice.connect` 接收单个 `Result<VZVirtioSocketConnection, Error>`，而代码误用了双参数回调，故单测和 preflight 未运行。后续修正只调整该回调的取值方式，等待同 SHA CI 验证。该首次候选的 [Electron 回归](https://github.com/bill-liu/agent-nexus/actions/runs/38326337353) 和 [工具链 smoke](https://github.com/bill-liu/agent-nexus/actions/runs/38326337330) 成功，不替代 helper 编译结果。

修正候选 `e4a6583a15534900d3615daeb5073848bec50a19` 的 [helper CI](https://github.com/bill-liu/agent-nexus/actions/runs/38326582101) 已 SUCCESS：Swift 6.1.2 build、7 项单测及只读 preflight 均通过。实际输出 `virtualizationSupported: false`、`vmStarted: false`，因此该标准 runner 没有证明可启动 VM。同 SHA 的 [Electron 回归](https://github.com/bill-liu/agent-nexus/actions/runs/38326581967) 与 [工具链 smoke](https://github.com/bill-liu/agent-nexus/actions/runs/38326581988) 也成功。

受保护配置控制生命周期与可选 NAT；默认没有网卡。授权过期后仍可查看和停止已拥有的实例；私有 Unix/vsock 桥在所有复制线程退出后才关闭描述符。真实主机重启后可核对 kernel boot UUID，恢复旧实例的停止状态。**同一次主机启动内 helper 崩溃后的实例仍保持 UNKNOWN**；尚无无须主机重启的完整恢复证明。此限制和桥并发/真实 VM 检查仍属于未关闭的 A3/B1/B3 项，不把编译通过算生命周期通过。

## A4：安全后端、认证适配与当前授权

本切片复用 ConnectionResolver、Grant、lease、AuthFlow 和 SecretBroker，增加 Mac safeStorage 加密文件后端、异步认证预检、精确执行绑定、当前授权复验及固定 Codex 登录协议适配。真实请求必须显式选择 Connection；fake 后端/证据不能准入真实执行；UNKNOWN 账单证据不改成已核验。官方原生登录材料仍由 CLI 管理，不进入通用 Broker。

独立审查曾复现两项问题：登录中撤权且取消响应未知时丢失重试句柄；畸形原生响应被接受。现已修复并由独立复验确认：`cancel_unknown` 保留同一私有登录绑定直到确认取消；严格拒绝错误 ID 类型、缺失字段、超限或错误 URL。历史失败不删除。相关 GATE12/14/15/17 的覆盖是 scripted/synthetic 协议与 canary 检查，不是 live 门禁。

根工作区 2026-10-13 00:21 UTC：`npm run typecheck`、`npm test`（23 文件 / 356 项）、`npm run build`、`git diff --check` 均退出 0。定向 5 文件 / 131 项通过；新增 A4 两文件共 48 项。当前候选代码见本提交。实际包中另加入临时合成 safeStorage canary，检查真实后端、0700/0600、密文、清零和撤销；Mac CI 尚待执行，系统保护不可用会明确失败，不跳过后计为通过。普通 Renderer 没有明文读取接口。

候选 `970591703d95d43dab4be8a0e58a97da952a90f7` 的 [Electron CI](https://github.com/bill-liu/agent-nexus/actions/runs/38326975793) 中 Linux 356 项通过，Mac 逻辑测试 353 通过 / 3 失败；后续实际包和 canary 未运行。三个失败均为测试创建的临时根没有解析 macOS `/var` 的系统符号链接，被既有私有路径策略正确拒绝。最小修正仅对三个新建测试根应用 `realpathSync`，不改变生产路径策略或负例断言。Linux 用符号链接 TMPDIR 已先复现同样三个失败，修正后该文件 6/6 通过；typecheck 和 diff 检查通过，独立审查确认此范围。等待修正提交的 Mac 全套 CI，不以本地模拟替代。

## A5：独立调用边界的先行 Mac 检查

独立审查复现了旧 Node probe 的 Critical：候选拥有 stdout，可伪造观察而使错误函数通过。新代码关闭该路径，改由无宿主桥的 JavaScriptCore 执行函数；结果的数组、身份、错误原型和值由 C API/原生 JSON 观察，纯计算 OS sandbox 和描述符限制在执行候选前检查。新增标准 `macos-15` 工作流编译 helper，执行 15 个固定合成对照；没有 VM、CLI、账号或模型调用。作者修正后的原生部分尚未完成独立复审，根已逐行自审后先发布获取实际编译/运行证据，不能将它称为已通过 live 验收。

旧 Node 路径必须在副作用前 BLOCKED。Linux 定向检查包括文本转换不执行候选和平台/授权缺失拒绝；Mac 编译与 canary 在本提交前 NOT_RUN。Darwin 的 `RLIMIT_AS` 不证明硬物理内存上限；本切片仅声称 CPU/时间/输出限制与语言/OS 的 IO 边界。项目测试改动检查属于结构证据，不证明测试覆盖率。Core SUCCEEDED 迁移及 A→B 验收装配留到后续集成提交。

A4 修正候选 [`ee2776c`](https://github.com/bill-liu/agent-nexus/commit/ee2776c1d64a467d967cffae0ef1ae43fb11ecd1) 的 [实际 Mac 包 CI](https://github.com/bill-liu/agent-nexus/actions/runs/38329827499) SUCCESS：356 逻辑、11 Electron、7 Mac 自动化，含临时合成 safeStorage canary。`dirty: false`，`app.asar` SHA256 `b7e4447b4c97839b9410856e3b26c501f5b98c8a2fb231abb6068b01a587c6ed`。helper 和工具链 CI 同 SHA 均成功。

A5 先行候选 [`7753f64`](https://github.com/bill-liu/agent-nexus/commit/7753f649d47bcf62df7ba6010eae55c209c83001) 的 [原生 canary](https://github.com/bill-liu/agent-nexus/actions/runs/38330066346) 编译通过但首个运行检查失败 `BLOCKED_RESOURCE_LIMITS`，15 个对照尚未通过。本次仅细化资源检查错误码以定位实际不支持的限制，不降低边界。相同 SHA 的 Mac 包、helper 和 smoke 均 SUCCESS，但不能替代原生检查。

诊断候选 `03be7ee` 的 [Mac canary](https://github.com/bill-liu/agent-nexus/actions/runs/38330482542) 明确定位为 `BLOCKED_RESOURCE_AS`。Darwin 该 API 不提供本实现需要的硬地址空间约束，因此删除这个不可用且不能证明硬内存限制的调用；保留 OS sandbox、文件/进程/描述符、CPU、父进程时间/输出检查。硬内存上限列为未支持，不增加此 capability，不把该失败伪装为资源门禁已通过。真实验证准入必须考虑此限制；后续标准 CI 仅执行固定合成对照。

资源修正候选 `87c8881` 的 [Mac canary](https://github.com/bill-liu/agent-nexus/actions/runs/38330772167) 已越过资源检查，首个正确候选的原生报告将 C 逻辑表达式编码为整数 `1`，触发严格布尔断言失败。修正使用 `NSNumber numberWithBool` 显式编码，保留全部断言及 wire 类型校验；后续 CI 继续验证 15 个对照，未提前标 PASS。

## A2/A3/A5/A6：根集成候选

2026-10-13 01:26 UTC，恢复原工作区并改为 GPT6.1-SOL high 单路推进；没有重新初始化或增加并行任务。根已按各 worker 的文件清单复用代码和既有审查，并补全接线。

| requirement_id / stage / evidence_kind | 实现与实际验证 |
|---|---|
| A2；GATE03–09/18/19 协议子集 / P1-A / offline-schema + synthetic | 固定 Codex 0.159.2 schema、持久 ACK/claim/未知结果、独立 guest SQLite/Runner、原生精确审批与 Core 唯一权威、官方临时认证 facade；撤权/到期/排队失效回验。独立审查的三个审批问题已复验修复。新增终端事件先独立持久保存，再向有界 spool 发布；满容量/重开/确认后恢复测试通过。终端状态不提供停写证明。 |
| A3；GATE07/08/13/19 代码子集 / P1-A / synthetic + source-check | VM Provider/helper、签名/摘要固定的 bootstrap 下载复用、Node 私有配置/进程注册表、认证 Unix/vsock 通道、执行前 cgroup/BPF gate、当前隔离/环境 attestation 与完整停写观察。guest 实际入口接通 Runner、Driver、CoreApprovalPort、spool、终端 EOF 和可信 cgroup stop。测试不声称实际 VM/BPF 可用。 |
| A5；GATE01 机制 / P1-A / synthetic-subprocess | 固定 Task A/B oracle、精确未提交快照、不可篡改报告、同 Core SUCCEEDED 受控迁移。正确/错误候选、旧候选/契约、Bot PASS 文件、篡改/并发修改、待审批/活动写者和 A→B 依赖均有对照。默认测试包含 10 项 evidence integration。 |
| A6；GATE02/16/17 代码子集 / P1-A / synthetic | 默认 P0 演示保留；显式 P1 准备使用一个独立 Core DB。持久创建/环境状态/Connection 选择/资产绑定与快照/队列/审批拒绝中断/只读证据接通。临时官方授权走专用 Main/Core 通路，代码不进入普通快照/SQLite；只读窗口和扩展参数拒绝。真实原生授权的 installed factory 尚无 live 正向证据。 |
| v1/v2→v3 / P1-A / synthetic SQLite | 显式重建 Task CHECK，保留 Run/inbox/outbox/message/receipt/审批及执行绑定；新表复用同 Core。外键在事务外切换，提交前完整检查，损坏前置状态回滚并恢复 FK。4 个迁移测试 RED→GREEN；不在构造器重复安装局部 schema。 |

根补充修正：Runner spool 通过认证通道回放，在 Core 短事务保存 cursor/元数据后才确认，收据丢失可幂等重放；取消/中断即使原生 interrupt 拒绝仍到达同一绑定的 Node stop。受信终端回调只请求精确 app-server EOF，成功仍取决于实际 OS 全进程树和退出状态。A2 原压力修复的独立复审因额度中断未完成；根定向测试/自审已完成，不冒称独立清场。失败预检在 SQL 外清理同一未提交会话，未知停写保留映射并阻止再开；定时协调仅重试 owned cleanup，不重跑模型动作。活动登录期间拒绝切换 Connection；拿不到迁移写锁也恢复 FK。

候选来源也已补全：Node 在固定私有 workspace、全树无写者时建立精确快照，经认证有界通道导出，Core 逐项重验摘要/路径/字节后保存。Renderer 不提供 workspace、oracle 或报告路径。Task B 初始化前核对当前 workspace 摘要等于已验收 A，保存其 input 摘要；验收再次核对相同 A 依赖。当前传输限制为 160000 字节，超限明确 BLOCKED，不能截断后验收。

Mac native 第三个候选 `4a06f58` 的 [canary](https://github.com/bill-liu/agent-nexus/actions/runs/38331047122) 已通过 7 个对照，在宿主桥断言发现 JavaScriptCore 自带 console object。根不放宽断言，改为在候选执行前删除并封闭全部 host-facing 全局名；无法移除即 BLOCKED。待本集成候选的实际 Mac CI 完整验证。

根本次最终本地命令：`npm run typecheck`、`npm test` **42 文件 / 524 项**、`npm run build`、`git diff --check` 全部退出 0。原生 verifier/helper 的 Mac 结果、实际 Electron 包和人工/live 结果另列，不合并为整体 PASS。esbuild 版本与依赖图不变，开发包包含固定编译器及其可执行文件的 unpacked 路径，只转换文本；没有在 Node 执行候选。

审查范围：A1/A4 已完成独立审查；A2 原三个 Important 已独立复验；A3 初步审查无立即阻止代码/CI 发布的 Critical，但完整审查因额度中断；A5 原 Critical 已据复现修正，原生版本独立复审未完成；根按用户“单路、不新增并行任务”要求完成剩余自审。不能将自审表述为独立审查通过。

## 当前限制与 P1-B 门禁

- 用户 Mac、VM 安装/启动、guest 官方 CLI 初始化、登录、账号/凭证、模型及实际 Task A/B 均 **NOT_RUN/BLOCKED**。Mac mini M4 和 `personal-codex-p1` 仍是 UNCONFIRMED 候选。
- 真实装配仅面向另行准备并授权的单一 Codex guest。无人值守 guest 初装、同次主机启动 helper 崩溃后的完整恢复、细于 IP 的网关、每 Bot 文件系统配额尚未支持。原生 verifier 未证明硬物理内存上限。UNKNOWN 不伪装为停止或成功。
- 金额预算/Runtime 回报不证明请求数、Token 或费用硬上限；真实端点/route、计费适用性与可执行限制仍须 B 准入核验，必要时补选定路径的实现。不许因给出配置文件就跳过这些门禁。
- Task A/B 实际 workspace 传输、当前 Runtime/环境 attestation、EOF 行为、隔离/网络正负对照、取消与恢复必须在获准目标取得 live 证据；有调用代码不表示这些场景已经跑通。
- 资料默认仅本机。准备 scope 的材料不会自动换绑到真实项目；远程处理须另行明确政策，当前文本 Skill 不授予脚本权限。更完整的资料编辑/政策调整、其他 CLI/API/网关和生产发布不在本次实现范围。
- A1 恢复后真实 Run 保持 LOST，直到可信停写观察；没有基于不可信 alive 的恢复放行。
- [人工 Mac 清单](p0-manual-mac-checklist.md) 均 NOT_RUN；自动化不能代填 IME/VoiceOver/多屏/睡眠结果。P0 记录未改写。

本候选交付 P1-A 实现与无账号验证材料，尚待该 SHA 的完整 Mac CI。已知未支持路径、未完成独立复审及所有 B/live/人工缺口保留；**不宣称 P1 完成**。

## 集成候选 CI 收尾

集成提交 [`646ff19`](https://github.com/bill-liu/agent-nexus/commit/646ff19a4b9dee7ebf7c9155c0ebc07feb77b3ea) 已非强推进入 main。其 [桌面 CI](https://github.com/bill-liu/agent-nexus/actions/runs/38344480035) Linux 524/524 SUCCESS；Mac 517 通过 / 7 失败，尚未打包。失败位于两个新 fixture 文件，临时根同样含 `/var` alias；仅规范化新建测试根，不改生产 catalog/snapshot 安全规则。

同 SHA 的 [原生 canary](https://github.com/bill-liu/agent-nexus/actions/runs/38344480047) 通过前两个对照，stdout 伪造负例因 `process` 被封闭为 undefined 而抛 TypeError（原断言写死 OtherError）。修正断言只要求实际异常、非数组和 null 结果；错误候选仍不能通过后续完整 supervisor，宿主桥缺失与其余 15 对照保留。该错误不是报告伪造成功。helper 和工具链 CI 同 SHA SUCCESS。等待收尾提交全套 CI，不将未通过项标为完成。

收尾提交 [`93be4ba`](https://github.com/bill-liu/agent-nexus/commit/93be4bad41073b21406a62774645b836fcf183fd)：[native canary](https://github.com/bill-liu/agent-nexus/actions/runs/38344825855) **15/15 SUCCESS**，helper/smoke 也成功。[实际包 CI](https://github.com/bill-liu/agent-nexus/actions/runs/38344825861) Linux/Mac 逻辑均 524/524、Electron 11/11、Mac 8 通过/1 失败。唯一失败是 packaged compiler spawn ENOTDIR；esbuild 缓存加载时 cwd，而 ASAR 不是物理目录。本次给 Core utilityProcess 显式设置本机 dataDirectory cwd，canary 在相同物理 cwd 加载编译器，保留“不执行候选”的断言。该包 dirty:false，app.asar SHA256 `61cd682f4273a45297bacd7297bdaf2557ae58689e0167d0a86e308d32643d6a`；失败包不作为最终合格候选。

物理 cwd 修正候选 `6a7e75b` 的 [Mac 包 CI](https://github.com/bill-liu/agent-nexus/actions/runs/38345342555) 仍为相同 compiler ENOTDIR；该第一次 cwd 假设没有修复根因。检查已安装 ASAR 实现发现 `unpack` 匹配绝对文件名，旧相对 glob 未匹配，因此编译器根本未物理展开。新增跨平台真实 ASAR 合成归档测试先观察展开标记缺失（RED），再将共享打包策略改为按相对目录匹配的 `unpackDir`；不更换 esbuild，不放宽 canary。保留显式物理 cwd，待后续实际 Mac 包确认。

## 已验证的 P1-A 代码候选

[`2b187c74fea7b91d9cc30508197c78cb00b6dd5b`](https://github.com/bill-liu/agent-nexus/commit/2b187c74fea7b91d9cc30508197c78cb00b6dd5b) 的四组标准 CI 全部 **SUCCESS**：

| 检查 | 同 SHA 实际结果与链接 |
|---|---|
| Linux + 实际 Mac Electron 包 | [38345952620](https://github.com/bill-liu/agent-nexus/actions/runs/38345952620)：两平台 typecheck/逻辑各 43 文件、525 项；build/package 成功；实际包 Electron 11/11、Mac 9/9（含 P1 准备队列/重载、真实 safeStorage 合成 canary、物理展开编译器的文本转换） |
| 原生独立调用边界 | [38345952624](https://github.com/bill-liu/agent-nexus/actions/runs/38345952624)：15/15 固定合成对照；正确 A/B 正例、错误/伪造观察/篡改 intrinsics 负例与无宿主桥/CPU 终止通过 |
| Swift helper | [38345952684](https://github.com/bill-liu/agent-nexus/actions/runs/38345952684)：build、7 项策略测试及只读 preflight 成功；没有 VM 启动证明 |
| 工具链 | [38345952661](https://github.com/bill-liu/agent-nexus/actions/runs/38345952661)：临时 Foundation/AppKit 编译/运行成功；不是 App/VM live 门禁 |

实际开发包：macOS **15.7.9 / arm64**，Electron **44.7.0**，phase **P1-A**，`dirty:false`。app.asar SHA256：`18e8981780c03361e49bea277bf4473596a5adc5fea5a11ac4c4ef40834e8daa`。验证产物 ID **11788264984**，归档 SHA256 **9effb0bc9c966cb7c70a5672716e65b250295afb617e2e4cc5f9e45ec516862a**，有效至 **2026-10-20 04:21:27 UTC**；[工作流产物页](https://github.com/bill-liu/agent-nexus/actions/runs/38345952620#artifacts)。它是测试报告/包摘要，不是签名发行 App。

根 Linux 最终也为 43 文件/525 项、typecheck/build/diff 退出 0。A1–A6 实现和无账号验证材料已提交，P0 历史证据保留。前述未完成独立复审、未支持实现路径以及全部 P1-B/live/人工项仍保持相应状态，不能因 CI 绿而改为 PASS；**P1 整体未完成**。本次仅追加验证记录；后续记录提交仍需检查自己的 CI，其包摘要以该 run 的 package-evidence 为准，不冒用本段代码候选的摘要。

## N1：A2 / A3 独立复审收尾

保留最新 README/readiness 文档提交 `f66d756` 后，A2 补丁 [`e4d11e80a0e0b11dae98d1e7962c3a83ec513a72`](https://github.com/bill-liu/agent-nexus/commit/e4d11e80a0e0b11dae98d1e7962c3a83ec513a72) 已非强推进入 main。原满 spool、此次 EOF 丢已接收 terminal 和旧失败 handoff 饥饿三项独立 CLOSED。该 SHA 四组 CI SUCCESS：

| 检查 | 同 SHA 结果 |
|---|---|
| [桌面 38348513471](https://github.com/bill-liu/agent-nexus/actions/runs/38348513471) | Linux/Mac 各 43 文件/527 项、实际包 Electron 11/11、Mac 9/9；macOS 15.7.9 arm64、Electron 44.7.0、dirty:false |
| [原生 38348513499](https://github.com/bill-liu/agent-nexus/actions/runs/38348513499) | 15/15 固定合成对照 |
| [helper 38348513431](https://github.com/bill-liu/agent-nexus/actions/runs/38348513431) | Swift 6.1.2 build、7/7、只读 preflight；virtualizationSupported:false、vmStarted:false |
| [smoke 38348513494](https://github.com/bill-liu/agent-nexus/actions/runs/38348513494) | 临时 macOS SDK 工具链检查通过 |

该包 app.asar SHA256 `d6de82cdca49bd5d16a8851efb2228054eb32318d2e1b73f10285c6b997b0162`；产物 ID `11789363352`，归档 SHA256 `454fcb5e155db11b122b2dd87b6aea5c3f23f95df38eb0b24c8e85a22f3fc675`，到期 `2026-10-20T04:53:04Z`。不作为签名发行包或 live 证明。

随后独立 A3 审查完整现有 30 文件及必要接线，原 helper #2/#3 保持源码关闭；#1 same-boot UNKNOWN 仍是明示 B3 阻塞。实证发现磁盘准备的过期/畸形授权仍可产生后续副作用，并在首补丁发现 timeout:0 残留。均建立 RED→GREEN 后最小修复；最终补丁由同一独立审查者复验关闭（9 回归、12 额外边界）。本提交根 Linux 44 文件/536 项、typecheck/build/语法/diff 通过；该提交自己的 Mac CI 另行核对，不冒用 e4d 包摘要。

详细范围、失败历史和来源分别见 [关键复审记录](p1-critical-review.md)。A5 独立复审下一步串行进行；N2 首装、P1-B/live、人工 Mac 和已声明未实现能力维持原状态，**P1 未完成**。
