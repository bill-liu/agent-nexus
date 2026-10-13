# Runtime/Auth 分用途预检

实现基点 `5aa3e5a547985342a147e36f0904912ee6735765`，设计 v1.3。固定离线契约沿用 [Codex 审批协议记录](cli-approval-contract.md)。本次没有运行宿主 Agent CLI、真实 VM/官方初始化、登录或模型轮次；官方当前许可与真实目标配置未在本记录重新核实。

| 用途 | 技术实现 / 授权核验 | 实际结果 |
|---|---|---|
| 本地个人验证 | 候选 Codex 0.159.2 app-server；具名设备、账号、费用和数据范围待确认 | BLOCKED / UNCONFIRMED |
| 本地开源发行 | CLI 安装与再分发许可、认证集成适用性需按发布版本核验 | NOT_RUN |
| 商业或托管 | 独立产品用途与厂商条件核验；不能由个人本地可运行推导许可 | NOT_RUN |
| 其他 CLI / 网关 | 本次未选，不自动改变用户计费来源 | NOT_RUN |

官方核验入口：[Codex 认证](https://developers.openai.com/codex/auth/)、[App Server](https://developers.openai.com/codex/app-server/)。这些是后续准入参考，不是当前核验结论。执行前记录核验时间、固定版本、用途、实际来源和适用条件。

隔离配置必须固定 Bot HOME / CODEX_HOME / XDG 目录、环境白名单、Node/Sandbox/process/transport 代际；清理冲突采用独立进程配置，不删除用户宿主登录。认证检查只返回元数据，账单未报告时保留 unknown。调用前复验 Grant、同一实际进程及认证状态，失效不得使用其他 Key。官方设备码/回调/原生缓存不进入普通 Renderer 状态或审计。

准入条件详见 [Mac 目标](mac-target-preflight.md) 与 [Connection](p1-connection-preflight.md)。缺用户设备授权只阻塞 P1-B；缺实际 native-channel/helper 组装代码要记录为 BLOCKED_CODE，不能伪称仅等授权即可运行。
