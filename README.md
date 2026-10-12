# Agent Nexus

面向目标、支持持续协作与可验证成长的 Bot Network。产品采用 **Electron 桌面 App，一期仅支持 macOS**；后续再扩展其他桌面客户端。

**当前状态：完整设计已进入仓库，尚未实现产品 App。** 现有代码仍为基础环境检查与 macOS 工具链 smoke。下一步先完成 P0/P1 设计与工程对齐、实施计划和验收映射，再按批准的计划编码；不沿用旧 AN 的固定流程或数据模型，尚未选择开源许可证。

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

Linux 云端用于编辑、版本管理、脚本及后续可移植逻辑检查，不能代替真实 macOS 上的 Electron 窗口、输入法、签名、系统集成和 VM helper 验证。Linux 检查成功仅代表基础工具可用，输出会明确跳过 macOS 编译。可执行 `bash -n scripts/check-toolchain.sh` 检查脚本语法。当前无需在 Linux 安装 Swift 或产品依赖。

## 云端 macOS 工具链 smoke check

`.github/workflows/toolchain.yml` 在 main 推送、面向 main 的 PR 或手动触发时，使用标准 GitHub-hosted `macos-15` runner：

```sh
bash scripts/check-toolchain.sh --require-macos
```

检查当前 Xcode、Swift 和 macOS SDK，并在自动清理的临时目录中编译、链接和运行一个导入 Foundation/AppKit 的最小 Swift 程序。**它仍是环境检查，不代表主界面选择 SwiftUI；也不代表 Electron App 构建、UI 测试、签名或发布通过。** 不打开 GUI、不需要开发者证书。

工作流只使用只读 contents 权限和 runner 自带工具；checkout 固定到提交 SHA。runner 镜像会更新，日志记录镜像版本、Xcode 路径及版本、Swift 版本和 SDK 版本，方便复现问题。P0 再固定产品所需 Electron/Node/模块版本、正式发布架构和最低 macOS；runner 的系统版本不是 App 的最低系统承诺。

本次文档提交不修改 workflow 或工具脚本，不使用 larger runner、不配置账单或 secrets。未来改变资源、仓库可见性或 CI 方案时，先评估权限和费用。

## 后续 Mac 交互调试

需要交互调试时接入装有相应工具链的 Mac，并执行同一严格检查命令。可通过 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bash scripts/check-toolchain.sh --require-macos` 指定已有 Xcode；路径按实际安装调整。脚本不会自动安装 Xcode、接受许可或修改系统配置，缺少工具时会报错。

Electron 主 App、可能使用 Swift 的虚拟化 helper、Sandbox/CLI 驱动分别建立测试和构建证据。依赖、应用测试命令、签名发布与许可证在实施计划中明确，不把设计文档当作已交付软件。
