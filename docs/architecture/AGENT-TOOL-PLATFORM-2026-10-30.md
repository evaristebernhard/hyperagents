# ADR: 以一个运行内核组织 Hyperagent 风格的 agent 工具

日期：2026-10-30。状态：本轮采用的实施方向；工具接入仍需逐阶段验收。

## 后续实现更新：同日第一批工具

下文保留最初架构决策快照。后续依赖核实发现：Lightpanda checkout 没有可执行文件，现有 Moli 1.1.19 不支持 MCP，而项目已有 Playwright。因此首批改用 CDP 传输，明确使用 Moli provider，不静默替代或宣称 Lightpanda 已接入。新增 browser-runtime 并绑定统一 registry；能力范围、实测结果和未完成项见 ../TOOL-IMPLEMENTATION-BATCH-1-2026-10-30.md。原 moli-browser-session 未修改。

## 1. 先定义要复刻的东西

目标不是把几个 bot 产品拼在同一个目录，也不是凑齐相同的工具名。目标是让 agent 在一个可追踪的运行中，发现已获授权的能力、执行真实操作、等待必要审批、保存结果，并让人能检查和继续工作。

必须区分四件事：

1. 工具契约：模型可调用的参数、结果、错误与效果语义。
2. 平台服务：权限、凭据、任务/会话生命周期、审批、事件和资源归属。
3. 执行后端：浏览器、模型供应商、集成 API、进程等。
4. 交互界面：工具开关、运行轨迹、审批卡、浏览器面板、Library。

一个浏览器引擎只能补第 3 层的一部分；一个完整 bot 项目也不能直接替代上述四层。

## 2. 决定：一个内核，按能力接入，不按上游产品并库

```text
React 界面 / 未来 webhook、schedule、IM 入口
                      |
          agent-runs：唯一 durable run / event / approval 主干
                      |
          llm：模型轮次、工具调用和上下文预算
                      |
          tool-registry：本轮授权目录、参数验证、分派、审计
                      |
       能力服务：browser / skills / artifacts / integrations / delegation
                      |
       provider adapters：Lightpanda / Moli / 未来 Chromium / 外部 API
```

现有 server/agent-runs.mjs、llm.mjs、tool-registry.mjs 继续作为主干。不再引入第二套全功能 agent 框架，不把 OpenMausBot 的任务库与现有 run 库并排作为两套真相。未来触发入口只负责认证、去重和创建 run，不能绕过既有审批。

文件组织服从这条边界：新增能力可逐步进入 server/browser、server/skills 等目录，但本轮不为整齐而批量移动现有文件。三个克隆仓库原位保留、保持各自 Git 历史，暂不加入根 workspace、生产依赖或容器构建上下文。

## 3. 三个仓库的岗位和取舍

| 仓库 | 本项目角色 | 借鉴或接入 | 明确不做 |
| --- | --- | --- | --- |
| OpenMausBot | 运行契约参考，不是本项目的第二个内核 | 任务状态机、事件事务、父子任务汇总、阻塞/唤醒、权限追溯、终态防重复通知、浏览器 profile 生命周期 | 不整体搬 Electron/CLI 宿主，不沿用默认 Full Access，不复制 enterprise 功能 |
| browser = Lightpanda | 候选的真实浏览器执行后端 | 原生 MCP 的受控子集；后续按需要接 CDP/BiDi；网页导航、DOM、交互、结构化数据 | 不调用其内置 agent 再套一层隐藏模型循环，不把所有原生工具直接交给模型，不把文本渲染称为 Chrome 视觉截图 |
| Macro | 资源与工具产品化参考 | 实体稳定 ID、资源引用、文档/设计分离、SDK 文档按需发现、状态转换思想 | 不迁移 Solid/Bun/Rust/Nix 全栈，不立即重做协同编辑/邮件/CRM，不把 ExecuteCode 作为绕过逐操作审批的通道 |

这三个仓库不是三个同级 agent 后端。Lightpanda 可以成为运行依赖；另外两个当前主要提供设计依据。MCP 是适配协议，不是新的权限系统，也不是必须把所有内置工具改成 MCP。

### 许可证和构建边界

- OpenMausBot/LICENSE 是 Apache-2.0；LICENSING.md 明确 enterprise/ 另许可。具体复用还需保留适用 NOTICE、第三方声明和文件级许可。
- browser/LICENSING.md 明确默认 AGPL-3.0-only。
- macro/LICENSE.txt 是 GNU AGPL v3 正文；不要因为 package.json 的 private 字段就认为没有许可限制，也不要据此推定所有子包采用相同声明。
- 本轮没有复制上游实现。进程/协议隔离便于维护，但不自动免除许可证义务；直接链接、修改、分发或提供网络服务前须结合具体使用方式核查。
- .dockerignore 排除三个参考 checkout，避免根 Dockerfile 的 COPY . . 意外把整套外部源码、历史和其本地数据发送到构建器。这不等于已验证整个供应链或已完成许可证合规审查。

## 4. 工具家族如何落到现有主干

| 工具家族 | 平台负责 | 执行后端/来源 | 现状与下一步 |
| --- | --- | --- | --- |
| Browser | 会话归属、顺序执行、网络策略、审批、观察引用、上传下载和证据保存 | Lightpanda 优先验证 DOM 子集；Moli 保留既有 fetch/semantic/visual；未来 Chromium 独立 provider | 当前浏览器 session 模块未接入 llm registry；先做最小闭环，不宣称 Browser 已实现 |
| Research | 搜索/抓取分离、引用、异步研究 job 与取消 | 现有公开 API + Moli；未来经配置的搜索/研究 provider | 浏览器不是搜索引擎，不能用 Lightpanda search 的名称替代已配置通用搜索服务 |
| Documents/Tables/Webpages/Slides | 稳定资源 ID、版本/CAS、所属 workspace/thread、文件引用、渲染检查 | 自有资源服务；渲染器仅做验证 | 复用现有 staged artifact 到 server persistence 路径；不因有 HTML 就称已实现 Slides 导航/导出 |
| Files/Shell/Skills | 审批、cwd/文件归属、任务状态、凭据注入、日志脱敏 | 现有 shell-runtime/skill-runtime | skill 文档不赋予执行权；可执行技能接入同一 durable run，明确任务与 run 的关联 |
| Integrations/MCP | 服务连接、账户与资源范围、发现、写入审批、结果来源 | 现有 API adapter；未来 MCP SDK client | 按服务与动作白名单接入；不把第三方 annotations 当成授权 |
| Delegation | 明确目标 agent、权限交集、父子预算、等待/取消/汇总 | 现有 child-run foundation；参考 OpenMausBot 契约 | 子任务归属于主干，不把每个克隆 bot 当成可直接调用的同事 |
| Schedule/Live/Webhook/IM | 认证、幂等、run 创建、unattended write policy | admission + 未来触发器 worker | 触发器不自带另一套工具执行循环 |
| Images/Video/Audio/Maps | provider 配置、异步 job、超时/取消、文件落库、真实状态 | 专项 provider adapters | 已有未提交 media-maps 模块不代表已接入；保留原状、单独审查后才绑定 |
| Knowledge/Evaluation | scope、版本、建议/批准、读取与执行分离 | 自有知识服务；模型仅生成建议 | 不把运行日志中的指令自动写成授权或长期记忆 |

## 5. Browser 第一条垂直切片

### 5.1 选择原生 MCP 子集，而非先做通用浏览器智能体

Lightpanda 的 browser/src/mcp/tools.zig 已公开具体工具及 annotations，HTTP transport 有独立 session。第一阶段可用官方 MCP SDK client 封装这些原语；只将已审阅、已映射和已授权的少数动作绑定到本项目 registry。

这样先复用现成的导航/DOM 操作，避免重新实现浏览器协议。代价是需要管理 MCP transport、外部 schema 和 session，且视觉能力仍有限。CDP/BiDi 保留为 provider 内部可选实现；不要一开始同时维护三个等价适配器。

服务端启动命令、二进制绝对路径、监听地址和允许工具名由受信配置决定，不接受模型传入 command/args 或远程 MCP URL。外部 schema 交给 SDK/合适的 schema validator 校验，不把 tool-registry 的手写 schema 子集当作完整 MCP 校验器。

### 5.2 产品工具名与后端原语不是一对一

| 产品能力 | Lightpanda 候选原语 | 本项目还必须补的职责 |
| --- | --- | --- |
| BrowserSession | HTTP initialize、session_new/session_close | 服务端 opaque handle、owner/workspace/thread/run 绑定、过期和关闭；禁止全局 session_list 直接泄漏其他会话 |
| BrowserNavigate | goto、getUrl | 顶层与重定向/子资源的网络策略、限时、真实最终 URL/HTTP 状态 |
| BrowserObserve | tree、interactiveElements、findElement、nodeDetails | 限长观察、稳定但有有效期的元素引用；不是自动获得视觉理解能力 |
| BrowserGetContent | markdown、html、structuredData | 提取当前页还是重导航必须写清，输出预算、来源与不可信内容标记 |
| BrowserAction | click、fill、press、selectOption、setChecked、hover、scroll | 将模型意图解析到确定动作；同 session 串行；可能提交/发送/购买的动作先过审批 |
| BrowserExtract | 已观察 DOM + extraction/受限执行能力 | 结构化 schema 验证、范围限制；后端 extract 的具体语义需实测，不能直接承诺任意自然语言结构化提取 |
| BrowserScreenshot | screenshot | 核实当前构建渲染语义；Lightpanda README 明确无 graphical rendering engine，dump PNG/PDF 为 text-only rendering；不等同 Chrome 像素效果 |
| BrowserEvaluate | evaluate | 执行网页代码可能有副作用；单独高风险能力，不默认开启，不称为只读 |
| BrowserUpload | download/input-file 等需逐项验证 | thread file 授权、受控临时文件和上传目标确认；不能让模型指定任意主机路径 |
| Handoff / recording / stored logins | 无已验证的一体化映射 | 独立平台能力，需要实时可视浏览器、录制存储、同意流程和凭据管理；不是改个工具名即可完成 |

Lightpanda 原生 login/getCookies/getEnv/save/download/callPageTool/evaluate/search/classify 不在首批透传白名单。理由分别涉及凭据、主机文件、站点任意代码、潜在隐藏 provider 调用及效果边界；后续逐项审查，不因原生支持就自动开放。

注意：HTTP Mcp-Session-Id 是后端路由标识，不是本平台的访问授权。同一 ID 共享上下文的上游能力不得变成本平台跨用户共享登录态的默认行为。

### 5.3 接入契约

建议服务接口（设计，不是已上线 API）：

```text
BrowserProvider.describe() -> 实际支持的特性和版本
BrowserService.create(trustedContext, explicitProvider) -> sessionHandle
BrowserService.navigate(trustedContext, sessionHandle, url, signal) -> pageState
BrowserService.observe(trustedContext, sessionHandle, budget, signal) -> observation
BrowserService.act(trustedContext, sessionHandle, exactAction, approval, signal) -> result
BrowserService.close(trustedContext, sessionHandle) -> closed
```

trustedContext 由服务器认证/run 记录生成，不能相信工具参数中的 ownerId/workspaceId。引擎 ID 建立会话后固定：不自动换到另一后端，不转移 cookie/profile。缺少特性返回明确 unsupported，不生成伪结果。

网络阻断要覆盖重定向、子资源、fetch/XHR/WebSocket 和 DNS 解析后的私网地址，不能只验证第一次 URL。明确禁止本机文件、内网和云 metadata。当前 Moli fetch 的 CLI 私网阻断不证明未来 Lightpanda serve/MCP 会自动继承同样策略。

会话操作在同 session 下串行；独立会话可受总并发预算调度。不能看到 readOnlyHint 就把所有导航或观察并行：上游 tools.zig 本身说明 navigation 会改变 cookie/storage，等待也让脚本执行。更不能对所有工具直接 Promise.all。

### 5.4 第一阶段验收

在隔离测试 fixture 中完成：create -> navigate -> observe -> get content -> close；重连同句柄可继续查看，跨 owner/workspace 拒绝；取消/超时会清理进程和会话；过期句柄明确失败；网络策略覆盖重定向/子资源；工具运行进入同一 durable event 日志。然后才做受审批的 click/fill。生产 provider 的真实往返必须另测，mock 通过不算上线。

## 6. 为什么不优先照搬 Macro Code Mode

Macro 的 code-mode-sdk 文档展示了 SDK 文档索引、按需 DescribeCodeTools/ReadCodeDocs、受限 Deno 子进程和短期 token。值得借鉴的是“先发现接口、再按需加载文档”和“明确执行身份”。

但它的公开 MCP 设计对某些写入依赖客户端对整个 ExecuteCode 的批准，review 也不是安全边界。本项目当前是逐动作审批，直接搬来会改变权限语义。首轮继续用现有 tool_catalog 与明确工具；大量 SDK 批操作有真实需求时，再设计受约束 code mode，不先造大而全执行器。

## 7. 结果、授权与能力真相

每种工具最终都应保留 toolCallId/runId、真实 provider/operation、状态、可重试性、时间、资源引用和错误。可逐步统一 envelope，但不要一次破坏现有 SSE/持久化格式。

至少保持 prepared、approval_required、running、succeeded、failed、cancelled、timed_out、unknown 的区别。发生网络超时且外部动作结果未知时不能当作未执行自动重试。大文件用受授权 file reference，不把 Base64、cookie、token 或完整文件填进模型上下文。

最终可执行工具集合应是：已实现适配器 ∩ 已配置/可用服务 ∩ 当前身份和资源授权 ∩ agent/thread 开关 ∩ 当前运行模式。UI 开关、第三方仓库存在、计划清单和 skill 文本均不能单独增加工具权限。

本轮新增 tool-platform-plan.json 是 implementation-plan-only，不接入模型或能力授权，避免又造一个相互冲突的 runtime authority。

## 8. 分阶段交付和不做清单

1. 本轮：架构决策、来源 pin、Browser 映射和构建隔离；不改运行中的服务。
2. 下一轮 P0：Lightpanda 真实二进制版本确认 + MCP 最小只读会话闭环 + 网络/归属/取消测试；通过后才注册 Browser 子集。
3. P1：受审批 DOM 交互与上传下载；是否加 Chromium 由真实视觉/handoff 需求决定。安装与 provider 配置单独确认，不自动下载/编译大浏览器。
4. P2：Skill 执行接入同一 durable task；补子 agent 的身份、权限交集和汇总；借鉴 OpenMausBot 的状态机测试而不换内核。
5. P3：触发器创建 run、unattended write policy；补资源引用与 library/version/readiness 的统一展示。
6. P4：按真实需求接搜索、媒体和地图；最后再评估 SDK code mode 与协同资源图。

不在本轮：并库、移动 checkout、安装依赖、启服务、变更认证、复制 enterprise/AGPL 实现、数据库迁移、提交/push。

## 9. 证据与快照

本机本轮基线：Node v24.18.0；263/263 backend tests 通过，typecheck 通过。这只证明当前实现基线，不证明新浏览器 provider 可用。

已读证据：
- server/tool-registry.mjs、server/llm.mjs、server/moli-tools.mjs、server/moli-browser-session.mjs 及相关测试。session 模块默认 connect/extract 返回 null；测试只检查方法存在，llm.mjs 未绑定该模块。因此不能称已有真实 Browser 闭环。
- OpenMausBot/docs/runtime-contract.md、docs/agents-tool-bridge.md、docs/approval-levels.md、server/browser-engine.ts、LICENSING.md。
- browser/README.md、LICENSING.md、src/mcp/tools.zig；实际原语和注解以该 snapshot 为准。
- macro/packages/code-mode-sdk/README.md、packages/machine/README.md、docs/design/public-mcp-code-mode.md、docs/architecture/canvas-legacy-bridge.md、LICENSE.txt。
- 本机 /home/ubuntu/.local/bin/moli 报版本 1.1.19；它不是已编译、已验证的 browser checkout，不混为同一个后端。

参考仓库 HEAD 记录在相邻 JSON 清单。node scripts/check-tool-architecture.mjs --checkouts 可只读核查 HEAD 和许可文件；常规模式不要求 CI 克隆这些参考仓库。

官方产品能力参照：
- https://www.hyperagent.com/docs/tools/browser#what-the-agent-can-do-in-the-browser
- https://www.hyperagent.com/docs/tools/browser#faqs

本文是本项目独立的实现决策，不是官方私有架构说明。官方浏览器具备的录制、人工接管等产品能力，不代表本地已有实现。
