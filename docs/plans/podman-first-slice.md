# Podman 首个无账号切片

读取 revision：`41671869d78a5c250ee2a839b6aae8358a6f3421`；Issue #1 评论 `6198835980`。完整读取最新 ADR、AGENTS、两个设计索引及交接；v1.3 两份全文沿用相同 blob 的既有阅读回执，本轮重读技术 §07/08/24/25 和交互 §03/14/20/23。对照现有 P1 报告、P1-B 计划及 Provider、Core 初始化、Node channel、GuestRuntimeRegistry 接口。

## 文件与接口映射

| 现有路径 | 本切片处理 |
|---|---|
| `packages/contracts/src/sandbox.ts` | 保留生命周期接口；Podman 观察明确 scripted/live 来源，不用容器状态代替 Run 停止证明 |
| `packages/execution/src/providers/macos-vm.ts` | 保留；新增 `podman.ts` 适配显式引擎、固定镜像、标签、每 Bot 卷及失联对账 |
| `packages/core/src/p1-composition.ts`、`p1-environment.ts` | 增加排他的通用 Provider 注入，保留旧 helper 显式配置兼容；不另建 Core DB/队列 |
| `apps/node-agent/src/channel.ts`、`apps/runner/src/processes.ts` | 复用原 HMAC/full-binding channel、固定 Codex Driver 和 durable Runner；新增窄无账号桥，禁止模型、登录与任意 exec 参数 |
| 旧 Swift helper / Ubuntu / chroot / BPF 制备代码与报告 | 不扩展为默认，不删除，不重记为 Podman 结果 |
| Mac 原生验证器、App 构建及标准 CI | 保留，Linux OCI 不替代 macOS SDK 或独立验收 |

## 切片顺序与证据

1. 引擎/OCI 契约与 Provider：候选 Podman 6.1.4，显式连接 URI、Machine、rootless、共享目录核对；只接受不可变 OCI digest 与版本，已有镜像，不隐式拉取。具名 Bot 的工作与私有状态卷分别归属。同一 Core DB 的 provision 外键行保存 CAS intent/代际/sole-writer，防止普通 provision record 保存覆盖后端意图；inspect 后才允许 owned create/start/stop/destroy；任务结束保留卷。RED→GREEN 合成 CLI 状态机覆盖错身份、摘要漂移、默认连接变化、失联、重复请求与代际。
2. 原 Runner/Codex 无账号桥：固定 `podman exec --interactive` stdio，不挂引擎 socket、不发布端口、不接纳 Renderer 命令。合成端使用原 Node channel/GuestRuntimeRegistry/固定 Driver；证明无账号 initialize、全 binding、取消与未知写者阻塞，不称真实 CLI/容器已运行。
3. 私有 OCI 构建输入契约与待实测清单：不编造已经构建的 digest，不拉取大镜像或发布公共镜像。真实 Mac/Podman 安装、Machine 资源、OCI 下载与启动须另获具名范围授权。旧 VM 授权包作废，不再请求外部 ARM64 制备机。
4. 范围审查、typecheck/定向与全量合成回归、build；非强推 main，读取 own-SHA 标准 CI。真实与合成结果分别记录。

## 门禁替换

| 原门禁 | Podman 需要的新证据（当前均非 live PASS） |
|---|---|
| GATE02 | 官方 Machine/显式连接/固定 OCI/私有卷 → Runner readiness；替代 raw/EFI/外部制备链 |
| GATE10/14/19 | 容器用户、挂载与跨 Bot auth canary/写保护；不能由 rootless 字样推定 |
| GATE11/12 | 首切片 network:none；具名 Connection/网关与细粒度出站能力另验，不能由网络开关替代 |
| GATE13 | 原 Run 完整停止证明与单写槽位；容器 running/CLI exit/exec EOF 均不足；未知保持占用 |
| GATE16/17/18 | 新 Podman 具名设备/资源授权、空认证初始化与真实隔离探针；不沿用旧 VM 授权 |
| GATE20 | Machine 内卷不是备份；普通备份排除私有状态，恢复不自动复活旧授权/写者 |
| GATE01、03–09、15 及其余 165 项 | 原契约继续；按 Provider/平台/候选重新取证，不整体宣布等价 |

## 版本依据与限制

候选 CLI/服务版本为 [Podman 6.1.4](https://github.com/podman-container-tools/podman/releases/tag/v6.1.4)，源码提交 `464c15fec06f0074c916f9eff87c4806869c2833`。参数以该提交的 `docs/source/markdown/` 为准：`podman.1.md`（connection/remote）、`podman-system-connection-list.1.md`（JSON）、`podman-machine-inspect.1.md`、`podman-create.1.md.in`、`podman-exec.1.md.in` 及其 options includes。这是实现候选版本，尚无目标 Mac 兼容性或安装实测。

当前云 Linux 无 Podman。本轮不安装、不启动 Machine/容器、不拉取 OCI、不生成管理密钥/凭据、不登录、不调用模型、不配置账单。默认桌面入口仍按保护准入阻塞，不能把仅代码接线展示成用户可用首装。
