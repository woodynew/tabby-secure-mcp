# 插件内置 HTTP MCP 交付记录

日期：2026-11-08。基线 main@49a97973e8bc2e157306c5633ed025b4ec661198。
工作树：`/Users/woodynew/.codex/worktrees/secure-mcp-remediation/tabby-secure-mcp`，分支 codex/secure-mcp-remediation。未提交、未推送、未发布。

## 交付结论

已实现单个 Tabby 插件内置 Streamable HTTP MCP，不再启动独立 companion。已完成命名凭据、独立客户端审批、本次/24小时/永久许可，以及通用实际 AI 工具调用四工具验收。原四工具及三级 SSH 权限保留。

最终候选版本仍为0.1.0，用tarball/入口hash标识，不作为公开版本发布。安装过旧版的客户端须手动停用stdio配置并改用本机HTTP连接。旧审计、SSH配置和授权数据不自动删除或提权。

## 用户可见行为

- 主窗口 Settings → Secure MCP 启用本机服务，默认关闭、默认端口50333，仅监听127.0.0.1。次窗口只读，不自动接管。
- 每个连接端单独新增凭据，名称必填、可编辑；名称只是区分标签，授权绑定credentialId与凭据代次，同名不继承权限。
- 复制通用连接配置，使用URL与Authorization头，不自动修改AI工具配置，不要求客户端配置Node路径。
- 初次审批默认仅本次会话；可选择记住24小时或永久。永久许可跨重连和Tabby重启保留，无隐藏24小时到期。
- 重置该客户端凭据会使旧token失效、清除记住的许可并要求重新审批；撤销客户端使其token立即拒绝，其他客户端不受影响。
- 永久连接许可不改变SSH白名单、摘要v2、打开授权或命令等级。命令仍使用新标签页、新认证transport、可靠审计和最终复核。

## 实现与维护

保留三个workspace目录：companion现为私有内部构建库，以CJS和兼容TS4.9的窄声明接入；SDK2.3.1随插件打包。最终只安装tabby-secure-mcp，不增加交付运行时依赖或升级依赖。

HTTP边界包括逐请求认证、严格Host/Origin、64KiB体限制、深度/字符串限制、会话及并发上限、限流和独立期限。服务停止/凭据失效同步建立拒绝屏障，副作用后的不确定结果不得自动重试。

凭据存储采用私有权限、严格文件验证、原子替换及pending提交标记，避免rename后目录同步失败使报错的永久授权在重启后激活。提交基线在独占标记后再次比较，陈旧Store不能覆盖其他实例已提交的撤销。冲突Store停用，需重新加载；遗留pending标记保留证据，不自动回收。

同一凭据目录按一个活动Tabby实例使用。独立便携/并行实例须隔离XDG_CONFIG_HOME/LOCALAPPDATA。CAS防止陈旧写回，不提供独立进程之间的主动撤权广播；多窗口支持范围是主窗口管理、次窗口只读。

安装器保留持久hash artifact、根file:依赖及其他manifest字段/插件，显式包含已登记dev/optional插件，防止production/omit环境将其移除。不删除旧runtime或自动卸载旧companion。

根typecheck/test/integration命令自动按顺序构建IPC及内部库，干净检出不再依赖手工前置build。

## 验证证据

| 环境 | 普通/脚本测试 | 集成与其他检查 |
| --- | --- | --- |
| macOS / Node20.19.0 | 各组314项通过：IPC22、内部库96、插件150、脚本46 | 2项集成、typecheck、构建、pack通过 |
| macOS / Node24.22.2 | 同一组314项通过 | 2项集成、typecheck、构建、pack通过 |
| Debian12 arm64 / Node20.19.0 | 同一组314项通过 | 干净CI顺序、2项集成、typecheck、构建、pack通过 |

最后的presenter UI修复只修改一个实现文件并增加一个测试；两版Node和Linux均补跑插件150项及相关检查，其余未变分组沿用刚完成的全套结果。未将重复执行次数叠加为测试总数。Linux保留原快照及所有delta，最终130个源文件内容/大小/权限核对一致。Debian不能替代Ubuntu/Windows。

独立复审发现并修复：报错授权重启激活、陈旧Store复活撤销、production/omit删除其他插件、派发后取消缺结果审计、打开意图审计与连接审批交错。每项均有独立RED→GREEN证据；最终限定复审无剩余已确认P1/P2。

实际Tabby还发现并修复ConfigProxy结构对象只有getter、renderer定时器返回数字、原生异步UI保存完成不刷新、首次审批名称未显示等宿主差异。首次弹窗现在立即显示凭据名称、自报信息和时效，默认session，实机证据已保存。

代码图已重新全量索引，并检查63个代码路径。两个export type *行的解析为partial，已直接核对原始行并通过类型/构建验证；其余路径无记录缺口。图是best-effort，不作为无缺陷证明。

## 候选与真实验收

Tarball SHA256：`c402b5ef355d1f8394d78cae5e67ac84ecbdae4b0952e19017be607fa88fe832`。
插件入口SHA256：`35d9b5487d964d64a729856c48d7198a1f0feeb32c35c6feb6fab507961790a2`。
已核对tarball入口、隔离Tabby安装入口与当前workspace构建字节相同，安装目录不存在独立companion包。

证据目录：`/Users/woodynew/.codex/visualizations/2026/11/07/01a1b625-527b-70f2-92dd-d8c72d641c91/plugin-http-20261108/`。
详见[真实验收记录](HTTP-ACCEPTANCE.md)。早期stdio修复报告保留为历史证据，不能代替本次HTTP候选验收。

## 安装使用

从本修复工作树执行npm run install:local，或使用npm --prefix指向上述绝对工作树。原项目main checkout仍为旧代码，不能从那里安装修复候选。

重启日常Tabby后，在主窗口启用服务、选择SSH白名单和等级、添加有名称的客户端凭据、复制MCP配置，在支持Streamable HTTP和认证头的AI工具中填写。不要使用旧companion命令。原版本1的SSH授权需要明确重新授权；有效版本2授权不会因传输迁移被扩大。
