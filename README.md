# Agent Nexus

**面向目标、持续协作、可验证成长的 Bot 工作台。**

把明确的工作交给一个 Bot，把复杂目标交给能够组织协作的 Orchestrator Bot。AN 要沉淀的不只是聊天记录，而是长期工作环境、交付证据，以及下一次任务能够复用的经验。

**Electron · Mac-first · 本地控制 · Sandbox 执行**

> **开发状态：P1-A 代码与无账号验证材料已交付，P1-B 真实联调尚未通过。**
> 现在可以从源码运行演示和准备界面；不能据此认为真实 Bot 已经可用。Podman Machine/容器真实联调、CLI 登录、连续任务和部分独立复审仍待完成。第一期仅支持 Mac 客户端，不是浏览器管理网站，也不是已发布的生产版本。

当前默认本地后端已选定 [Podman](docs/design/decisions/2026-10-16-podman-runtime.md)；首个 [无账号代码切片](docs/plans/podman-first-slice.md) 仅有合成验证，尚非已安装可用环境。

[当前进展](#当前进展) · [从源码运行](#从源码运行) · [下一步计划](docs/plans/p1b-readiness-plan.md) · [技术设计](docs/design/v1.3/technical-design.md) · [交互设计](docs/design/v1.3/interaction-design.md)

## AN 要解决什么

一次性 Agent Session 可以完成一项工作，但新的任务常常需要重新整理上下文、重复交代方法，再由人协调多个工具。AN 的目标是让这些投入持续留下来。

| 产品入口 | 核心体验 | 当前边界 |
|---|---|---|
| **任务指挥台** | 交代结果，查看进展、阻塞、审批与交付证据 | 已有最小工作与队列界面；目标自主编排属于 P3 |
| **Bots** | 找到同一个 Bot，继续对话、接新工作、使用持续保留的工作区 | 演示与 P1 准备路径可运行；真实持久执行尚待联调 |
| **成长** | 查看经验来源、采用位置、技能版本和评测结果 | 保留入口；真实学习闭环属于 P4，不展示伪成长 |

最终目标体验是：用户提出结果和约束，Bot 自己推进；需要协作时动态委派，遇到反例时重新规划，交付针对当前版本通过验证的成果。**这描述的是产品方向，不是当前已验收功能。**

## 核心原则

**Bot 长期存在。** 专属逻辑 Sandbox 跟随 Bot，任务结束不销毁工作环境；进程可以重启，身份、工作区和可恢复记录继续保留。

**目标驱动，而不是固定工作流。** Orchestrator 也是 Bot。简单工作可以直接交给专业 Bot，不强制经过一条岗位流水线。

**控制与执行分离。** 本地 Core 掌握任务、权限和验收事实；Agent CLI 只在 Bot Sandbox 中运行。模型说“完成”不等于系统判定成功。

**资产与授权可追溯。** 知识、Skill、规约和经验按范围及版本装载。用户选择 Connection 和计费来源，不自动从订阅切换到 API，不绕过网关，也不借用其他 Bot 的账号。

**成长需要证据。** 经验被检索到不等于真正有效；决策模型和 RRSI 式工作策略优化属于后续受控评测能力，不能修改权限或验收标准。

## 当前进展

状态快照：**2026-10-13**。读取基点为 [`f709381`](https://github.com/bill-liu/agent-nexus/commit/f709381b54178c365dab7d252b0a9b1678087b1e)，其报告记录的已验证代码候选为 [`2b187c7`](https://github.com/bill-liu/agent-nexus/commit/2b187c74fea7b91d9cc30508197c78cb00b6dd5b)。详细失败历史、提交和限制见 [P0 报告](docs/validation/p0-report.md) 与 [P1 报告](docs/validation/p1-report.md)。

| 能力 | 已有实现及验证 | 还不能据此证明 |
|---|---|---|
| Electron 桌面与 SQLite Core | 单 Core、持久队列、幂等、审批、Connection 和资产契约；实际 Mac 开发包自动化 | 人工输入法、VoiceOver、睡眠与全部设备兼容性 |
| 异步 Runner / Codex Driver | 异步派工、持久回执、事件重传、固定协议与审批往返接线 | 真正 guest 内的 CLI 会话、工具效果和网络隔离 |
| Mac VM helper / Node | 源码、Swift 编译与策略测试、受保护通道和执行限制代码 | 真实 VM 启动、guest 安装、cgroup/BPF 效果 |
| 凭据与认证 | Mac safeStorage 合成 canary、官方认证适配与授权复验 | 用户真实登录、账单来源和实际调用限制 |
| 独立验证器 | 原生 JavaScriptCore 验证路径，固定合成正反例 | 任意不可信代码的通用安全执行，或真实 Bot 的 Task A/B 成功 |
| 资料与准备界面 | 知识、文本 Skill、规约绑定，独立准备数据库和 readiness 展示 | 通用 Skill 脚本授权、完整资料管理或生产分发市场 |

### 已验证候选的自动化结果

下列数字均绑定 `2b187c7`，不是无版本的永久通过状态。Linux 和 macOS 的逻辑测试各运行一次，**不相加为两倍覆盖数**。

| 检查 | 结果 | 证据 |
|---|---|---|
| 逻辑与契约 | 43 个文件、525 项通过；Linux / macOS 均成功 | [桌面与逻辑 CI](https://github.com/bill-liu/agent-nexus/actions/runs/38345952620) |
| 实际 Mac `.app` | 打包通过；Electron 安全/恢复 11/11，Mac 自动化 9/9 | [同一候选 CI](https://github.com/bill-liu/agent-nexus/actions/runs/38345952620) |
| 原生验证器 | 15/15 固定合成对照通过 | [Verifier CI](https://github.com/bill-liu/agent-nexus/actions/runs/38345952624) |
| Swift helper | 编译、7 项策略测试及只读 preflight 通过；不启动 VM | [Helper CI](https://github.com/bill-liu/agent-nexus/actions/runs/38345952684) |

该开发包验证于 macOS 15.7.9 / arm64、Electron 44.7.0，`dirty:false`。精确包摘要见 P1 报告。CI 产物是验证材料，**不是签名发行版 App**；有保留期限，不能当作永久下载地址。

### 尚未关闭的限制

目前面向另行安装并获准的**单一 Codex guest**，没有完成无人值守首次安装；同次 Mac 启动中 helper 崩溃后的完整恢复仍会保留 `UNKNOWN`。网络限制目前仅达到已声明的 IP 层级，不等于域名、端口或逐请求网关；每 Bot 文件系统配额和验证器硬物理内存上限尚未支持。

真实 Mac/VM、隔离内无账号 CLI 初始化、官方登录、真实 Task A/B、取消/恢复与人工 Mac 检查仍未通过。A2 后续压力修复、A3 完整链路、A5 原生版本的独立复审仍有欠账。**不是只填一份授权配置就能宣布 P1 完成。**

## 架构

```text
Agent Nexus.app — Electron / React
                 │ 最小 Preload + Main
                 ▼
       本地 AN Core + SQLite
       Bot / Task / 权限 / 资产 / 验收
                 │
         SandboxProvider / RunnerClient
                 │
     Mac Linux VM → Node → Bot Sandbox
                           Runner → CLI

配套边界：
  Resource Server → 公共环境、模板、版本与下载（按阶段完善）
  远程执行节点   → 相同执行协议（完整接入属于 P2）
  用户模型网关   → 独立的授权路径，不是公共资源服务器
```

执行侧已有准备代码，图不表示所有链路已真实跑通。Mac-only 限制的是首发客户端，不是未来执行节点的操作系统；增加资源服务器也不意味着将私有资料、账号和调度搬到公共云。

## 从源码运行

当前面向开发者和受控验证。依赖范围见 [package.json](package.json)，版本复现使用 [package-lock.json](package-lock.json)。当前开发验证使用 **Node 24.19.0、npm 11.9.0**；Node 支持范围为 `>=24.14.0 <25`。

```sh
git clone https://github.com/bill-liu/agent-nexus.git
cd agent-nexus
npm ci
npm run preflight
npm run typecheck
npm test
npm run build
```

Linux 可运行通用逻辑与构建检查，不能替代 Mac 桌面和 VM 验证。不要把环境中已安装的 CLI 或登录状态当作 AN 的授权。

### 在 Mac 上查看演示或准备界面

先安装项目固定的 Electron 二进制：

```sh
npm run install:electron

# P0 演示：FakeRuntime，不登录、不调用模型
env -u AN_APP_MODE -u AN_P1_ADMISSION_FILE npm start

# P1 准备：独立数据库，创建与排队不等于真实执行
# 清除准入文件变量，避免继承已有真实环境配置
env -u AN_P1_ADMISSION_FILE AN_APP_MODE=p1-preparation npm start
```

两种界面择一运行。P1 准备模式分别显示 environment、runner、runtime、auth 状态；未准入时保留阻塞，不自动安装 guest、启动 VM 或搜索宿主凭据。普通资料导入默认仅本机，文本 Skill 不授予脚本权限。

### Mac 开发包与自动化

```sh
npm run package:mac
export AN_PACKAGED_EXECUTABLE="$(node -p "require('./out/package-evidence.json').executable")"
npm run test:electron
npm run test:mac
```

测试必须使用当前 `out/package-evidence.json` 指向的实际包，核对源码 SHA、dirty 状态和包摘要。以上不是发布或公证流程。Swift helper 和原生 verifier 的独立检查分别见 [helper 源码](native/macos-sandbox-host/) 与 [verifier 工作流](.github/workflows/macos-verifier.yml)。

### 真实运行不是默认启动选项

真实路径需要受保护的 `AN_P1_ADMISSION_FILE`、具名设备、Connection 和相应批准。配置文件的存在不等于授权，也不能替代环境安装、运行时检查或独立验收。

具体按 [Mac 目标准入](docs/validation/mac-target-preflight.md)、[Connection 准入](docs/validation/p1-connection-preflight.md)、[guest / helper 配方](native/macos-sandbox-host/BOOTSTRAP.md) 和 [P1-B 准备计划](docs/plans/p1b-readiness-plan.md) 执行。不要向聊天、Issue 或仓库提交 Key、Token、设备码和私有接入信息。

## 路线图

| 阶段 | 目标 | 当前状态 |
|---|---|---|
| P0 | 可信桌面/Core/模拟执行基础 | 自动化基线通过；部分人工检查未完成 |
| P1-A | 单 Bot 的真实执行代码与无账号验证材料 | 已交付；部分关键独立复审待收尾 |
| **P1-B** | **获准环境中的真实 Sandbox、CLI、Task A/B 与恢复验收** | **下一重点，尚未通过** |
| P2 | 扩展运行时/远程节点、接管与环境维护 | 后续，不要求首个真实闭环先做完 |
| P3 | Orchestrator 动态调度至少三个长期 Bot | 后续 |
| P4 | 来源—检索—采用—结果可追溯的经验复用 | 后续 |
| P5 | 决策模型、受控 Harness 进化 | 后续优化，不作为 V1 前置 |

当前优先级：**完成关键复审 → 准备可复现的首次安装 → 获准 Mac 上验证无账号链路 → 接一条获准连接 → 两项真实任务与故障恢复**。不要因模拟测试增长而跳过真实效果验证，也不要现在重写 P0 或扩成多模型市场。

## 文档与协作

| 阅读目的 | 入口 |
|---|---|
| 理解产品和技术 | [设计基线](docs/design/v1.3/README.md)、[技术设计](docs/design/v1.3/technical-design.md)、[交互设计](docs/design/v1.3/interaction-design.md) |
| 看真实进度和失败历史 | [P0 验证](docs/validation/p0-report.md)、[P1 验证](docs/validation/p1-report.md) |
| 做下一步 | [P1-B 准备与推进计划](docs/plans/p1b-readiness-plan.md)、[P1 任务书](docs/plans/p1-task-brief.md) |
| 核对验收 | [165 项原始映射](docs/plans/v1.3-acceptance-map.md)、[补充执行门禁](docs/plans/p0-p1-execution-gates.md) |
| 接手與交接 | [AGENTS.md](AGENTS.md)、[交接说明](docs/handoff/super-bot.md)、[Issue #1](https://github.com/bill-liu/agent-nexus/issues/1) |

提交前核对最新 main，保留其他执行者的变化，不强推覆盖。验收记录区分合成、离线协议、实际 Mac 包、真实 CLI 和人工检查；没有对应证据就保持 `NOT_RUN` / `BLOCKED`。工具链 smoke 仍独立存在，不替代产品测试。

## 许可证

仓库尚未选择开源许可证。不要将公开可读理解为已授予任意再分发许可；第三方 CLI、镜像和组件的使用与分发条件需单独核验。
