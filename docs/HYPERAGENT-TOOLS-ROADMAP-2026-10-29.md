# Hyperagent 工具能力分析与本地 Agent 实现路线图

> 基于 Hyperagent 官方文档、当前会话实际可调用工具、已连接集成，以及 `/home/ubuntu/hyperagents` 的实际代码与测试结果。

## 1. 执行摘要

本地项目已经不是 mock chatbot，而是一个真实可运行的 Agent Runtime 子集：有模型多轮工具循环、统一 registry、Durable runs、SQLite 事件、队列、Shell 审批、集成 adapter、产物持久化、Moli 网页读取和 Child Run 基础。

但它还不是 Hyperagent 的完整能力复刻。按官方工具参考列出的 20 项内置能力计算：

- 完整覆盖约 5/20：Thread Search、Documents、Tables、Webpages、Code execution。
- 部分覆盖约 3/20：Search、Browser、Script。
- 主要缺口约 12/20：Find Similar、Exa Research、Exa Websets、Exa Answer、Slides、HyperApps、Images、Video、Audio、Transcribe、Avatar、Maps。

本地后端当前约有 48 个潜在 model-tool name，但其中约 31 个是 13 个第三方 provider 的 integration operations，不能与 Hyperagent 的内置工具数量直接等同。

最近一次完整回归：257/257 通过；typecheck 和 diff check 通过。最近提交：`89fea28 feat: expand agent tool runtime and Moli capabilities`。

## 2. Hyperagent 官方工具面

官方工具参考可以分成六组：

### Research

- Search：通过 Standard 或 Exa 搜索并读取网页。
- Thread Search：搜索过去线程。
- Find Similar：根据 URL 找语义相似页面。
- Exa Research：深度多源研究和引用。
- Exa Websets：构建结构化、验证过的网页数据集。
- Exa Answer：带来源回答问题。

### Browser

- Browser：实时浏览器导航、页面交互、登录页面操作、证据截图和人工接管。
- 支持 Stay logged in、Persistent sessions、stored logins、Residential IP、CAPTCHA 处理等浏览器运行能力。

### Data / documents / outputs

- Documents：版本化文档。
- Tables：类型化列和结构化记录。
- Webpages：版本化网页。
- Slides：版本化演示文稿。
- HyperApps：实验性、带持久状态的交互应用。

### Media / maps

- Images：生成和编辑图片。
- Video：短视频、原生音频、图生视频和延长。
- Audio：语音和多说话人对话。
- Transcribe：转录、说话人、时间戳和情绪。
- Avatar：HeyGen presenter 视频。
- Maps：地理编码、地点、路线和地图产物。

### Execution

- Code execution：代码和命令行执行，文件可跨线程持久化。
- Script：独立、无状态的 Python / JavaScript 执行环境。

官方来源：

- https://www.hyperagent.com/docs/tools#tool-reference
- https://www.hyperagent.com/docs/tools#choose-tools-by-the-job
- https://www.hyperagent.com/docs/tools#tools-and-integrations-are-different

## 3. Agent、知识和入口能力

官方 Agent 不只是 prompt 加工具，还包括：

- identity / name / system prompt；
- model / reasoning / run limits；
- tools；
- connected integrations；
- skills 和 scripts；
- global 或 agent-scoped memories；
- rubrics、评估、历史分析和 A/B improvement；
- autonomy / approval / access policy；
- threads 和 activity；
- workspaces、角色和所有权；
- Library 产物；
- schedules；
- Live Mode；
- Slack、Telegram、email 等入口；
- webhook；
- MCP client；
- agent delegation。

官方文档说明，工作可以从 thread、schedule、webhook、connected channel、email、MCP 或另一个 agent 开始；每个入口最终都进入一个可追踪的 thread/run。

来源：

- https://www.hyperagent.com/docs/concepts/agents
- https://www.hyperagent.com/docs/concepts/agents/invocations/mcp-server
- https://www.hyperagent.com/docs/concepts/library
- https://www.hyperagent.com/docs/concepts/agents/invocations

## 4. 当前会话可调用的 Hyperagent 工具

### Research

`ExaSearch`、`ExaContents`、`ExaResearch`、`ExaWebsets`、`ExaFindSimilar`、`SearchProductDocumentation`、`SearchIntegrations`。

### Browser

`BrowserSession`、`BrowserNavigate`、`BrowserObserve`、`BrowserAction`、`BrowserExtract`、`BrowserGetContent`、`BrowserEvaluate`、`BrowserScreenshot`、`BrowserUpload`、`BrowserScroll`、`BrowserWait`、`BrowserSaveScreenshot`、`BrowserSaveRecording`、`BrowserGoBack`、`BrowserGoForward`、`BrowserRefresh`。

### Local files and execution

`Bash`、`Read`、`Write`、`Edit`、`SaveFile`、`FetchStoredFile`、`ViewImage`，以及 WSL V2 skill 的 `FetchSkillScripts`、`RunWithCredentials`。

### Artifact generation

`PublishWebpage`、`PublishSlides`、`CreateDocument`、`CreateTable`、`AddTableRows`、`UpdateTableCell`、`ExportTable`、`PublishFilePublicly`。

### Media and maps

`GenerateImage`、`GenerateVideo`、`GenerateAudio`、`GenerateAvatarVideo`、`TranscribeAudio`、`SearchImages`、`Geocode`、`SearchPlaces`、`GetDirections`、`DistanceMatrix`、`GenerateMap`、`GetWeather`、`GetStreetView`、`GetAerialView`。

### Agent、skill、knowledge、evaluation

`CreateAgentConfig`、`CreateAgentThread`、`WaitForAgentThread`、`SearchKnowledge`、`GetKnowledgeDetails`、`CreateSkill`、`FetchSkillScripts`、`RunWithCredentials`、`CreateMemory`、`UpdateMemory`、`CreateRubric`、`SearchRubrics`、`AnalyzeEvalHistory`、`StartImprovementBacktest`。

### 当前连接的 MCP integrations

- GitHub MCP：repository、issue、PR、branch、file、search 和 write actions。
- Magic Patterns MCP：design、artifact、file、design system、OS、preview 和 publish actions。

这些动态 integration actions 不应与内置工具数量混加；它们受连接账户、权限和 action schema 控制。

## 5. 本地后端实际执行面

当前后端约有 48 个潜在 model-tool name：

| 面 | 数量 | 当前状态 |
|---|---:|---|
| Workspace / resource | 6 | workspace_search、resource_read、resource_read_page、create_artifact、update_artifact、create_table |
| Public data | 3 | World Bank、NWS Weather、OpenAlex |
| Integrations | 31 | 13 providers，20 reads + 11 write preparations |
| Managed orchestration | 2 | shell_execute、update_plan |
| Registry discovery | 1 | tool_catalog |
| Moli / web | 6 左右 | web_fetch、web_semantic_tree、moli_screenshot、moli_screenshot_full、moli_pdf、web_eval |
| Child runs | foundation | durable child fields、admission、tree、cancel propagation |

### 已有核心运行能力

- `server/llm.mjs`：多轮模型工具循环、流式事件、工具 trace、上下文边界。
- `server/tool-registry.mjs`：统一 source/effect registry、schema 校验、catalog、调用隔离。
- `server/agent-runs.mjs`：SQLite durable runs、queue、cursor events、approval、cancel、child run foundation。
- `server/shell-runtime.mjs`：真实 bash、最小环境、进程组终止、审批边界。
- `server/tools.mjs`：workspace 搜索、资源读取、分页读取、文档/网页/表格产物。
- `server/integrations*.mjs`：13 provider 的实际 API adapter。
- `server/moli-*.mjs`：WSL Moli 网页读取和视觉产物。
- `server/skill-runtime.mjs`：manifest、approval、redaction、task foundation。
- `server/scheduler-admission.mjs`：disabled schedule、preview、admission、webhook signature/dedup foundation。

### 当前安全边界

- Shell 每条命令需要审批。
- 集成写入需要 approval 和显式 confirmation。
- Moli 只允许 HTTPS、私网阻断、超时和输出上限。
- visual artifact 生成后写入受保护 files 表和 uploads 目录，模型优先拿 file reference，不保留 Base64。
- skill credentials 只通过 credential provider / child environment 进入，不能进入 argv、prompt 或日志。
- Scheduler/Webhook 目前只做 admission，不自动执行外部写操作。

## 6. 逐项差距矩阵

### 已完成或接近完成

#### Thread Search

本地有 `workspace_search`，并且是 workspace-scoped。已补 `resource_read_page`，支持签名 cursor 和 UTF-8 安全分页。

差距：官方 Thread Search 更偏线程级语义检索；本地当前主要是保存文本的受限搜索。

#### Documents / Tables / Webpages

本地已有创建、更新、CAS 冲突、版本和 managed-run 持久化。

差距：Tables 主要是字符串矩阵；Library、全局表、导出和跨线程访问还不完全对齐。

#### Code execution

本地有审批式 Shell 和 WSL 真实执行，安全边界比无审批 shell 更严格。

差距：Skill Runtime 尚未与统一 durable task 完全融合，资源限制和 UI 仍需补齐。

#### Integrations

本地约 13 providers / 31 operations，包含 reads 和 prepare-write。官方集成目录是 250+ 应用，且连接、resource scope、unattended write policy 更完整。

### 部分完成

#### Search / Research

本地有 World Bank、Weather、OpenAlex 和 Moli URL fetch，但没有：

- 通用 Web Search；
- Find Similar；
- Exa Research；
- Exa Websets；
- Exa Answer；
- 多源引用汇总。

#### Browser

本地有 Moli：URL Markdown、semantic tree、screenshot、PDF、受限 read-only web_eval。

还没有：persistent browser session、navigate/action/observe/extract session API、click/type/fill/select/hover/drag、login handoff、cookie/profile 管理、CDP/WebDriver/BiDi session manager、upload/download orchestration。

#### Script / Skills

本地有 Skill Runtime foundation：manifest、固定 entrypoint、approval token、redaction、task/log/cancel contract。

还没有完整接入：credential store、server routes、skill marketplace/import、skill versioning and installation UI、与现有 `agent_runs.sqlite` 的统一执行队列。

#### Child Agent

本地有第一版 durable child foundation：parent/root/depth/child count、admission、tree 和 cancellation。

还没有完整的 agent-to-agent delegation：child agent 身份和权限继承、child tool allowlist、aggregate output policy、parent prompt/context contract、UI delegation trace。

#### Scheduler / Live / Webhook

本地已有 admission foundation：cron validation、preview、dedup、signature、queued record、write policy metadata。

还没有 scheduler worker、due occurrence claim/lease、Live Mode polling、webhook HTTP endpoint、delivery channel、unattended write controls 完整 UI、failure retry / alert policy。

### 尚未实现

- Images / Video / Audio / Transcribe / Avatar generation。
- Maps / Geocode / Places / Directions / Street View / Aerial View。
- Slides executor。
- HyperApps。
- MCP client/server protocol adapter。
- Memories 的完整自动学习和作用域策略。
- Rubrics 的完整 evaluate / analyze / A/B test 流程。

## 7. 实现顺序

### Phase 0：已完成基础

- Durable Agent Runtime；
- Tool Registry；
- Approval / Shell；
- Artifact persistence；
- Moli read-only web layer；
- Child Run / Skill / Scheduler foundation。

验收：主仓库完整回归 257/257 通过，提交 `89fea28`。

### Phase 1：统一权威能力和读取链

1. 把 `/api/capabilities` 接到 ComposerMenus / RealThread。
2. 让 `tool_catalog` 返回 capability ID、effect、executor、authorization。
3. 用 server manifest 隐藏没有 executor 的 Browser、Images、Slides 等菜单项，或以 disabled reason 展示。
4. 完成 `result_store_read`，把大结果统一存为 file/result reference。
5. 让 integrations、Moli visual、skill tasks 都使用同一结果引用协议。

验收：UI 可见工具、模型 callable tools、marketplace available tools 三者一致。

### Phase 2：Skill Runtime 完整融合

1. 将 skill task store 映射到现有 `agent-runs.sqlite`。
2. 增加 server routes：submit/status/logs/cancel。
3. 接入真实 credential provider，但只注入 child environment。
4. 绑定 approval token 到 manifest hash、entrypoint、capabilities、limits。
5. 增加 skill import/version/enable/disable。
6. 用 WSL V2 作为第一个生产验证 skill。

验收：通过一个 WSL skill 完成 submit → status → logs → cancel，全程没有 secret 进 prompt、argv 或日志。

### Phase 3：Scheduler / Live / Webhook 执行闭环

1. Schedule record + preview；
2. Durable occurrence admission；
3. Worker lease/claim；
4. 运行进入现有 agent queue；
5. Webhook signature + dedup + admission；
6. Live polling + change detection；
7. Delivery channels：thread、Slack、email 等；
8. Unattended write policy：read-only / ask-before-write / allow-writes。

验收：schedule/webhook/live 都只产生可观察 durable run；外部写入遵守 invocation policy。

### Phase 4：完整 Browser

1. Moli session manager；
2. Loopback-only CDP connection；
3. profile isolation；
4. browser navigate/observe/extract；
5. action/click/fill/select；
6. login handoff、stored login 和 CAPTCHA boundary；
7. screenshots、network trace、downloads、uploads。

验收：同一个 browser session 可完成打开页面、读取、点击、填写、等待和截图，并且取消后进程/profile 正确清理。

### Phase 5：Research / Media / Maps / MCP

1. Search provider 和引用模型；
2. Exa Research / Websets / Find Similar；
3. MCP allowlist + tools/list + tools/call + write approval；
4. Images / Video / Audio / Transcribe / Avatar；
5. Maps / Geocode / Places / Directions；
6. Slides / HyperApps。

### 不建议现在做的事情

- 不要把所有 42/48 工具都直接暴露给每个 run。
- 不要用静态前端 label 代表真实 executor。
- 不要用 shell 伪装 Browser、Search、Media 或 MCP。
- 不要在没有 durable task、approval、logs、cancel 之前开启 unattended scheduler。
- 不要把第三方 token 写进 prompt、argv、工作区文件或工具日志。

## 8. 验收标准与来源

### 每个新工具必须具备

- stable tool name / capability ID；
- schema validation；
- implemented/configured/authorized 状态；
- effect：read / write / external_side_effect；
- timeout；
- output limit；
- cancellation；
- structured event trace；
- untrusted result boundary；
- focused test；
- 完整回归中无回归。

### Agent 级验收

- 能从 thread、schedule、webhook 或 child run 创建 durable run；
- 页面关闭后 run 不丢失；
- 工具调用可重连和分页读取；
- 写操作有 approval 或 invocation policy；
- 大结果变成 file/result reference；
- skill secret 不进入模型上下文；
- child run 有深度、数量、并发和输出预算；
- scheduler 不绕过现有 approval/write policy。

### 官方来源

- Tools：https://www.hyperagent.com/docs/tools
- Tool reference：https://www.hyperagent.com/docs/tools#tool-reference
- Tools and integrations：https://www.hyperagent.com/docs/tools#tools-and-integrations-are-different
- Agents：https://www.hyperagent.com/docs/concepts/agents
- MCP clients：https://www.hyperagent.com/docs/concepts/agents/invocations/mcp-server
- Integrations：https://www.hyperagent.com/docs/integrations
- Library：https://www.hyperagent.com/docs/concepts/library

### 本地代码状态

- Commit：`89fea28 feat: expand agent tool runtime and Moli capabilities`
- 最近完整回归：257/257 通过。
- 另有本地原有未提交变更：`package-lock.json`、`scripts/dev.mjs`、`vite.config.ts`、旧 parity 文档和备份目录；它们不应被误认为本次 agent 工具改造的一部分。
