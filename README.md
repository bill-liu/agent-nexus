# Agent Nexus

新的原生 macOS App 项目，当前仅准备开发环境。产品设计文档尚未提供；暂不创建 App 工程、不沿用旧版架构、不引入产品第三方依赖，也尚未选择开源许可证。

## 云端开发与检查

```sh
git clone https://github.com/bill-liu/agent-nexus.git
cd agent-nexus
bash scripts/check-toolchain.sh
```

已有 SSH 授权时也可使用 `git@github.com:bill-liu/agent-nexus.git`；不需要为环境检查创建密钥或 secrets。基础要求为 Git、Bash 3.2+ 和系统常用命令。脚本不安装软件、不修改 Xcode 选择或全局配置。

Linux 云端用于编辑、版本管理与脚本检查，无法完整构建或交互调试原生 macOS App。Linux 检查成功仅代表基础工具可用，输出会明确跳过 macOS 编译。可执行 `bash -n scripts/check-toolchain.sh` 检查脚本语法。当前无需在 Linux 安装 Swift 或产品依赖。

## 云端 macOS 工具链 smoke check

`.github/workflows/toolchain.yml` 在 main 推送、面向 main 的 PR 或手动触发时，使用标准 GitHub-hosted `macos-15` runner：

```sh
bash scripts/check-toolchain.sh --require-macos
```

检查当前 Xcode、Swift 和 macOS SDK，并在自动清理的临时目录中编译、链接和运行一个导入 Foundation/AppKit 的最小 Swift 程序。没有 App target，因此 **smoke check 成功不代表应用构建、UI 测试、签名或发布通过**。不打开 GUI、不需要开发者证书。

工作流只使用只读 contents 权限和 runner 自带工具；checkout 固定到提交 SHA。runner 镜像会更新，日志记录镜像版本、Xcode 路径及版本、Swift 版本和 SDK 版本，方便复现问题；设计确定后再固定产品所需工具链与最低 macOS 版本。当前 runner 的操作系统不是 App 的最低系统版本承诺。

仓库当前为 public；[GitHub 标准 runner 文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)说明标准 runner 对公开仓库免费。不使用 larger runner，不配置账单。如果未来改为 private，先重新评估 Actions 额度和费用。

## 后续 Mac 交互调试

需要交互调试时再接入装有完整 Xcode 的 Mac，并执行同一严格检查命令。可通过 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bash scripts/check-toolchain.sh --require-macos` 指定已有 Xcode；路径按实际安装调整。该脚本不会自动安装 Xcode、接受许可或修改系统配置，缺少工具时会报错。

待设计文档提供后再确定工程组织、界面方案、数据与代理架构、依赖、应用测试与构建命令、签名发布流程和许可证。
