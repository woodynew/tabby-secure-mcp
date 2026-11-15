# macOS 隔离验收记录

日期：2026-11-08，Asia/Shanghai。基线 main@49a9797，分支 codex/secure-mcp-remediation，未提交、未发布。

**判定：修复候选及通用 MCP 调用项已验证，但尚未满足“macOS 受控试用通过”。** 系统物理失焦及下述专项实机检查仍待完成。

## MCP 客户端验收要求（2026-11-08 调整）

不指定 AI 工具、品牌或版本。任一支持本项目 stdio MCP 接口的客户端（包括 AI 工具或 MCP SDK 测试客户端），能通过实际 MCP 连接完成四工具发现、白名单列表、授权查询、审批打开及真实 SSH 命令执行，即满足 MCP 调用项；无需由 AI 自然语言触发。配对、审批、授权与失败处理仍按原要求验收。

已有 SDK/stdio → companion → Tabby → 真实 SSH 的证据满足此项，记为通过。下文 Cursor 尝试仅为历史兼容性记录，不作为准入条件；该结论不等于所有客户端版本均已逐一验证。

## 环境与隔离

Tabby 1.0.238 完整临时副本使用 portable data，独立配置、插件前缀、XDG 审计目录与 TMPDIR。最终主进程未传 --no-sandbox，不对 Tabby 自身 Electron renderer 的沙箱配置作额外认证。Cursor 3.27.22 使用临时数据与项目。SSH 仅绑定127.0.0.1:51106，专属Docker服务、test用户uid1000、只读根文件系统及临时可写目录；不使用生产服务器或个人SSH凭据。

初次 Cursor 的 --user-data-dir 未隔离全局 MCP 清单，已停止实例，未主动调用其中业务工具。后续用 macOS 文件访问沙箱阻止全局 Cursor 目录/清单读取，仍需登录，不能记为互通通过。未改写全局配置；测试缓存不作为交付证据保存。

## 已观察的真实行为

| 场景 | 实际结果 |
| --- | --- |
| 安装与持久化 | 配套安装真实tarball；GUI勾选QA Profile、选择readonly，重启后保留 |
| MCP四工具 | 真实stdio companion暴露原有4工具，SDK成功发现 |
| 配对/最小列表 | GUI明确配对后仅返回QA引用及显示名，隐藏canary不出现在列表 |
| 打开审批 | Allow打开新的可见SSH tab；首次主机密钥确认通过真实界面完成 |
| 命令结果 | id返回uid=1000(test) gid=1000(test)，completed/read_only/非截断，无输入回显或协议标记 |
| 只读绕过 | env sh -c返回not approved |
| 控制字符文件 | cat文件A+RS+B+US+C返回ABC、completed、非截断 |
| 输出上限 | cat 5000字节文件返回4096 UTF-8字节、status=truncated |
| 读写等级 | GUI改readwrite后mkdir -p含空格路径成功，ls -d保留原始路径 |
| 实际取消 | full慢命令创建远端标志后取消；SDK抛AbortError，tab数7→8→7，仅销毁本请求tab |
| 目标变化 | GUI修改测试端口后授权变open=false/tier=none |
| 过期授权撤销 | Revoke remembered open后仍为none，stale警告保留，没有刷新旧full |
| 拒绝/Esc | 两种实际操作均返回not approved且tab数不变 |
| 无操作超时 | 实测30009ms，网关保守返回outcome_unknown，tab数不变 |
| 审计不可写 | 测试日志只读时id返回audit_unavailable、不创建tab；恢复权限后成功 |
| 多窗口 | 两窗口分别明确配对，standby未夺取primary lease |
| 正常退出 | SDK关闭后测试runtime锁、descriptor、socket均释放 |
| 最终包复验 | 重新安装并重启后配对、四工具发现、最小列表、readonly查询和真实id再次成功 |

SDK取消会终止本地等待，不将AbortError解释为“未发生副作用”的保证。派发后outcome_unknown另有网关回归。SSH断开不能证明远端后台任务终止，truncated也不表示远端已结束。

## 自动化证据

| 环境 | 检查 | 结果 |
| --- | --- | --- |
| macOS / Node20.19.0 | typecheck、完整test、集成、workspace构建、pack:check | 246普通/脚本+12集成通过 |
| macOS / Node24.22.2 | typecheck、完整test、workspace构建、pack:check | 246普通/脚本通过；不另记Node24集成通过 |
| Debian12 arm64 / Node20.19.0 | 独立最终源码快照的ci、typecheck、test、集成、构建、pack | 258项通过，0失败 |
| 远端Ubuntu/macOS/Windows CI | 保留Node20.19.0三平台工作流 | 未推送、未触发，不能宣称通过 |

完整test分组为IPC22、companion39、plugin148、scripts37；集成为companion11、plugin1。构建由测试prehook执行。真实磁盘审计轮换、跨segment校验、Unix0600权限有实磁盘自动化证据，不替代GUI长时运行触发10 MiB轮换。

安装smoke实际覆盖特殊字符/空格路径、save=false、稳定file: tarball、manifest字段保留、插件共存、后续增包和重复安装。Windows参数有回归用例，未在Windows实机认证。

## 未完成的准入项

- 系统真实失焦拒绝：辅助功能权限关闭，模拟焦点/原生激活不足以认证。自动化控制内核超时不计作应用通过或失败。
- 实机慢连接期间撤权、继承配置变化和保存失败等完整专项矩阵。已完成端口变化实机检查，其余主要有回归证据。
- GUI长时间运行到10 MiB轮换及多窗口holder错误/恢复完整实机矩阵。已有自动化与部分GUI证据。
- 当前分支Ubuntu/Windows远端CI；Linux/Windows GUI均待认证。Debian arm64不替代Ubuntu或Linux amd64。

## 证据与候选标识

外部目录：`/Users/woodynew/.codex/visualizations/2026/11/07/01a1b625-527b-70f2-92dd-d8c72d641c91/remediation-20261108/`。

- final-macos-smoke.json：最终真实调用、工具名和bundle hash。
- secure-mcp-settings.png：仅截取测试面板，不含个人profile元数据。
- linux-validation/：最终检查日志、源码清单及末尾LF格式差异说明。
- candidate-artifacts.json与tarballs/：安装后复验的候选包及SHA256，bundle hash与tarball hash分开记录。

Tarball SHA256：plugin `f8e9bffaf2328adb9d7c4dcc110725e0580231345c81e9fee4ff3ea640b878ed`；companion `ef39b05175c0becf29caa214978dd722ef7fbe972fade8dcaaea0d5fdc6c76a7`。版本仍为0.1.0，必须配套安装并重启；旧v1授权不自动迁移。

## 清理

仅清理本轮/tmp/tsm-qa-NImo3h的测试应用、缓存、配置、密钥和专属SSH容器/镜像；保留工作树、候选tarball、导出证据、官方Node镜像及所有原有Docker资源。最终实际结果见外部cleanup.json。个人应用及配置未改写。
