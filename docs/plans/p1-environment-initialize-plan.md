# N3-0 无账号环境初始化切片

> 执行：`superpowers:executing-plans`，GPT6.1-SOL high 单路；最后一次串行独立差异审查。

**Goal:** 实现 runbook §6 已批准的环境 prepare/initialize 业务入口，仅代码和合成验证。
**Architecture:** 复用 Main/Core、单 SQLite、Bot/provision、同一 VM helper 和已鉴权 Node channel。环境准入与 Connection/model/login 分离；不建安装器或新控制平面。
**Tech Stack:** 当前锁定 TypeScript/Electron/SQLite/Swift/Node/Driver，不新增依赖。
**Spec:** v1.3 technical-design §4/6/7/8/12/14/18/19/21–24、interaction-design §3/14/20/23/24；p1-task-brief A3/A6/B1、原 GATE02/10/13/16/18/19，p1-bootstrap-runbook §6。
**Revision:** c40a4b5cb99e78d2c5873644abe902ee07f26245；Issue #1 评论6138431132，最新用户明确授权N3-0。

## Global Constraints

仅合成协议/私有小文件，禁止真实VM、盘、安装、签名、用户设备、账户/凭据、登录、模型和费用。普通启动无动作；没有目标操作授权拒绝。Task结束不destroy、长期数据保留。未知执行结果不重播；原live/人工门禁不改为PASS。

## Review Focus

1. 权限或私有配置在await期间撤销：后续forward零调用，原owner清理不依赖新登录权限。
2. start/connect/initialize/stop回执丢失：持久未知保留，不生成替代writer。
3. epoch/fence、目标/完整binding、generation被替换：拒绝转移旧控制权。
4. 重复点击/两窗口/排队或认证竞争：同command查询，不同command不并发启动。
5. initialize不等于认证或当前在线：空认证配置/network none核验，分段事实含时间与清理结果。

## Task 1：准入与生命周期（一个可审查单元）

Files: contracts/events.ts、core/p1-environment.ts、core/p1-environment-admission.ts、core/p1-installed.ts（共享已鉴权channel）、core/p1-application.ts、core/bot-provision.ts、execution/providers/macos-vm.ts、native helper、Node/control.ts 与p1-bootstrap.ts；对应contract测试。
Interface: `prepareEnvironment({commandId,botId,expectedVersion}, subject)`，固定initialize 0.159.2；private `purpose:environment-initialize`准入只含具名目标/期限/操作/安装引用，不含ConnectionGrant。复用provision操作；短事务claim/fence，网络在事务外。
- [x] RED：默认/无授权无调用、0→1成功、已running精确复用、未知/错代际/失效/撤权/绑定替换/epoch/并发/清理失败保留，私有准入注入字段拒绝，空auth/none网络实际检查。
- [x] GREEN：受信初始化入口，同helper inspect/create/start/connect；原provision durable intent阻止重播；固定guest initialize/attestation；owned native/VM清理；分别environment/runner/runtime/auth，auth始终false。
- [x] Verify：定向contracts、typecheck、全npm test、build、diff check（各退出0）。

## Task 2：桌面接线、记录与发布

Files: Main/Preload/Core-worker、Renderer环境卡、contract边界、Mac已有包检查，runbook/report/readiness回执。
Interface: 窄业务输入只有commandId/botId/expectedVersion；frame/write/quit/Core版本检查，不接exec/path/raw RPC/authority字段。私有启动配置不自动触发prepare。
- [x] RED→GREEN：Core/desktop窄业务路径及默认阻塞；保留已有P0/P1演示。
- [x] Verify：完整本地回归，一次独立审查；Critical/Important根一次RED→GREEN修正，Minor披露。
- [ ] 发布：刷新main、预期head检查非强推；读取本提交四组CI终态/日志/产物，Issue1回执；停在真实N3目标/分项操作准入前。
