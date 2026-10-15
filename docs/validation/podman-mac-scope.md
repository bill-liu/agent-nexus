# Podman 候选 Mac 验证范围（待用户确认；未执行）

候选代码：本提交及其 own-SHA 四组 CI，以 Issue1 最终回执固定；不能用旧 be16a84 的包摘要代表本候选。目标仅 **一台具名 Apple Silicon Mac / macOS15+、一个 Bot、一个明确选定的已有 Podman Machine/connection、无账号初始化**。不沿用旧 VM 批准，不需要外部 ARM64 制备机。

## 一次填写的具名范围

请由操作者在本机受保护记录中确认以下字段，不能提交公开仓库/Issue：设备友好名、设备 IOPlatformUUID 的小写文本 SHA256（不上传原 UUID）、操作者、时间窗口、Bot/持久 Sandbox/provision 身份、选定 machine/connection、URI、已有 SSH identity 路径、Machine 配置路径、Podman 可执行真实路径与 SHA256、OCI 单平台 manifest digest/版本/源码 revision、容器 CPU/内存/PID 上限，以及授权来源记录。不能把这些值从聊天猜出来。

本切片受保护配置用途为 `podman-environment-prepare`，operator仅 `local-user`，version1。需逐项列出：inspect、create-volumes、create-container、start-container、connect、initialize-runtime、stop-owned-container。另给明确 cleanupExpiresAt；不早于普通 expiresAt、最多晚1小时。它仅允许原操作在取消、过期或引擎选择变化后，在同一 owner/epoch 下查询并停止**原来确切归属的 Bot 容器**；不准开始新动作或停止共享 Machine。无有效停止授权/证据则保持 UNKNOWN。UI 确认按钮不创建授权，Renderer 不接受路径、shell、资源或授权布尔。

## 候选来源与预算

| 项目 | 固定候选 / 来源 | 已知与未知 |
|---|---|---|
| Podman CLI / 服务 | 6.1.4，[官方 release](https://github.com/podman-container-tools/podman/releases/tag/v6.1.4)，源码464c15fec06f0074c916f9eff87c4806869c2833 | Mac安装包具体资产、SHA、压缩下载与安装后磁盘量尚未捕获；不下载、不安装 |
| Podman Machine OS | [6.1.4官方init文档](https://github.com/podman-container-tools/podman/blob/464c15fec06f0074c916f9eff87c4806869c2833/docs/source/markdown/podman-machine-init.1.md.in)指定官方 quay.io/podman/machine-os | 平台对应版本/digest/下载大小尚未锁定；Machine RAM/CPU/虚拟盘/宿主实际占用未知，不能沿用旧4GiB/50–70GiB估算 |
| OCI Node基底 | docker.io/library/node，24.19.0-bookworm-slim，Linux/arm64 | 必须另锁单平台 digest；拉取字节、展开层和共享缓存增量未知 |
| Codex CLI | 0.159.2，[官方release](https://github.com/openai/codex/releases/tag/rust-v0.159.2) | Linux/arm64制品、归档校验/签名/许可与原生可执行SHA仍需对应制品核验；本轮不取二进制、不登录 |
| AN Runner镜像 | 版本/源码revision/公开输入hash由context工具固定 | **NOT_BUILT，OCI digest未知，下载字节未知**；contextInputBytes仅本地公开输入字节和，不能当镜像/磁盘预算 |
| 容器与工作卷 | 用户具名配置CPU/内存/PID上限；每Bot work/private两卷 | 上限不是实测峰值，未提供配置时不设虚构默认预算。卷增长/配额/备份空间未知；Machine内卷不是备份 |

任何未知下载量/资源预算都必须在真正下载或分配前补齐元数据与用户可接受的上限；不能把“未知”视为无限授权。当前代码不含安装器、拉取器或Machine管理器。

## 本次可单独确认的最小只读阶段

- 仅在具名设备/窗口中读取系统版本、架构、可用磁盘/内存和已安装 Podman 真实路径/版本/摘要；本地读取 IOPlatformUUID 后只保留hash，不记录原UUID。
- 只读取既有 connection清单、具名Machine inspect和该Machine的受保护配置，核验显式SSH端点、已有identity路径、rootless/cgroupv2/controllers、Home/其他宿主共享与冲突机器。使用已有管理identity访问选定引擎也须本项明确批准；不输出私钥内容。
- 只有已经存在且digest固定的镜像，才对该digest做 image inspect；不自动拉取。记录实际JSON字段，更新脱敏fixture后再判断兼容性。
- 无 Podman/无选定引擎/有默认Home共享/版本或设备不符时立即止步，交付事实；不自动修改全局默认或停止任何现有资源。

## 必须额外明确确认的操作（不包含在只读阶段）

1. **安装 Podman CLI：**确切官方安装资产、校验、下载上限、安装目录；若 .pkg 需要管理员认证，由用户在系统界面单独完成，不收集密码、不设置账单。
2. **创建/启动 Machine：**官方OS digest/下载上限、CPU/RAM/虚拟盘上限、机器名、零宿主共享的受测配置，以及Podman自动生成持久SSH管理密钥/新增system connection。官方init默认可共享Home，当前代码拒绝此状态；禁用默认共享的命令必须按锁定版本与目标实测确认后才能采用，不靠未验证命令串绕过。
3. **OCI私有构建/拉取：**基础镜像及CLI精确制品hash/许可、下载与展开磁盘上限、构建上下文、私有本机存储位置；先有真实构建digest，再允许Provider使用。公共发布、镜像签名发行不在此范围。
4. **单Bot容器/卷/无账号验证：**仅指定镜像和两具名卷，network:none、非特权、无宿主bind/socket/管理密钥、无端口发布；固定Codex initialize，之后确认本地exec client关闭并停止该Bot容器。记录资源前后/峰值、持久化、重复点击/取消/失联/跨Bot/子写者负例。现有容器若Stopped≥1或未知owner须先对账；不能以授权代替尚未实现的冷恢复。
5. **账号、原TaskA/B、出站和备份：**另有具名Connection/数据/费用/网络网关授权及能力验证。普通备份排除private卷；敏感备份另确认。任何删除/重置/prune、修改全局连接、停无关Machine/容器、额外系统权限、Home共享、特权/关闭保护、公共镜像发布都不在本范围。

当前没有上述真机批准，没有安装、下载大制品、生成管理密钥、创建Machine、启动容器、使用账号或模型。部分真实字段/执行效果只有接入具名引擎后才能核验；这些保持 BLOCKED/NOT_RUN，其他云端代码与合成回归照常完成。

## 当前代码的恢复限制

- Bot.version 在准备中变化（例如点击暂停）会使原意图失效，包括原容器清理。当前保持 UNKNOWN、拒绝后续写者，可能留下运行中的 AN 空闲容器；不能把退出 App 当作该容器已停。这一情况仍需受信 owner/版本对账代码及具名目标实测，不以停止共享Machine绕过。
- 现有环境卡只显示通用软件来源/版本，尚未展示已选 Runner OCI 的完整 version/digest/source revision；独立审查列为 Minor。真正批准前应在受保护配置及公开输入manifest中逐项核对，不能仅凭UI计划hash批准未知镜像。
