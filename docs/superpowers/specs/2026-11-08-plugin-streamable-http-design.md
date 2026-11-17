# Tabby 插件内置 Streamable HTTP MCP 设计

状态：用户已确认并要求开始实施；增加凭据名称，便于区分连接端。
日期：2026-11-08。工作树：codex/secure-mcp-remediation，基于已完成的 19 项修复候选继续；不丢弃现有未提交改动，不自动提交、推送或发布。

首版及本次修订版独立 builder-check 均已完成，未发现妨碍编写实施计划的重大未决问题。本次修订采用通用客户端验收与永久客户端授权。检查仅针对设计可实施性，没有运行新架构构建或 GUI 验收。

## 1. 目标与已确定范围

用户已选择：MCP 服务直接运行在 Tabby 插件内，客户端通过本机 Streamable HTTP 连接，不再启动独立 companion 进程。安装使用只需要 Tabby 插件；最终用户不配置系统 Node、companion 路径或 shell 启动命令。

保留四个工具的名称、输入、成功输出和三级命令授权。保留有效配置摘要 v2、即时撤权屏障、审批、请求专属 SSH 标签页、可靠分段审计及 audit_unavailable / outcome_unknown 语义。旧 v1 授权不迁移，个人 SSH 配置、白名单和历史审计不删除。

本轮面向同机、支持 Streamable HTTP 与自定义认证头的通用 AI/MCP 客户端，不指定客户端产品或版本。真实验收使用 macOS Tabby 1.0.238，加至少一种满足连接要求的实际 AI 客户端调用四工具，记录实际使用的产品、版本、传输协商和结果；SDK 客户端用于协议与故障回归，不能单独替代真实 AI 客户端验收。Linux/Windows 继续自动化，不承诺 GUI 认证。无远程监听、反向代理、浏览器客户端、OAuth 服务、独立守护进程或旧 stdio 双栈。无依赖升级，不新增最终交付包的运行时依赖。

用户明确补充：每个客户端可以单独审批，审批时效必须支持永久。本设计将“永久”解释为记住该客户端的连接许可，跨正常重连及 Tabby 重启保留，直到用户撤销、删除或重置该客户端凭据；不等于永久复用网络连接，也不扩大 SSH profile 的授权。

## 2. 方案选择

| 方案 | 结果 | 选择 |
| --- | --- | --- |
| companion 随插件交付，但仍由客户端以 stdio 启动 | 安装简化，仍有独立进程和 Node 路径 | 用户未选择 |
| 插件内部托管 MCP，通过本机 Streamable HTTP 接入 | 真正取消独立 companion，连接方式改为 URL + 凭据 | 用户已选择 |

以下端口、主窗口归属、默认关闭、令牌持久化及无自动接管是本设计提出的实施默认值，不冒充用户先前指定的要求。

## 3. 总体实现与构建边界

调用方向：AI 客户端的 HTTP 请求 → 插件内 HTTP / MCP 会话管理 → 本窗口业务分发 → 已修复的 AuthorizedProfilesService / ApprovalGatekeeper → Tabby SSH API。

- Tabby 窗口进程具备当前插件已使用的 Node 能力；新增监听使用 node:http，不拉起 child_process。
- 复用已锁定的 @modelcontextprotocol/server 2.3.1 和 zod，使用 WebStandardStreamableHTTPServerTransport，不自行实现 MCP 协议。
- 使用 Node 内置 HTTP 与 Web Request/Response 的小型适配，限制请求后再交给 SDK；不增加 Express/Hono 等框架。
- 保留现有三个 workspace 的目录，避免与本次目标无关的全仓重命名。packages/companion 改为内部构建库：保留可复用的 MCP 工具注册、错误映射与限流，增加供插件使用的 HTTP 入口，移除产品可启动的 CLI/bin 和已不用的 stdio/socket/descriptor/lease 网关实现。
- 内部库以既有 esbuild 构建为 CommonJS 并提供窄、兼容 TS4.9 的声明；插件仍用现有 Angular15/TS4.9/webpack。不让新版 SDK 的类型声明进入插件旧编译器，业务接口仅传普通类型、AbortSignal 和回调。
- webpack 将内部库、SDK、zod 全部打入插件 dist。最终 npm 交付只有 tabby-secure-mcp tarball，不要求在安装目录旁边存在另一个 companion 包。
- 在编写其余功能前验证该打包边界及 Tabby 实际加载；失败时保持服务关闭并报告，不以改成后台进程替代用户目标。

## 4. 服务生命周期、主窗口及多窗口

配置增加 enabled（默认 false）和 port（默认 50333，仅允许 1024–65535 整数）。绑定固定地址 127.0.0.1，路径仅 /mcp；端口可在设置中修改，客户端配置由当前实际监听地址生成。

只允许 normalizeWindowBootstrap 判定的主窗口托管服务。其他窗口不监听、不自动转发请求，Secure MCP 的服务和授权修改控件只读，提示到主窗口管理；避免两个独立配置服务的内存撤权状态相互冲突。保留普通 Tabby 功能。

OS 端口绑定是活动实例互斥边界。EADDRINUSE 显示冲突并停止，不探测后杀进程、不自动换端口、不复用未知服务、不使用陈旧锁回收。主窗口关闭或被销毁时，先同步拒绝新操作、使持有者 generation 无效、取消所有会话，再异步关闭 server/socket。次窗口不自动升级接管；恢复需要重新打开主窗口。此举牺牲无缝接管，换取明确窗口与授权归属。

服务启动顺序：读取/持久化有效配置及凭据 → 独占监听成功 → 建立新的运行 generation → 可接受新会话。持久化失败不开放服务。禁用、改端口、模块销毁时先形成运行时拒绝屏障；随后保存/清理。保存失败保留错误并告知重启前重试，不能把内存拒绝伪报为已持久化。

ConfigService.changed$ 引发重新读取与串行 reconcile；仅服务开关/端口变化重启服务，普通白名单/命令授权变化直接由当前授权入口与最终复核生效。配置事件不能触发重入或复活旧 generation。

不再使用 companion.lock / descriptor.json / Unix socket；新插件不读取或删除旧 runtime。旧 stdio 客户端配置需用户停用，安装安全检查继续拒绝仍在运行的旧 companion。

## 5. 本机认证与凭据

主窗口通过“新增客户端”创建独立 credentialId、用户指定且可编辑的凭据名称、32 随机字节/base64url 编码的 bearer token 和初始未批准状态。名称用于设置列表、审批和撤销定位，必填、去除首尾空格、不含控制字符、最长80个Unicode字符；允许同名但不按名称匹配授权。最多保存32个客户端凭据，不使用所有客户端共享的token。永久授权绑定 credentialId 与凭据代次，不能绑定可伪造的 initialize.clientInfo.name，也不能把客户端A的批准套用到B。

凭据文件固定为现有 resolveAuditLogPath() 所在目录下的 http-credentials.json，包含格式版本、客户端凭据记录及记住的连接许可；复用 XDG_CONFIG_HOME / LOCALAPPDATA 隔离入口，避免与 profile 混存。整个文件最大64 KiB，严格验证数量、唯一ID/凭据、标签长度、授权枚举及时间字段。凭据不进入 SSH profile、Tabby 通用配置字段、审计、异常、URL 或诊断。目录/文件在 POSIX 分别为 0700/0600；拒绝符号链接、异常权限、oversize 或格式损坏文件，不自动覆盖证据。Windows 限于用户配置目录并验证拒绝符号链接，ACL 的实机结论另记。

token 跨正常重启保留；只有明确选择记住的24小时/永久连接许可可以跨会话或重启保留。每个 HTTP 请求都验证 Authorization: Bearer，使用定长、恒时比较；Mcp-Session-Id 必须属于同一credentialId/凭据代次，不能替代认证或跨客户端使用。

新增客户端、授予/延长记住的许可、重置凭据与撤销均采用串行持久化。提权只有可靠审批审计和落盘成功后生效；撤销/重置立即使该客户端运行时拒绝并abort其会话，随后原子落盘，不影响其他客户端。较早的失败写入/回滚不能覆盖较后的撤销。失败保持拒绝并明确提示未持久化，重启前需重试；不能承诺尚未持久化的撤销跨重启保持。

“撤销客户端”使其token失效并清除记住的连接许可，现有会话立即失效，旧配置不得重新触发审批；要恢复由用户再次新增或重置凭据。“重置该客户端凭据”保存新token并清除旧连接许可，必须再次明确审批。只撤销A不得改变B的授权。凭据写入使用独占临时文件、同步落盘、原子替换；写入失败不激活新token或新许可。

设置只通过用户点击该客户端的复制操作将其配置写入剪贴板，不自动修改任何 AI 工具配置，不默认把token展示在页面、截图或错误中。复制内容包含本机访问凭据，不宣称同 OS 用户的进程隔离。凭据持有者代表配置对应的客户端授权主体，不证明实际程序身份；自报的clientInfo显示前清理，并标明它是客户端自行声明的信息。

## 6. HTTP 边界与有界资源

- 只接受本机 TCP 来源；Host 必须恰为 127.0.0.1:当前端口。不接受 localhost 别名、绝对形式请求目标、代理转发头绕过或通配绑定。
- 本轮只面向原生客户端：有 Origin 头一律 403，不提供 CORS；无 Origin 仍必须通过 bearer。OPTIONS 不开放浏览器通路。
- /mcp 支持 POST 和 DELETE；GET 返回 405，使用 SDK 的 enableJsonResponse=true，不开 standalone SSE，不支持事件重放。四工具不需要服务端主动 elicitation/sampling。
- 先校验 Host/Origin/认证再读取 body、创建 SDK 实例或弹审批。POST 仅接受 application/json；最大 64 KiB（含分块累计）、嵌套深度16、单字符串8 KiB，保留命令512 UTF-8字节及字段级校验。拒绝批量 JSON-RPC，避免一份 HTTP 体绕过 admission。
- HTTP 头最大16 KiB、收头期限5秒、收体期限10秒；工具执行另受30/45秒业务期限约束。不能使用总10秒请求超时误杀正常慢命令。
- 同时最多32个 TCP socket、8个会话、1个待人工批准会话、4个在途工具调用；open/run 继续由 gatekeeper 串行。限额满立即拒绝，不创建无限等待队列。
- 沿用业务全局 burst5、每分钟20的令牌桶。初始化另设全局burst5、每分钟10，且未认证请求不触发审批或分配会话；所有临时表和计时器都有清理路径。

这些边界由我们自己的 HTTP 接入层执行，不依赖 SDK 默认4 MiB上限或已废弃的可选 Host/Origin 校验选项。

## 7. MCP 会话与人工批准

每个会话单独创建 McpServer、transport、随机sessionId、AbortController，并绑定已认证的credentialId、凭据代次和审批状态；状态为 initializing → pending → approved → closed。sessionId 不跨服务 generation 复用。

SDK验证并完成initialize后可以返回协议协商结果和四工具静态定义。如果该凭据有仍有效的记住许可，重新校验当前凭据/代次和可靠审计后恢复approved；否则立即在主窗口请求该客户端的人工批准。在approved前，所有tools/call（包括profile list、grant read）拒绝，不因稍后批准自动重放。初始化失败、审批busy、deny、Escape、失焦或30秒超时均销毁该会话。不得重用其他客户端的批准。

审批窗口明确提供“仅本次会话（最长24小时）”“记住24小时”“永久”三档，默认仅本次，不预选永久。前者只在内存授权当前session；24小时许可从批准时间起算，保存expiresAt，重连/重启不重置期限；永久许可无expiresAt且无隐含24小时上限，跨正常重连和Tabby重启保留，直到用户撤销或重置该客户端凭据。

本次/24小时授权在当前进程中由独立单调计时器执行；持久24小时许可启动时由存储的expiresAt重建剩余期限，不能靠请求流量或重连延长，发现时钟早于approvedAt时要求重新批准。永久授权不创建到期计时器，不能用极大时间戳或Infinity代替明确的permanent枚举。

批准及工具意图可靠审计成功后才激活权限；记住许可还须持久化成功，失败不静默降级并伪报成功。审批展示用户创建的客户端标签、经清理的自报名称及所选时效，不展示token或完整sessionId。永久连接许可不绕过profile白名单、摘要变化、命令等级、打开审批或执行前最终复核。

DELETE、服务停止或持有者丢失只结束相应运行会话，清理SDK/transport/计时器，不删除已记住的24小时/永久许可；UI“撤销客户端”、凭据重置或有限许可到期同时取消其活动操作并阻止旧授权恢复。不同客户端相互独立，撤销A不能撤销或授权B。

为限制永久授权下的残留会话，每个凭据最多一个活动会话。重连仅在旧会话无在途请求时关闭并替换旧会话；旧会话有在途请求则返回busy，不为新握手终止旧操作。全部客户端仍受8个活动会话上限约束，永久许可不豁免资源限制。正常HTTP响应完成或keep-alive TCP关闭不是MCP会话退出，不清除已记住许可。

设置按客户端显示标签、自报名称、状态、授权时效（含“永久”）和撤销按钮。重启后运行会话列表为空，旧sessionId返回404；新session可以凭该客户端仍有效的记住许可恢复连接，不按名称匹配。使用低层WebStandardStreamableHTTPServerTransport保留SDK支持的2025时期有状态协商；实际协议协商由通用AI客户端验收验证，不凭SDK支持宣称所有工具兼容。

## 8. 工具分发、取消和副作用

MCP 注册从具体 PluginGateway 解耦为小型业务分发接口；四工具名称/schema/成功输出沿用现有实现。每次调用由服务端生成独立32位hex requestId，客户端JSON-RPC ID仅供本会话响应匹配，不能跨会话复用审批。

分发前检查：服务generation仍有效、该credentialId未撤销、凭据代次一致、会话approved、有限许可未到期（permanent不做时间到期判断）、signal未取消、并发/速率允许。之后调用当前主窗口的服务，不接受客户端传入profileID、lease、权限等级或创建tab对象。

运行generation继续供gatekeeper的leaseEpochSource使用；每次请求signal合并SDK取消、当前HTTP响应提前断开、会话撤销、generation终止、业务期限。只把未完成响应的异常断开作为本请求取消；Node IncomingMessage 正常收体完成不能触发取消。

低层传输须同时验证2025通知取消和支持的较新请求流取消。JSON响应模式的socket提前断开仍显式绑定本请求abort，不能仅依赖SDK默认行为。网络恢复没有业务自动重试/重放；相同HTTP请求重发也不提供“恰好一次”保证，文档明确说明。

沿用可靠审计后的同步最终校验、独立新tab/新认证transport、连接就绪后撤权复核、单次受控shell与有界输出。未派发前审计失败为audit_unavailable；派发后取消/断线或结果审计失败为outcome_unknown。若响应已断开无法送达，记录不确定结果，不能把它降级为“未执行”。对用户的SSH副作用保证不因移除网关而削弱。

## 9. 设置和客户端配置体验

主窗口Secure MCP顶部增加服务启用开关、端口、运行状态/错误与客户端列表；每个客户端有用户标签、复制MCP连接配置、重置凭据、授权时效/活动状态及撤销。新增客户端须由用户在Tabby中操作。连接审批加入本次/24小时/永久选择，原白名单与三级SSH授权保留在下面。凭据存储故障与端口占用错误不混成“连接正常”。次窗口明确只读并指引主窗口。

通用连接信息为当前URL及Authorization请求头；同时提供常见mcpServers形状的配置示例（各AI工具配置字段可不同，不绑定产品；占位符仅用于文档，真实点击复制时注入该客户端独立token）：

```json
{
  "mcpServers": {
    "tabby-secure-mcp": {
      "url": "http://127.0.0.1:50333/mcp",
      "headers": { "Authorization": "Bearer <client-token>" }
    }
  }
}
```

初版提供复制而非自动写任何AI工具配置，不引入客户端安装位置探测。验收以支持Streamable HTTP与自定义认证头的实际AI客户端为准，记录工具名称/版本、配置字段与协商结果；不要求某一指定产品登录或通过，不在失败时偷换为stdio代理。通用兼容不等于所有AI工具都已认证，文档需声明实际测试范围。

## 10. 安装、迁移与删除边界

安装器只打包/安装插件，保留按hash持久artifact和根manifest的file:依赖、其他依赖/字段、未登记插件冲突先拒绝等修复。pack:check改为验证单个自包含插件包、UMD入口及不含运行时workspace:/file:依赖，内部构建库不作为用户交付。

现有根manifest中已登记的旧companion依赖可以保留为惰性残留并明确提示用户手动移除；本轮不自动删包或编辑客户端配置，不启动它。旧runtime文件不删除。新插件不连接旧companion，所以用户必须停用旧stdio配置、改用复制出的HTTP配置。

原审计文件及原授权存储保持原样，重新配对只作用于新的客户端会话；不以传输迁移重建SSH grants或自动提权。

主要改动范围：内部库入口与工具注册/限流、插件runtime与DI/lifecycle、服务配置与凭据、设置组件/模板、安装及pack脚本、HTTP/会话/主窗口回归、客户端文档和release-status。删除已无调用的旧CLI/IPC网关及对应纯传输测试，保留与迁移有关的证据和安全业务回归。共享ipc-contract仍作为现有工具DTO/error约束来源，避免与本轮无关的命名迁移。

## 11. 实施验证与准入

先证明内部库打包、SDK/Web API适配与实际Tabby加载，再按认证边界、会话批准/撤销、业务分发、设置和单包安装顺序做失败回归→实现→验证。不能只用fake transport证明改造完成。

必须覆盖：外网不可达、错误Host/Origin/缺失或错误token、重复关键头/超长header/慢体/分块超限、未知/过期/串用session、并发initialize与限额、批准后在最终发送前撤销/换token/停止服务、通知取消/断流/正常收体、主窗口关闭与双主窗口争端口、配置reload、凭据写盘失败/符号链接/权限异常、独立客户端审批/凭据绑定、24小时边界、永久授权超过24小时不失效、跨重连/重启恢复、同名不同凭据不能继承、撤销A不影响B、删除/重置令永久许可失效，以及原19项中仍适用的安全回归。

完整执行Node20.19.0和现有Node24的类型、普通/脚本/集成测试、workspace构建与真实tarball检查；保留Ubuntu/macOS/Windows CI。对最终HTTP源码与包重新独立审阅，已知P1/P2不得以测试数替代结论。

macOS仍采用隔离Tabby副本和专属本机低权限SSH服务；验证只安装一个插件、无child_process/外部node运行需求、服务重启后URL/独立token稳定、永久许可恢复而本次许可不恢复、至少一种实际AI工具通过MCP调用四工具、输出/取消/撤权/审计不可写/真实失焦。使用哪个AI工具不构成指定产品准入要求，但须记录实际名称/版本及可重复证据；缺少实际AI调用时只算SDK协议验证，不能宣称完整验收通过。系统权限仍缺失时明确记录对应未认证项。不得修改个人Tabby/AI工具配置或生产资产，不自动发布。

## 12. 当前已核对证据与待验证假设

当前源码：plugin index.ts、runtime lifecycle/bootstrap/lease、config/settings、ApprovalGatekeeper、AuthorizedProfilesService及companion MCP注册/CLI/gateway。图索引为2026-11-07T18:55:58Z的完整worktree版本；引用路径须检查coverage，源码优先于图。

当前安装SDK确为2.3.1，直接声明提供WebStandardStreamableHTTPServerTransport、sessionIdGenerator、enableJsonResponse、maxRequestBodySize及session回调；Context7的相同版本文档确认有状态HTTP、GET405容忍、2025/2026取消差异。文档不是Tabby宿主或实际AI客户端实测。

待验证假设：SDK在Electron renderer的webpack bundle中无宿主冲突；窄声明可隔离TS4.9与SDK现代类型；实际支持Streamable HTTP的AI客户端接受独立认证头和所选有状态JSON响应模式。任一不成立时需修正实现并记录，不宣称已支持所有客户端。

## 交付状态

2026-11-08已按本设计实施并记录验收，见docs/remediation/HTTP-IMPLEMENTATION.md和HTTP-ACCEPTANCE.md。通用实际AI四工具功能链路通过；完整GUI认证的未完成项单列，不自动发布。
