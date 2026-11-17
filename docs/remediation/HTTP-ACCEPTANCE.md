# 内置 HTTP MCP 实际验收

日期：2026-11-08。仅使用隔离测试配置与专用低权限本机SSH，不使用生产资产。

## 判定

单插件安装、命名凭据/永久许可和通用实际AI四工具功能链路已通过。本次记录实际使用Codex CLI0.167.0，不把任何AI产品或版本设为准入前提。

**完整macOS受控试用认证仍未完成**：系统真实失焦、完整多窗口实机矩阵和GUI长时间轮换未认证，远端三平台CI未运行，Linux/Windows GUI未认证。不能把本地功能通过等同这些项目通过。

## 环境与隔离

- Tabby1.0.238完整临时副本，portable data、独立TABBY_CONFIG_DIRECTORY/XDG_CONFIG_HOME/TMPDIR及插件prefix；运行时内置Node24.21.0。
- 仅安装一个插件tarball，无独立companion包/进程，不要求AI客户端提供外部Node命令。
- 专属Docker SSH容器，仅绑定127.0.0.1，账号test/uid1001，只读根及临时可写home/run/tmp。PTY所需capabilities单独设置，不使用个人SSH密钥。
- 实际AI客户端用临时配置和ephemeral调用，只启用QA MCP；没有改写用户AI工具配置。AI模型自身认证失败/客户端策略拒绝的早期尝试不计为通过。

## 已通过场景

| 场景 | 观察结果 |
| --- | --- |
| 单包安装 | 实际npm tarball安装/重启，服务与设置正常；prefix无companion包 |
| 默认/启用 | 默认stopped，通过真实按钮保存后running；ConfigProxy字段写入有效 |
| 凭据名称 | 新增“QA generic agent”，重命名为“QA named connection”，名称持久化且代次/永久许可不变 |
| 配置复制 | 真实点击复制，显示成功提示；未把token输出到验收报告或截图 |
| 首次审批 | 凭据名称、自报名称和时效首帧可见；默认session，明确选择permanent后才记住 |
| 永久恢复 | 重连和完整Tabby重启后，凭相同credentialId/代次恢复许可，无额外人工连接批准 |
| 实际AI工具调用 | 四个工具按顺序各调用一次，均completed；命令id返回uid1001(test)、read_only、非截断 |
| 最小列表/授权 | 仅QA引用及显示名；operation_tier=readonly，open_session=true；没有SSH连接字段或凭据 |
| 请求专属tab | 打开及命令创建新可见SSH标签页，使用专用账号/新transport |
| 输出截断 | 真实cat5000字节文件返回status=truncated、4096UTF-8字节、truncated=true |
| 审计不可写 | chmod测试日志只读后，命令返回audit_unavailable对应文本；tab数量8→8，未派发 |
| 审计恢复 | 恢复权限后真实id再次completed，耗时661ms |
| 执行中取消 | full仅用于隔离账号；先确认远端marker已创建再取消，SDK收到AbortError，tab数量11→12→11；恢复readonly |
| 取消结果审计 | 派发后取消记录command_result(error,outcome_unknown)；不把断开当作远端进程已停止 |
| 客户端独立性 | B重置为generation2/none时A仍generation1/permanent，随后可单独撤销B |
| 主凭据重置 | 旧token立即401，代次增加、许可none，新token必须重新审批 |
| 永久可撤销 | 真实撤销后旧token401、客户端记录移除；测试服务通过按钮停止 |

原四工具的成功输出兼容；客户端连接许可与SSH操作授权分别管理。SDK回归另验证24小时/永久时效边界、同名不继承、会话串用、限流/内存边界、Host/Origin/认证、正常收体和异常断流、持久化/损坏/轮换等失败路径。

## 证据文件

外部目录为交付记录中的plugin-http-20261108。

- ai-tools-sanitized.json：最终候选的真实AI四工具结果、版本与作用域；不含Authorization。
- candidate-artifact.json、artifacts/：tarball及入口hash，匹配实际安装和workspace构建。
- first-prompt-fields.json：首次审批名称/声明/时效可见，默认session。
- settings-final.png：测试凭据管理界面，无个人profile或token。
- sdk-post-audit-recovery.json、sdk-truncation.json、sdk-cancellation.json：真实SSH恢复、截断与取消。
- client-isolation.json、client-reset.json、client-revocation.json：独立性、重置和撤销元数据，不含token。
- tests/、linux-validation/：Node20/24日志与独立Linux冻结快照、变更说明。
- reviews/：独立复审及回归关闭依据。

## 未认证与边界

System Events无法可靠取得系统前台进程，未改变辅助功能/系统权限，不用模拟focus当作真实失焦通过。完整多窗口GUI及长时10MiB轮换仍待专项；其相应逻辑有自动化覆盖。

同一凭据目录只支持一个活动Tabby实例；独立实例隔离配置目录。CAS阻止陈旧写回，不承诺跨独立进程广播撤权。未成功持久化的撤销不保证跨重启，UI会提示；崩溃后遗留pending标记需停机核对，不自动截断或回收。

永久许可长期信任持有该凭据的连接端，需保护复制的配置。SSH断开、truncated及outcome_unknown均不表示远端后台任务已终止，未知结果不得自动重试。

## 清理

测试凭据已撤销、服务已关闭。导出证据后只清理本轮临时应用/配置/密钥、专属容器和镜像；保留工作树、候选包、官方Node镜像及原有Docker资源。最终实际清理结果见外部cleanup.json。
