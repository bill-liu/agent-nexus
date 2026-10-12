# P0 交付与验证边界

设计：AN 2.0 v1.3；实现起点 `c705282e7eb69528c0da1ac7b506ff43f0e21427`。用户于 2026-10-12 批准 P0 和必要普通依赖。此版本只使用 **FakeRuntime / FakeAuth / FakeGateway 和合成资料**，不启动真实 CLI、登录账号或调用模型。没有选择许可证、配置账单、secrets、签名、公证或发布。

## 已实现的 P0 范围

| 范围 | 行为与证据入口 |
|---|---|
| 工程与桌面边界 | 固定 Node/Electron/React/测试工具和锁文件；本地静态 Renderer、隔离 preload、单一 utilityProcess Core；严格 IPC schema、窗口/主体权限、命令大小与背压。`tests/contract/ipc.test.ts`、`tests/electron-security/` |
| 持久控制 | 实际 SQLite WAL/FULL、Bot/Task/Inbox/Run/Outbox、命令幂等、唯一写槽位、epoch/fencing、暂停派工与暂停接单分离；LOST 保留槽位，正常退出只到 VERIFYING。`tests/recovery/`、`tests/contract/control.test.ts` |
| 恢复和停止 | 子进程 SIGKILL 覆盖事务前后、执行回执丢失、Runner 退出但 Core 未记账；退出证据持久化；启动后先对账再恢复可派工队列，授权失败保留可读状态与阻塞原因；取消优先于失效 start，只有实际 fake 退出/隔离证明才能释放槽位 |
| 审批协议 | SQLite 单次消费、全部作用域/版本/参数绑定，可信主体，过期/撤销/晚到/多窗口竞态；Codex 0.159.2 离线 schema 与精确 JSON-RPC 映射。网络批量放行、Turn/Session 广泛授权拒绝。详见 [协议证据](cli-approval-contract.md) |
| Connection | 具名来源、范围 Grant、固定快照、认证/计费证据、启动前复验、租约和 fake 网关逐请求强制检查；不静默切换；AuthFlow 取消及撤销优先于晚到回调。`tests/contract/{connections,auth-flow,secret-boundary,runtime-policy}.test.ts` |
| 资产和上下文 | 默认 local-only、版本化内容/索引、授权检索、固定 manifest、撤回后续访问、规约硬约束交集、Skill 独立授权。`tests/unit/assets.test.ts`、`tests/contract/context.test.ts` |
| 公共目录契约 | 本地合成源，Ed25519 测试信任根、digest/架构/权限/协议检查、可恢复下载、generation、路径/链接/大小/冲突防护及原子激活。实际发布者准入未完成时拒绝真实来源。`tests/contract/catalog.test.ts` |
| 组合执行 | Core 同一事务内冻结上下文与具名 fake Connection；实际交付前重查 Grant、资产撤回、Run/Session/Turn/generation；提交已落库而调度受阻时保留原请求身份。`tests/contract/p0-application.test.ts` |
| 最小 UI | 中文三个入口、长期 Bot/队列/暂停/取消、环境/连接说明、受控文本预览、窗口草稿和重试；所有演示明确标记。动态 Goal、成长和真实登录未启用 |

## 验证方式与证据

Linux 开发环境是 Debian 13 / x64 / Node 24.19.0。依赖与本地工具链探针见 [preflight](p0-preflight.md)。本地 `npm run typecheck`、`npm test`、`npm run build` 及 `git diff --check` 必须在所有修复收敛后执行；实际测试数和该提交退出码以对应 [P0 工作流](https://github.com/bill-liu/agent-nexus/actions/workflows/p0.yml) 日志为准，不能将开发过程中的部分绿色结果当作全集结果。

2026-10-12 17:04:47 UTC，Linux 最终候选检查：`preflight`、`typecheck`、`npm test`（**19 文件 / 266 测试通过**）、`build`、`git diff --check` 均退出 0；fixture JSON 语法通过。原工具链脚本语法通过，Linux 执行正确报告 base PASS / macOS SKIP。这些结果没有覆盖真实 macOS GUI。

标准 `macos-15` runner 在同一提交上重跑逻辑检查，生成实际 `.app` 并启动它执行 `test:electron` 与 `test:mac`。制品 `p0-macos-validation-<SHA>` 保存包内 `app.asar` SHA-256、源码 SHA、dirty 标志、OS/架构/Electron 版本和独立的 Electron/Mac Playwright 结果、失败截图与 trace。该开发包没有发布签名或公证；不是发行验证。CI 首次运行前不预填成功，提交交付回执提供实际完成状态与链接。

独立审查覆盖 Core/审批、Connection/组合、桌面和资产/目录。已验证的回归包括退出证据丢失、Object 原型工具名、认证检查期间撤销、缺账号元数据、Mac 临时目录祖先符号链接、版本冲突后重试。修复先观察失败再通过定向测试；最终全集验证不能由静态审查替代。

首轮实际 Mac CI（[dc8c925 / run 38282149106](https://github.com/bill-liu/agent-nexus/actions/runs/38282149106)）运行于 macOS 15.7.9 / arm64：266 项逻辑测试与实际 `.app` 打包通过；Electron 安全测试为 6 通过 / 5 失败，因此后续 Mac 流程没有执行，该轮整体 **FAIL**。日志、失败 trace 和包 digest 已保留。失败涉及测试 Main 上下文的 `require`、未注册窗口探针、受阻导航与崩溃恢复观测；修复必须继续用实际包复验，不能用本地逻辑通过覆盖这一失败记录。

原有 [Swift 工具链 smoke](../../.github/workflows/toolchain.yml) 保留独立，不用它代替上述 Electron 包验证。

## 未通过或尚未执行的门禁

| 项目 | 状态与所需条件 |
|---|---|
| 无账号 CLI 初始化 | **BLOCKED**：当前 bwrap UID map 创建报只读文件系统；未启动 CLI session，未退到宿主执行。离线 schema 通过不等于初始化通过 |
| 中文 IME、VoiceOver、Retina/多屏、系统外观、睡眠/唤醒 | **NOT_RUN**：需获准的交互 Mac，标准无人值守 CI 不代替人工证据 |
| 真正的 macOS Launch Services 外部链接唤起 | 包声明 scheme、Main 检查作用域；完整系统注册/冷启动操作仍需实际 Mac 验证 |
| VM/helper/真实 Runner/CLI 内部执行约束 | **NOT_IMPLEMENTED / NOT_RUN（P1）**：还需 Mac 型号/OS/CPU、VM 能力及所有者授权；标准 GitHub arm64 runner 不能据此当作可用嵌套 VM 目标 |
| 具名真实 Connection | **BLOCKED（P1）**：需账号、用途、计费来源/限额、数据范围、节点和适用许可；由主线程确认，不继承宿主登录或配置 |
| 最小独立 Verifier/Evidence 与两次真实任务 | P1 开始两次真实任务前先落实候选/契约绑定的独立证据；Bot 自报或进程退出不能算验收成功 |
| 真实发布者、CLI 再分发、生产 secret backend | P0 只有 fixture 信任根和 fake backend；不据此宣称真实资源可安装、平台安全存储已交付 |
| 其他 CPU/更早 macOS、发行签名/Gatekeeper | 未验证；只承认实际 CI 记录的开发包目标 |

P0 的自动化结果与上述人工/平台缺口分开交付，不能宣布全部 Mac 或真实运行门禁通过。**本次不进入 P1，也不连接用户电脑。**
