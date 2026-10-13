# Agent Nexus

面向目标、支持持续协作与可验证成长的 Bot Network。产品采用 **Electron 桌面 App，一期仅支持 macOS**；后续再扩展其他桌面客户端。

**当前状态：P0 本地演示及 P1-A 无账号准备代码。** 默认启动仍是明确标注的 FakeRuntime；`AN_APP_MODE=p1-preparation` 使用独立准备数据库，复用单一 Core、审批、连接与资产服务，默认不安装环境、登录或调用模型。异步 Runner、VM helper/Node、受保护认证、固定 Task A/B 独立验收与桌面接线见 [P1 验证记录](docs/validation/p1-report.md)。真实 Mac/VM 与具名 Connection 的 P1-B 仍未获准；实现与无账号 CI 通过不能替代 P1 完成。尚未选择开源许可证。

## 设计与 super bot 交接

- [当前设计入口 v1.3](docs/design/v1.3/README.md)
- [产品与技术详细设计](docs/design/v1.3/technical-design.md)
- [界面与交互详细设计](docs/design/v1.3/interaction-design.md)
- [super bot 交接与下一步](docs/handoff/super-bot.md)
- [Agent 协作约定](AGENTS.md)

设计全文保存在本仓库，不需要用户在聊天中下载再上传。v1.3 替代旧附件 v1.0/v1.1/v1.2；请完整阅读，不只读摘要。

核心：长期 Bot + 动态 Goal/Task Graph + Learning + Runtime Kernel。Bot 专属 Sandbox 不随任务结束销毁，Codex/Cursor/Claude Code CLI 都在 Sandbox 内运行。配套 Resource Server 提供基础环境、模板、版本与下载；用户私有资产和权威任务控制一期以本地 Core 为主。连接由用户显式选择账号/计费来源，默认不静默跨来源切换。

## 云端开发与检查

```sh
git clone https://github.com/bill-liu/agent-nexus.git
cd agent-nexus
bash scripts/check-toolchain.sh
```

已有 SSH 授权时也可使用 `git@github.com:bill-liu/agent-nexus.git`；不需要为环境检查创建密钥或 secrets。基础要求为 Git、Bash 3.2+ 和系统常用命令。脚本不安装软件、不修改 Xcode 选择或全局配置。

Linux 云端用于编辑、版本管理及逻辑检查，不能代替真实 macOS 上的 Electron 窗口、输入法、签名、系统集成和 VM helper 验证。基础工具脚本在 Linux 明确跳过 macOS 编译，无需安装 Swift。

云端开发使用 Node 24.19.0、npm 11.9.0 和锁文件：

```sh
npm ci
npm run preflight
npm run typecheck
npm test
npm run build
```

在获准 Mac 上执行 `npm run install:electron`、`npm start` 可打开演示；`npm run package:mac` 生成未配置发布签名或公证的开发包。实际包测试需将输出 `out/package-evidence.json` 中的 `executable` 设为 `AN_PACKAGED_EXECUTABLE`，再执行 `npm run test:electron` 和 `npm run test:mac`。复现细节与平台阻塞见 [P0 preflight](docs/validation/p0-preflight.md)。

## 云端 macOS 工具链 smoke check

`.github/workflows/toolchain.yml` 在 main 推送、面向 main 的 PR 或手动触发时，使用标准 GitHub-hosted `macos-15` runner：

```sh
bash scripts/check-toolchain.sh --require-macos
```

检查当前 Xcode、Swift 和 macOS SDK，并在自动清理的临时目录中编译、链接和运行一个导入 Foundation/AppKit 的最小 Swift 程序。**它仍是环境检查，不代表主界面选择 SwiftUI；也不代表 Electron App 构建、UI 测试、签名或发布通过。** 不打开 GUI、不需要开发者证书。

工作流只使用只读 contents 权限和 runner 自带工具；checkout 固定到提交 SHA。runner 镜像会更新，日志记录镜像版本、Xcode 路径及版本、Swift 版本和 SDK 版本。P0 的依赖已固定，开发包验证基线暂为 macOS 15；未经实际检查的 CPU 架构或更早系统不计入支持范围。

现有 `p0.yml` 在标准 GitHub-hosted Linux/macOS runner 执行契约和实际 Electron 开发包测试；与 Swift smoke 分开报告。不使用 larger runner、不配置账单或 secrets，不发布 App。

## 后续 Mac 交互调试

需要交互调试时接入装有相应工具链的 Mac，并执行同一严格检查命令。可通过 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bash scripts/check-toolchain.sh --require-macos` 指定已有 Xcode；路径按实际安装调整。脚本不会自动安装 Xcode、接受许可或修改系统配置，缺少工具时会报错。

Electron 主 App、可能使用 Swift 的虚拟化 helper、Sandbox/CLI 驱动分别建立测试和构建证据。依赖、应用测试命令、签名发布与许可证在实施计划中明确，不把设计文档当作已交付软件。

## P1 准备与后续具名接入

在获准的交互 Mac 上，可用 `AN_APP_MODE=p1-preparation npm start` 打开准备界面。创建 Bot 和排队只保存本机状态；环境、Runner、Runtime、auth 分别显示。系统文件面板可绑定知识、文本 Skill 或规约，默认仅本机，不授予脚本或远程处理权限。原 P0 演示数据库不混入此模式。

真实路径只读取明确指定的 `AN_P1_ADMISSION_FILE`，文件须为同用户、规范绝对路径、0600、当前有效；可引用另一份受保护 runtime 配置。字段和限制见 [Mac 目标准入](docs/validation/mac-target-preflight.md)、[Connection 准入](docs/validation/p1-connection-preflight.md) 和 [guest/helper 配方](native/macos-sandbox-host/BOOTSTRAP.md)。这些示例和代码不构成设备或账号授权。没有配置时显示阻塞，不搜索宿主 CLI、账号或凭据。

标准 CI 另编译 Swift helper 和原生 JavaScriptCore verifier；固定合成对照不启动 VM/Agent CLI。宿主开发包中随附现有固定版本 esbuild，仅转换候选文本，不在 Node 执行候选。guest 独立入口为 `node scripts/start-guest-node.mjs --apply <受保护 guest 配置>`，必须先在另行获准的安装过程中部署 build/guest-node.cjs 和 gate；桌面不会自动安装或启动 guest。

当前真实装配面向已安装并获准的单一 Codex Sandbox。无无人值守初装、完整同次主机启动崩溃恢复、域名/端口级网关或每 Bot 文件系统配额；原生 verifier 没有硬物理内存上限证明。未知结果保持阻塞，具体未支持项和 NOT_RUN 项列在验证记录，不能只补一份授权就视为全部门禁已通过。
