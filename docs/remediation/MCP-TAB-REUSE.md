# SSH 永久审批与标签复用

日期：2026-11-17。

命令审批按钮明确显示“永久允许（加入审批命令集）”，并说明仅保存到当前客户端与当前 SSH 的本地命令集中。连接审批显示“永久允许此 SSH 连接”。保留现有请求审批记忆、精确哈希隐私、持久化失败关闭，以及自动编辑高危/未知操作每次审批的规则。

`run_authorized_ssh_command` 新增可选 `tab_ref` 和 `new_tab`。默认优先复用当前客户端、当前配置摘要匹配的空闲标签；显式引用失败时拒绝，不悄悄新建；`new_tab: true` 强制新建且不能与引用同时使用。`open_authorized_ssh_profile` 继续始终新建。

保留的标签返回稳定 `tab_ref` 与 `tab_reusable`，命令结果还返回 `reused_tab`。只复用 MCP 创建的实际标签对象；每条命令仍检查白名单、配置摘要、模式、审批及当前授权版本，不读取终端历史输出。

标签借用期间独占，禁止另一个执行或关闭操作。固定 SSH 会话对象并检查连接替换/断开；执行到返回结果的间隙发生会话替换也不能重新绑定目标。输出截断、取消、异常等未确认完成的执行会禁用该标签后续复用，但保留显式关闭能力。没有合适空闲标签时可新建；命中忙标签则返回 busy，可显式选择新建。

自动关闭只作用于本次新建的命令标签，借用的已有标签保留。仍以每条命令独立子 Shell 执行，不承诺跨命令保持 cd 等 Shell 状态。不改用户配置，不安装、不提交或发布；测试只操作隔离凭据与标签替身。

调用示例：

```json
{"name":"run_authorized_ssh_command","arguments":{"profile_ref":"<SSH 引用>","command":"pwd","tab_ref":"<打开时返回的标签引用>"}}
```

保留强制新建能力：

```json
{"name":"run_authorized_ssh_command","arguments":{"profile_ref":"<SSH 引用>","command":"pwd","new_tab":true}}
```

回归覆盖：打开后复用、默认自动复用、强制新建、稳定引用、跨客户端/配置摘要拒绝、借用期间关闭拒绝、配置/模式变更后的逐条鉴权、输出截断隔离、会话替换和发布前断连、永久审批持久化及其他客户端不受影响。独立复核指出的打开路径 wasOpen 快照遗漏已先复现再修复，并通过实际打开路径测试。

最终验证：569 项单元/脚本测试通过（IPC 61、Companion 149、插件 313、脚本 46）；5 项 HTTP 集成测试通过；workspace 类型检查、严格 Angular 模板检查、构建、pack check 和 `git diff --check` 均通过。原生 Tabby、实体 SSH 与真实 AI Agent 的交互仍需安装后实机验证。

候选包：`/Users/woodynew/.codex/visualizations/2026/11/16/01a1e223-72d5-7ea2-91f2-944a435d3c21/mcp-tab-reuse-20261117/tabby-secure-mcp-0.1.0.tgz`。

SHA-256：`e54eb13e3c5893ae8fbd61f4b29f852a25a4c6b78ea1a85105a98bff508cd4b0`。
