# Podman 桌面准备接线

读取基点 `be16a84dc1131c5ff354357401ad18e52618432a`，沿用 4167186 ADR、首切片计划、runtime/podman/README、最新 AGENTS 与 P1 报告。设计 blob 未变，复用此前全文阅读记录。用户已授权本轮云端串行实现与 main 提交；没有真机、安装、拉取、Machine/容器启动、持久管理凭据或账号授权。

1. 保持现有准备 IPC 三字段输入（commandId/Bot/version），增加同样窄的取消业务方法。受保护文件显式选择 Podman 引擎/固定镜像/具名授权，由 Core 校验 owner/epoch/Bot version/plan digest/有效期和动作集合；不接受 Renderer 提供路径/命令/授权布尔。复用同一 provision 身份、Core DB、Podman Provider 与无账号 Runner adapter。短事务记录意图后才有副作用，重复点击查原操作，未知不重放。取消不清卷，失去停止证明不释放写者。
2. 环境卡展示候选来源/版本、选定引擎、计划摘要、分项操作/资源/下载预算和授权/阻塞状态，不泄露管理路径/URI/凭据，不以确认按钮自授真实权限。默认无配置失败关闭。安装、拉取、Machine 管理未实现时列阻塞；仅已安装/已在运行且经新范围授权的具名目标可进入既有 Provider 通路。补固定公开输入的 OCI context 工具，验证所有输入摘要、架构及来源契约；不下载/构建镜像，不输出假 OCI digest。输出一次确认的 Mac 验证范围及须另确认动作，未知预算明示阻塞。
3. 关键负例先 RED→GREEN（注入/未知字段、重复命令、取消、过期/撤权、引擎选择变化、owner/版本变化、失联不重试、scripted 不报live readiness）。一次针对这条路径的串行独立审查，根一次修正后全回归/typecheck/build/diff；授权非强推 main，读取自己的四组 CI 并更新 Issue1。

不新增通用安装平台，不实现模型/登录/Connection 切换，不清理旧后端或验证历史。真实 JSON 字段、Machine 官方来源/共享、资源效果、传输取消和隔离能力仍需具名 Mac 实测；不能由合成样例判定通过。


## 两项后续收口（基点 f91f3f0）

用户明确要求串行完成：先以失败回归固定暂停/版本变化造成原容器无法清理，再将正常版本准入与同一存活owner/epoch/原绑定的有界cleanup分开；未知进程保持写者锁。随后环境卡补完整Runner OCI声明及NOT_BUILT/缺失状态。复用现有Provider，不做跨owner恢复或安装平台。只读取官方候选安装资产大小/发布摘要，资源与下载上限仍待具名确认。针对两项改动一次串行独立审查，根修正及完整回归/包测试后按既有授权非强推main，读取own-SHA CI；不执行Podman安装、拉取、Machine/容器启动或凭据生成。
