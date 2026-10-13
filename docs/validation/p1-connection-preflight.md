# P1 具名 Connection 准入记录

设计基线 v1.3；实现起点 `5aa3e5a547985342a147e36f0904912ee6735765`。本表不创建 Connection、Grant、官方登录或模型调用。

| 字段 | 当前值 |
|---|---|
| connectionId | `personal-codex-p1`：候选，UNCONFIRMED |
| validationTargetId / 用户批准引用 | UNCONFIRMED |
| 使用主体、目的、账号/工作空间私有引用 | UNCONFIRMED；不保存原始邮箱 |
| Runtime/版本/认证方式 | 候选 Codex 0.159.2 官方运行时登录；实际目标与适用授权 UNCONFIRMED |
| 计费来源与证据级别 | UNCONFIRMED；不得从浏览器完成或 authMethod 推断订阅/零费用 |
| 节点、Sandbox generation、项目、Bot 范围 | UNCONFIRMED |
| 模型、端点、direct/gateway 路由 | UNCONFIRMED |
| 资料政策与传送位置 | UNCONFIRMED；私有资料默认留本地 |
| 调用次数、时长、费用及可执行硬限制 | UNCONFIRMED；未确认前不开展真实模型调用 |
| 备用策略 | deny / ask_user；禁止静默切 API、借其他账号或绕过网关 |
| 撤销方式与清理范围 | UNCONFIRMED；AN 撤权不等于撤回已发出请求 |
| 实际登录、认证/账单观察、连续 Task A/B | NOT_RUN |

受信配置提供非秘密 Connection 元数据；Renderer 只能选择现有具名连接，选择持久化但不产生授权。Grant、实际认证、Runtime、Node 与资料政策由现有 Resolver 在准备和派工时复验。默认准备模式不搜索开发机凭据，不写入候选 Connection，不混入 P0 演示连接。

只有获准 API/网关秘密才经系统保护 Broker 专用通道保存。原生订阅 Token 由 Sandbox 内官方运行时维护，设备码只进入专用临时授权界面；不得进入本文件、事件、草稿、日志、fixture、Issue 或普通导出。

## 已实现的显式入口与未支持路径

`AN_APP_MODE=p1-preparation` 默认为未准入。只有明确指定同用户 0600 的 `AN_P1_ADMISSION_FILE` 才安装具名非秘密元数据；其可引用同样受保护的 runtime 配置。配置定义精确 helper 摘要/authority、Node 私有 socket/key 路径、Runtime/policy 摘要、固定 guest HOME/cwd/profile、受信 oracle/verifier binary/store，以及 Task A/B 契约引用。字段以 `P1Admission` 和 `InstalledRuntime` 的严格解析器为准；public 仓库不放实例秘密或实际个人接入信息。

官方授权须显式配置 `loginKind`（browser/device）并同时具有 `login`、`initialize-runtime` 等获准动作。开始只初始化独立 guest app-server，不创建 Task turn；完成核验、取消和 owned cleanup 使用同一绑定。URL/设备码仅在临时授权通路，不进普通快照/SQLite；过期、撤权、连接版本变化或未知结果不重走另一账号。真实 installed 登录装配目前只具代码/合成协议证据，live NOT_RUN。

真实候选只从认证 Node 固定 workspace 获取；Core 重验有界快照并保存，B 开始前必须仍等于已验收 A。超过 160000 字节当前明确不支持，不用宿主手工镜像替代。当前准备记录没有实施 live 调用/Token/费用硬限制的证明，金额声明不等于控制；B 前须明确可执行边界及不能精确限制的部分。
