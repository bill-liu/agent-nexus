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

## 尚未完成

- A2、A3 其余 Node/Provider、A5 和 A6 正在独立工作树实现/集成；A4 的实际 Mac canary 待 CI。未宣称 P1-A 整体完成。
- A1 恢复后的真实 Run 保持 LOST，直到受信停写观察；没有新增基于不可信 alive 回执的恢复放行。
- 标准 macOS CI 的工具链、实际 Electron 包与未来 VM/CLI live 验证分别记录。
- Mac mini M4 与 `personal-codex-p1` 仅为 UNCONFIRMED 候选；设备操作、登录、账单来源、模型/数据/调用限制须有具名准入。无真实凭据、设备码或个人接入信息进入本仓库。
- P1-B、真实 Task A/B、真实隔离/审批/恢复门禁与人工 Mac 项均未执行；本记录不宣称 P1 完成。
