# P1 Mac 目标准入记录

设计基线：v1.3；实现起点 `5aa3e5a547985342a147e36f0904912ee6735765`。本记录是准备材料，不是已接入或验证结论。

| 项目 | 当前事实 / 状态 |
|---|---|
| validation_target_id | UNCONFIRMED；尚未分配获准验证目标 |
| 候选设备 | 用户自有 Mac mini M4，仅方案候选，UNCONFIRMED |
| 所有者、测试者、可用窗口 | UNCONFIRMED |
| 实际 macOS / CPU / 内存 / 磁盘 | UNCONFIRMED；未读取用户设备 |
| GUI 会话与显示器 | UNCONFIRMED |
| 安装目录、网络、资源、时限、停止/清理范围 | UNCONFIRMED；仅保存于批准的私有配置 |
| VM/helper/Node 可用性 | BLOCKED：未授权安装、启动或接入 |
| 镜像许可/来源/摘要与 helper entitlement | 待 A3 配方在获准目标逐项核验；此表不批准再分发 |
| Electron 包源码 SHA / 包 digest | NOT_RUN；由实际 Mac CI package-evidence.json 填写 |
| 标准 macOS CI | 可用于实际包自动化；没有证据证明嵌套 VM 可用 |
| 用户 Mac 接入 / VM 启动 / CLI 初始化 | NOT_RUN；P1-B 授权未确认 |

获准后先只读探测实际系统，再按单独获准范围下载、安装和启动。保持原 Bot/operation，记录同一源码及包摘要。每次实际检查记录命令、退出码、脱敏证据路径、测试者及时间。不得公开家庭地址、IP、主机接入凭据或账号邮箱。人工项另见 [P0 Mac 清单](p0-manual-mac-checklist.md)，不能从自动 CI 填 PASS。
