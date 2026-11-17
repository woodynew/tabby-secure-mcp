# 修复候选交付报告

2026-11-08。基线 `main@49a97973e8bc2e157306c5633ed025b4ec661198`，分支 `codex/secure-mcp-remediation`，位于独立 worktree，未提交、未推送、未发布。原始 checkout 保持不变。

**结论：19 项原始问题已完成代码修复及回归；macOS 受控试用尚未准入。** 本轮没有自动发布或升级依赖。四工具的名称、输入和成功输出兼容；低等级命令按批准计划收紧。旧授权保留但因摘要 v2 失效，需明确重新授权。

## 原始问题与证据对应

下表测试路径相对仓库根目录。原始问题先加入失败用例再修复；全量验证包含这些回归，不以用例总数替代具体行为判断。

| 问题 | 修复后的行为 | 回归证据 |
| --- | --- | --- |
| R01 / P1 解释器绕过只读 | 固定程序/参数策略，env 和状态变更参数不能进入低等级；command -p 调用 | `packages/tabby-plugin/test/ssh-command.test.ts`：launchers/state-changing flags |
| R02 / P1 终端控制字符 | 引号/转义之前拒绝原始控制输入，解析 argv 后 POSIX 重编码 | 同文件：terminal controls、shell composition；含空格路径真实 SSH 检查 |
| R03 / P1 继承配置遗漏 | Tabby 公开 ConfigProxy 物化、冻结有效配置，内部摘要 v2 绑定继承选项 | `packages/tabby-plugin/test/authorization-regressions.test.ts`：effective inherited options、真实 ConfigProxy getter；`profile-security-snapshot.test.ts` |
| R04 / P1 撤销旧 open 复活权限 | 仅削减 open，不刷新摘要或旧命令等级 | `authorization-regressions.test.ts`：revoking a stale open；真实 GUI 修改端口后撤销 |
| R05 / P1 取消后仍打开 | 可靠审计后同步复核，打开 API 返回后仅清理本请求 tab，不存永久授权 | `packages/tabby-plugin/test/execution-regressions.test.ts`：final profile read after cancellation；`approval-gatekeeper.test.ts` 取消/lease/TOCTOU |
| R06 / P1 等待连接期间撤权 | 发送前同步复核配置/白名单/授权版本/等级/lease/取消/期限；绑定具体新会话 | `execution-regressions.test.ts`：revoked while connects、old transport disabled；`ssh-command-runner.test.ts` |
| R07 / P1 回显误判完成 | 一次受控 shell、stdin /dev/null、随机 nonce 的 RS/US 起止记录；先识别协议再清理 ANSI | `execution-regressions.test.ts`：input echo；`ssh-command-runner.test.ts`：分块记录、有界残缺流、UTF-8 截断；真实 id/cat |
| R08 / P1 审计失败仍执行 | 关键审计必须成功落盘；副作用前 audit_unavailable，副作用后 outcome_unknown | `execution-regressions.test.ts`：critical audit persistence fails；真实只读审计文件拒绝且无新 tab |
| R09 / P1 陈旧锁双实例 | EEXIST 一律拒绝，不探测并自动回收陈旧锁 | `packages/companion/test/lifecycle-regressions.test.ts`：两个并发 stale-lock 取得者均拒绝；`runtime.test.ts` |
| R10 / P2 队列被重置 | safeAppend 不重置内部串行队列，失败后不并发重用序号 | `packages/tabby-plugin/test/audit-regressions.test.ts`：earlier safe append fails |
| R11 / P2 多窗口共用日志链 | 每实例独立 writerId/目录，独立顺序分段；旧日志原样保留 | 同文件：independent writers and legacy untouched |
| R12 / P2 损坏日志截断 | 损坏与轮换失败均保留证据、返回失败；不截断兜底 | `packages/tabby-plugin/test/audit-service.test.ts`：preserves corrupt log；`audit-regressions.test.ts`：first segment flush ENOSPC |
| R13 / P2 保存失败授权生效 | 完整串行事务，提权持久化后生效；撤权立即屏障，失败不被后续编辑恢复 | `authorization-regressions.test.ts`：failed increase/revoke、store replacement、whitelist interleaving；错误可见 |
| R14 / P2 缺少轮换 | 默认单 segment 10 MiB，上限前轮换，延续 sequence/hash，提供只读跨段校验 | `audit-regressions.test.ts`：bounded segments、tamper detection、real disk/private permissions |
| R15 / P2 standby 配对顺序 | holder/candidate 丢失统一撤销 standby，恢复必须重新明确配对 | `lifecycle-regressions.test.ts`：standby approved before main disappears；`pairing-lease.test.ts`、`gateway-pairing.test.ts` |
| R16 / P2 descriptor 到期未撤权 | 独立单调计时到期撤 lease、断 peer、取消 pending，CLI 清理自身文件后退出 | `lifecycle-regressions.test.ts`：paired holder and pending RPC at expiry；`descriptor-pairing-boundaries.test.ts` |
| R17 / P2 shell 拆分路径 | process.execPath 启动真实 npm-cli.js，shell:false，完整 argv | `scripts/npm-pack-utils.test.mjs`：all-platform launcher；`scripts/install-local.test.mjs`：实际空格/特殊字符路径 smoke |
| R18 / P2 npm 清理未登记包 | hash 命名持久 tarball、显式 save/save-exact 根依赖；保留其他 manifest，未登记插件冲突先拒绝 | `scripts/install-local.test.mjs`：后续增包/重复安装/metadata/save=false/未登记插件拒绝 |
| R19 / P2 检查后删除新锁 | 安装器不再删除 runtime，旧 cleanup 接口为无操作 | 同文件：运行进程/陈旧文件均保留，安全检查与安装交错不产生删除 |

## 独立复审和实际 API 兼容修正

完整改动独立复审发现 2 项 P1、3 项 P2，均以回归修复：配置 store 替换丢失内存撤权、Tabby 在 session.open=true 前发完事件导致永不就绪、派发后取消误报普通取消、分段创建后 flush 失败无法恢复、非协议 RS/US 可见文字被吞。当前没有剩余已确认的 P1/P2；这不是对所有缺陷的穷尽性保证。

实际 Tabby 1.0.238 验证还纠正了宿主行为差异：ConfigProxy 物化会修改输入，须先复制并排除 __setDefaults；SSH child tab 用公开 destroy 清理；MCP 新建 tab 禁用 reuseSession，防止复用旧认证连接。后两项通过真实取消和新会话检查。授权失败与白名单编辑交错、npm save=false 另有失败回归。

## 最终验证与边界

- macOS Node20.19.0：246 普通/脚本 + 12 集成通过；Node24.22.2：246 普通/脚本通过。两版 typecheck、全 workspace build、pack 检查通过。
- Debian12 arm64 / Node20.19.0：独立最终源码快照258项通过，类型/构建/pack通过。冻结清单 SHA256 `09561aa4d84d8f65e680021371df93daebfe9d90d162a4d9805d0b6abd70849a`。之后 runner 仅删除末尾一个 LF，逐字节核对说明已保存。
- 三平台 Node20.19.0 CI 配置保留，本轮未推送触发；没有 Ubuntu 或 Windows 当前源码运行结果，不把 Debian 当作 Ubuntu。
- 代码图基于当前 worktree 重新完整索引，1229 nodes / 3724 edges；改变的代码路径检查没有记录的解析/新鲜度缺口。图仅为 best-effort，结论同时依赖直接源码、回归与实际宿主证据。
- 实际 Tabby1.0.238 + 临时低权限 localhost SSH 的检查及候选 tarball 标识见 [ACCEPTANCE](ACCEPTANCE.md)。按 2026-11-08 调整的要求，任一支持本项目 stdio MCP 接口的客户端均可作为验收客户端，已有 SDK 实际四工具调用证据满足 MCP 调用项；不再要求指定 AI 工具。物理失焦、完整实机专项矩阵与远端 CI 仍待完成，因此不能标记 macOS 受控试用通过。

POSIX 远端 shell 是支持边界，不构成远端操作系统沙箱。outcome_unknown 不得自动重试；truncated/SSH 断开不证明远端进程已停止。失败撤权的运行时拒绝可在未成功持久化前随退出丢失，设置会明确提示；须修复保存失败并再次保存后再重启。
