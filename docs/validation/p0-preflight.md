# P0 实施依赖与平台检查

执行基线：`c705282e7eb69528c0da1ac7b506ff43f0e21427`；用户于 2026-10-12 16:32:35 UTC 批准 P0。设计两稿、实施计划、评审与 165 项映射已完整读取；设计原文未变。

## 已落实的依赖

所有直接包使用精确版本，传递依赖记录在 `package-lock.json`，普通 npm 官方 registry 下载。没有选择本项目开源许可证；依赖自身许可证不替代项目许可。没有安装或登录新的模型 CLI。

| 组件 | 固定版本 / 用途 |
|---|---|
| 开发 Node / npm | 24.19.0 / 11.9.0；CI 明确 Node 版本，lockfileVersion 3 |
| Electron | 44.7.0；本地实测内置 Node 24.21.0、ABI 149 |
| SQLite | Node 内置 `node:sqlite`；开发 Node 为 3.53.3，Electron 为 3.53.4；无第三方 native addon 重编译 |
| React / React DOM | 19.3.0；本地捆绑 Renderer |
| TypeScript / esbuild | 7.0.2 / 0.28.2；严格类型检查及离线资源打包 |
| Vitest | 5.0.4；实际 SQLite 的逻辑/协议/故障测试 |
| Playwright Test | 1.64.0；启动实际 Electron 开发包，不启动网页开发服务器 |
| Electron Packager | 20.3.0；仅开发 `.app`，无签名/公证/发布配置 |
| 类型包 | `package.json` 与锁文件精确记录 |

开发复现：Node 24.19.0 下 `npm ci` → `npm run install:electron` → `npm run preflight` → `npm run typecheck` → `npm test` → `npm run build`。Electron 44 npm 包的安装二进制通过其官方 `install-electron` 命令显式获取；安装 npm 包本身不足以证明 Electron 可运行。

本云执行器 `/home/agent/.npm` 不可写，已通过命令级 `npm_config_cache=/workspace/an-npm-cache` 解决，未修改用户 HOME 或系统权限。Node 下载器直连最初报 `fetch failed` / `EAI_AGAIN`；启用现有代理 `NODE_USE_ENV_PROXY=1` 后官方安装器完成下载与 checksum 校验，未禁用 TLS、未使用第三方镜像。需要此代理的云环境可设置命令级 `electron_config_cache` 到可写缓存目录；普通 Mac/CI 不依赖本地绝对路径。

## 已执行的隔离探针

2026-10-12，Debian 13 / Linux x64：

- Node `DatabaseSync(':memory:')` 执行 `select sqlite_version()`：3.53.3。
- `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -e '<版本及临时 SQLite 查询>'`：Electron 44.7.0 / Node 24.21.0 / SQLite 3.53.4。
- 此探针只确认二进制内置 SQLite；不证明 utilityProcess、Renderer、Mac 包、VM 或真实 CLI 已通过。
- 无账号 CLI `initialize` 的前置隔离探测 **BLOCKED**：`bwrap --unshare-all --die-with-parent --clearenv ... /usr/bin/true` 返回 `bwrap: setting up uid map: Read-only file system`（退出码 1）。探测未挂载宿主 Home/认证目录、未联网，也未启动 CLI session。没有降级到宿主 CLI；后续需可用且获准的 Sandbox。离线 `generate-json-schema` 的证据单独见 [审批协议记录](cli-approval-contract.md)，不能替代真实初始化。

Electron 安装包 README 声明支持 macOS Ventura 起；AN P0 **暂将可验证基线收窄到 macOS 15**，Info.plist 明确 15.0。不据此声明更早 macOS 或未经检查的 CPU 已受支持；打包和自动化证据记录 runner 的实际架构，另一架构待独立验证。平台兼容性变更需重新验证。

## 失败矩阵与 P1 门禁

| 检查 | 失败处理 |
|---|---|
| Node 版本或锁文件不符 | 重新按记录版本 `npm ci`；不能去掉锁文件求通过 |
| Electron 二进制未安装 | 明确运行官方安装器；npm 包存在不当成功 |
| Core worker 缺 SQLite 或无法启动 | 禁止写命令；实际包测试失败；不换成 Renderer 数据库 |
| 非 Mac 执行 package:mac | MAC_REQUIRED，非零退出 |
| 错误架构/缺库 | 报具体错误；只认实际包启动，不认下载完成 |
| 无 GUI / 无 VoiceOver / 无中文 IME | 自动化与人工项分栏；缺失项 BLOCKED，不用 fake 测试替代 |
| VM/helper/嵌套 sandbox | P1 尚未实现/未验证；不退到宿主 CLI |
| 真实 Runtime/Auth | P1 未授权；`npm run preflight -- --profile runtime-auth` 非零阻塞，不登录或调用模型 |
| 具名 Connection 与 Mac 目标 | 主线程明确账号/用途/计费/节点/许可及可用 Mac，确认后才进入 P1 |

macOS CI 的真实 Electron 开发包结果记录在后续 `p0-report.md`；现有 Swift 工具链 smoke 保持独立。用户 Mac 当前未开放访问。本轮不创建账号、密钥、签名、付费设施或真实连接。
