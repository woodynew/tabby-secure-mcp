# Plugin Streamable HTTP Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans with bounded independent workers where noted. Track RED/GREEN evidence and do not commit, push or publish.

**Goal:** 一个Tabby插件托管本机MCP，凭据可命名、独立审批、支持永久许可，通用AI工具调用验收。
**Architecture:** 内部companion构建库提供HTTP/SDK和凭据存储；插件提供窗口生命周期、审批和安全业务分发。最终交付单个自包含插件包。
**Tech Stack:** 现有Node20.19+/Node24、MCP SDK2.3.1、esbuild、Angular15/TS4.9/webpack、node:http/fs。
**Spec:** ../specs/2026-11-08-plugin-streamable-http-design.md

## Global Constraints

- 复用已修复worktree，不提交/推送/发布；不增加交付runtime依赖、不升级依赖。
- 四工具名称/input/output、三级SSH权限、摘要v2、故障关闭和旧审计保留。
- 仅主窗口127.0.0.1，默认关闭，默认50333；次窗口只读，不自动接管。
- 客户端凭据独立、名称可编辑；本次/24h/永久；永久跨重连和Tabby重启，撤销/重置失效。
- 通用AI客户端真实四工具验收，不指定产品；SDK不是GUI验收替代。
- 用户已明确要求开始实施，跳过重复的执行方式/计划确认；独立模块可并行，主线程负责宿主与整合。

## Review Focus

- 永久授权按凭据及代次绑定，同名不继承，撤销A不影响B（Task1/2）。
- 保存失败/回滚与撤销交错，禁止恢复旧授权（Task1）。
- 正常收体不算取消；响应异常断开/会话撤销阻止最后发送（Task2/3）。
- Electron bundle不能外部require companion或SDK，旧TS4.9不解析现代声明（Task3/4）。
- 单包安装保留其他依赖及旧审计/runtime，失败不回收锁（Task4）。

## Task 1: 命名凭据与持久授权

Files: packages/companion/src/http/{contracts,credentials}.ts; test/http-credentials.test.ts。
接口以contracts.ts为准：CredentialStore.load/list/create/rename/reset/revoke/tokenFor/authenticate/isCurrent/permission/grant/onInvalidated/onChange。
- [x] RED: 命名校验/重命名、独立token、24h/永久重启恢复、撤销/失败交错、权限/损坏/symlink文件。
- [x] 实现严格有界文件、串行原子落盘和即时拒绝屏障；永久无expiresAt。
- [x] GREEN: rtk proxy npx vitest run --config vitest.config.mts --root packages/companion test/http-credentials.test.ts。

## Task 2: HTTP会话与四工具入口

Files: packages/companion/src/http/{server,adapter}.ts; src/mcp/server.ts; test/http-server{,.integration}.test.ts。
接口：EmbeddedMcpServer(options).start/close/sessionViews；options注入CredentialStorePort、approveClient、dispatch、audit、onChange。
- [x] RED: 真实loopback SDK握手/四工具、Host/Origin/token/超限、单独批准、本次/24h/永久、凭据串用、撤销/取消。
- [x] 解耦MCP注册具体旧网关，使用SDK WebStandard有状态JSON transport及有界NodeHTTP适配。
- [x] 实现限流/32socket/8session/1pending/4call、同期凭据一会话、独立失效和收体/断线区分。
- [x] GREEN: HTTP目标vitest及原MCP兼容检查。

## Task 3: 插件宿主、审批及设置

Files: plugin src/runtime/plugin-http-runtime.ts、src/index.ts/lifecycle、config、approval modal/presenter/gatekeeper、settings component/template；对应测试。
- [x] RED: 默认关闭/主次窗口、配置reload/关闭失效、凭据命名UI、永久审批、四工具分发及结果审计失败。
- [x] 宿主通过当前gatekeeper执行；可靠审计后同步复核，合并HTTP/客户端/服务取消。
- [x] UI提供新增名称、重命名、复制通用MCP配置、重置/撤销和许可状态。
- [x] GREEN: plugin测试、类型和实际webpack构建；证明SDK在插件包内。

## Task 4: 单插件交付及旧入口清理

Files: companion package/build/entry与内部窄声明；plugin devDependencies/webpack；scripts install/pack与测试；根package-lock。
- [x] RED: 安装仅生成插件tarball、自包含入口；无需companion目录/系统node运行。
- [x] 移除产品CLI/bin和旧transport入口，保留内部库及合同；退役纯旧传输测试并用HTTP证据替代。
- [x] 只安装插件，保留hash artifact/manifest其他字段/依赖；不自动删除旧companion或runtime。
- [x] GREEN: typecheck、全workspace build、脚本测试、真实pack检查。

## Task 5: 整体验证、独立复审、试用记录

- [x] Node20.19与Node24全测试/集成/typecheck/build/pack；图覆盖与源码核对。
- [x] 独立审阅最终改动，P1/P2回归修复。
- [x] 隔离Tabby真实插件+低权限本机SSH，HTTP四工具、永久重启恢复、撤销/取消/审计失败。
- [x] 通用实际AI客户端验收可用时执行并记录；无法执行则明确未认证，不把SDK当AI调用。
- [x] 更新README/客户端配置/release-status与候选hash；清理本轮临时资源，保留证据和工作树。

## Ledger

- 设计已确认；用户补充凭据名称，授权仍绑定credentialId与代次。
- 不重复请求计划批准：用户已明确“开始实施”，本计划为执行记录。

- [ ] 真实系统失焦、完整多窗口和GUI长时轮换专项认证：尚未通过，见HTTP-ACCEPTANCE；不把代码交付等同完整试用认证。
