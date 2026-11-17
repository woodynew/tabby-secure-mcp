# 修复执行记录

日期：2026-11-08。基线：main@49a97973e8bc2e157306c5633ed025b4ec661198。
分支：codex/secure-mcp-remediation；改动未提交、未推送、未发布。

依据：用户批准的《Tabby Secure MCP 修复与 macOS 试用准入计划》及 19 项全仓审阅报告。保留三包架构、四工具和三级授权；不增加运行时依赖、不升级版本、不迁移旧授权。

| 任务 | 状态 | 结果 |
| --- | --- | --- |
| T1 / R03、R04、R13 | 已实现并回归 | 有效配置、摘要 v2、串行持久化、即时撤权屏障、设置错误保留 |
| T2 / R01、R02 | 已实现并回归 | 固定参数策略、控制字符拒绝、argv 重编码与 command -p |
| T3 / R08、R10–R12、R14 | 已实现并回归 | 独立 writer、可靠写入、10 MiB 分段、跨段校验、失败关闭 |
| T4 / R09、R15、R16 | 已实现并回归 | 不回收陈旧锁、standby 重新配对、独立到期计时器 |
| T5 / R05–R08 | 已实现并回归 | 专属会话、同步最终校验、取消清理、受控 shell 与有界输出 |
| T6 / R17–R19 | 已实现并回归 | Node 启动 npm CLI、稳定 tarball 依赖、冲突拒绝、不删除 runtime |
| 本地自动化与独立代码复审 | 已完成适用检查 | 详情见 REPORT；未运行远端三平台 CI |
| macOS 真实验收 | 部分完成，未准入 | 通用 MCP/Tabby/本机 SSH 调用项已通过；系统失焦等仍待认证 |

2026-11-08 用户调整：MCP 验收接受任一支持本项目 stdio 接口的客户端，包括 MCP SDK；不要求指定 AI 工具或自然语言触发。已有实际 MCP 四工具调用证据满足此项，Cursor 专项不再作为准入条件。其他安全及实机要求保持不变。

按 T1→T6 执行，原始缺陷先加入失败回归再修复。独立复审发现的 2 项 P1、3 项 P2 同样经过 RED→GREEN：配置 store 替换丢失撤权、Tabby 连接事件顺序、派发后取消结果不确定、分段首次 flush 失败恢复、非协议 RS/US 文本丢失。

真实 API 验证补充了 ConfigProxy.__setDefaults 排除、物化前复制 Profile、禁用会话 reuseSession、通过公开 BaseTabComponent.destroy 清理 SSH 子标签页。另补充失败撤权与白名单编辑交错、npm_config_save=false 的回归。

最终 macOS Node20/Node24 完整测试各246项通过，Node20集成12项通过；独立 Debian12 arm64/Node20 同样258项通过。类型、构建、pack检查通过。Linux冻结快照后仅runner末尾少一个LF，已逐字节核对，无业务字节变化。

用户选择本机临时 SSH 服务；采用独立 Tabby 完整副本、portable data、专属 Docker SSH 用户和临时密钥。个人配置和历史审计未改写。代码修复候选已交付，完整平台及 GUI 准入尚未完成，不能用测试数量代替认证。清理与最终证据见 ACCEPTANCE。
