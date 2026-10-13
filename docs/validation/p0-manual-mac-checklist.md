# 实际 Mac 包人工检查

本记录不覆盖或改写 [P0 自动化结果](p0-report.md)。所有项目当前 **NOT_RUN**：本次在 Linux 开发环境实现代码，未操作用户 Mac。

执行前填写：测试者 **UNCONFIRMED**；时间 **UNCONFIRMED**；具名目标 **UNCONFIRMED**；macOS/架构 **UNCONFIRMED**；源码 SHA **UNCONFIRMED**；实际包 SHA-256 **UNCONFIRMED**；package-evidence.json 引用 **UNCONFIRMED**。同一包分别记录 P0 演示与 P1 准备；不能将准备界面视为真实任务成功。

| 场景 | 操作与观察要求 | 结果 |
|---|---|---|
| 中文 IME | 拼音候选 Return 不提交；⌘Return 一次提交；多行粘贴与撤销正常 | NOT_RUN |
| VoiceOver | 主导航、表单、标签、审批参数及错误可读；焦点顺序正确；不逐 token 抢焦点 | NOT_RUN |
| Retina / 系统缩放 / 字号 | 实际显示设置记录；关键按钮、长 ID、结果与错误不遮挡 | NOT_RUN |
| 多屏（具备时） | 跨屏移动、缩放与窗口恢复；不具备写 NOT_RUN | NOT_RUN |
| 浅色 / 深色 / 减少动态 | 状态使用文字；系统外观变化与高对比可读 | NOT_RUN |
| 系统链接唤起 | 获准对象只导航；未知对象、任意登录 URL 不自动执行 | NOT_RUN |
| ⌘W / Dock 重开 | 只关闭视图，同一 Core / Bot / 队列；不重复提交 | NOT_RUN |
| ⌘Q / 取消退出 | 停止接单；取消退出恢复；停止未证实保持 UNKNOWN | NOT_RUN |
| 睡眠 / 唤醒 | 仅获准测试时执行；保留草稿与工作区，重新核验连接/Run | NOT_RUN |
| Renderer 重载 / 草稿 | 每窗口每 Bot 草稿隔离，原 command ID 重试，无第二任务 | NOT_RUN |
| 双窗口审批 | 原请求只一次生效；另一窗口明确冲突，保持阅读上下文 | NOT_RUN |
| P1 准备 | 创建持久操作；下载不等于 Runner 就绪；认证过期保留工作区 | NOT_RUN |

每项附实际步骤、期望/实际行为、日志或截图、PASS/FAIL/NOT_RUN、测试者及包摘要。失败不得清空用户数据重试；无确认的睡眠、安装、登录与模型操作保持阻塞。
