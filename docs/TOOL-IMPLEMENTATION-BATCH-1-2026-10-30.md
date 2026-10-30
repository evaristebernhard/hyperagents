# Agent 工具逐项实现：清单与第一批交付

日期：2026-10-30。目标是功能与执行语义对齐，不要求名称一模一样；不把 UI 开关、接口壳或仓库存在算作实现。

## 当前工具面的分组核对

以下按本次 Hyperagent 会话实际工具面归类。不同部署可能提供不同工具；此表不是官方私有架构说明，也不是本地执行授权表。

| 工具面与代表工具 | 本地实际基础 | 本批/后续处理 |
| --- | --- | --- |
| 工具发现：SearchIntegrations、GetToolGuidance | tool_catalog，统一 registry，集成 action definitions | 继续用同一 registry；发现不等于连接、授权或安装 |
| 网页研究：ExaSearch、ExaContents、FindSimilar、Research、Websets | Moli URL fetch、semantic tree、公开领域 API | 缺通用搜索与 Exa provider；须单独配置服务，不能用 Browser 假装搜索引擎 |
| BrowserSession/Navigate/Observe/GetContent/Extract | 原 moli-browser-session 只是一层未绑定 hook | 本批新实现真实 CDP driver 与 run-scoped 工具，接入 llm registry |
| BrowserAction/Evaluate/Upload/Handoff/Recording/StoredLogins | 无完整闭环 | 尚未开放 click/type/任意 evaluate；先保持权限边界，不把网页动作统一标成只读 |
| BrowserScreenshot/Back/Forward/Scroll | 原有 URL 截图与 PDF 工具，非 session | 本批新增当前 session 的 history/scroll/PNG 保存 |
| Bash/Read/Write/Edit、SaveFile/FetchStoredFile/ViewImage | 逐命令审批 Shell；上传/下载、有限 UTF-8附件读取、视觉文件存储 | Shell 不等于独立受限文件工具；本批复用真实文件存储支持 table export，图像/PDF理解仍需模型能力 |
| Create/Read/UpdateDocument | Document artifact、版本与 staged persistence | 现有创建/更新可用；章节级操作、跨线程授权和历史读取仍待补齐 |
| Create/Get/Add/Update/Delete/ExportTable | 只有 create_table 和整表 update_artifact | 本批补 get_table/add_table_rows/update_table_cell/delete_table_rows/export_table |
| PublishWebpage/Slides/HyperApps、HealthCheck、PublicPublish | 沙箱 Webpage artifact、版本与分享机制 | Slides 仍需独立类型/导航/预览；不能把网页输出直接叫 Slides；不新增动态应用假实现 |
| GenerateImage/Video/Audio、Transcribe、Avatar/Voices | 未提交 media-maps adapter 合约 | 不修改已有未提交合约；没有 provider 与凭据时不注册伪可执行工具 |
| Geocode/Places/Directions/Weather/Map/StreetView | 领域 Weather API；地图 adapter 合约 | 需要专项 provider、地理范围和文件/地图结果契约；不拿演示点代替实际数据 |
| Search/GetThreadMessages/Outbound | workspace_search/resource_read，可读线程文本 | 后续补线程级游标与发送审计；不把一次文本搜索当成完整 Thread Search API |
| Knowledge/Skills 与 RunWithCredentials | skill 文档注入；skill-runtime foundation | 下一批重点：脚本执行与 durable run 关联、真正 credential provider、显式授权与脱敏；文档不增加执行能力 |
| AgentConfig/AgentThread/Wait/SendThreadMessage | agent UI CRUD；child-run foundation | 后续补模型可调用配置草稿、委派身份与权限交集，复用主干而非并入另一个 bot runtime |
| Rubric/Eval/Backtest/Learning | 部分保存实体和 UI | 需真实评估样本与作业，不做虚构评分/回测结果 |
| ScheduleWakeUp/Live/Webhook/IM | scheduler admission foundation | 触发入口只创建 durable run；补去重、恢复、unattended write policy |
| AskQuestion/SuggestFollowUps | 当前主要文字/常规 UI | 后续补可持久化问题/选项事件；问题不是额外授权 |

## 第一批：14 个新增模型工具

### Browser：9 个

- browser_session：create/status/close；每个 LLM run 一份独立实例。
- browser_navigate：公网 HTTPS 导航，返回真实 URL、title 和 HTTP status。
- browser_observe：DOM 文本和交互元素摘要，不宣称视觉 AI。
- browser_get_content：当前页/选择器的 text 或 HTML，限长。
- browser_extract：显式 CSS selector 字段与可选 rowSelector，不另调用模型。
- browser_back、browser_forward、browser_scroll。
- browser_screenshot：当前会话 PNG，经真实 workspace file storage 保存后返回元数据。

代码：server/browser-runtime.mjs；在 server/llm.mjs 中绑定 source=browser，保留现有 tool/tool_trace 事件。Plan/Ask 模式不暴露。LLM run 结束、取消或超时会关闭进程和临时 profile。句柄只在该 run 的闭包内有效，不可跨 workspace/run 使用。一个 session 内操作顺序执行。

本批是 ephemeral run-scoped session，不是持久浏览器、人工接管或录像服务。不同 run 不继承登录态，也不假装能够重启续跑浏览器操作。

#### 为什么首批用 CDP/Moli

实际依赖检查：项目已安装 Playwright，Moli 1.1.19 可执行；Lightpanda 只有源码，Moli 不支持原生 MCP。因此采用已有 CDP transport，不新增依赖、不编译浏览器，不把 Moli 说成 Lightpanda。

受信配置 BROWSER_PROVIDER 默认 moli；BROWSER_PATH 可显式指定二进制；MOLI_PATH 保持既有支持。provider 不自动 fallback。未来 Lightpanda 只有通过具体版本/flag/协议验证后才能接入；当前源码 clone 不会让它自动 available。

CDP 通过 HTTP /json/version 取得真实 WebSocket endpoint。直接猜 ws://host:port 根路径不能连接。Moli 1.1.19 配合 Playwright 的 Fetch route interception 会使导航停滞，因此没有把一个失效的 route hook 当作安全功能保留。

网络边界保留在真实 engine 的 --block-private-networks，命令也不传 ambient proxy 或服务密钥；导航参数及返回的主页面 URL 另限制为公共 HTTPS hostname，不允许 IP literal、localhost、内网域名、file URL 或 URL credentials。该 flag 只覆盖直接解析目标，不能被当作代理场景的安全承诺。生产放开代理或增加交互前需重新核查网络策略，不能只复用 URL 正则。未把全套 DNS-rebinding/重定向/子资源安全矩阵说成已验收。

截图来自 Moli --layout 渲染器，不承诺与 Chromium 像素一致。能力 manifest 的 configured 表示依赖与必要 flags 可用，不等于每个网站都能正常加载。

### Tables：5 个

- get_table({id})。
- add_table_rows({id,rows})。
- update_table_cell({id,rowIndex,columnIndex,value})。
- delete_table_rows({id,rowIndices})。
- export_table({id,format:'csv'|'json'})。

明确使用零基数组索引，不伪造稳定 rowId；删除后后续行索引会移动。所有修改保持当前 thread 所有权，读取遵循既有 workspace 读取边界。修改复用 staged patches、原始 CAS base、版本和行/列/字符/字节限制；失败不破坏此前成功的 overlay。

导出使用真正持久化文件回调，不返回临时主机路径或编造下载 URL。CSV 支持 Unicode、逗号、双引号和换行；公式样式单元格加 apostrophe 前缀并在结果说明，JSON 保留原始字符串。返回真实存储的 MIME/时间等元数据，避免附件读取因元数据不一致而失败。下载仍走现有登录和 workspace 授权 API。还没有自动把这些文件做成新的 Library 卡片或消息下载按钮。

## 接线与变更边界

- server/app.mjs 将原生成视觉文件存储扩展到 text/csv、application/json、text/plain；仍有 MIME、大小、文件名和 workspace 校验。
- server/capability-authority.mjs、marketplace.mjs 与 index.mjs 使用同一 browser 配置；UI 只在依赖可用时提供 Browser。
- 既有 moli-browser-session.mjs、media-maps-adapters.mjs 和其他用户未提交模块未改。
- 不迁移数据库、不变认证、不安装依赖、不启动常驻新服务、不移动 clone、不 commit/push。

## 验证口径

按用户效率要求，采用少量关键测试、一次后端回归/构建以及一次最终真实 browser 往返；排障过程中只针对 CDP endpoint 与 interception 兼容性做定向检查，不扩展大测试工程。

单元/集成测试覆盖：run-local session、顺序执行、URL拒绝、真实保存回调、LLM dispatcher 与清理；表格权限/索引/原子失败/版本/导出。测试中的假 driver 不算真实浏览器验证；假模型不算 DeepSeek 生产模型往返。最终实际运行日志另记录在本轮交付总结中。

下一批优先顺序：可执行 Skills 的统一任务生命周期 → 子 agent 委派 → Slides 的真实产物类型/预览 → 配置过的搜索 provider。Browser click/type 需先接逐动作审批；不因已有 CDP 就直接开放任意外部写动作。

## 本轮最终验证记录

- Backend：281/281 通过（首次回归识别并修正一条仍把 Browser 视为永远 unavailable 的旧测试，现使用显式缺失路径检验配置拒绝）。
- Typecheck 与 Vite production build 通过；仍有既有大 chunk 警告。
- 真实 Moli/CDP：公网导航 HTTP 200、当前页文本、DOM 观察、CSS 提取成功；PNG 95375 bytes，签名 89504e470d0a1a0a。临时会话在 finally 关闭。
- 未做真实 DeepSeek 生产往返；未做 UI 全量端到端；未完整验证 history/scroll 与全部网站兼容性；未声称完成所有网络安全场景。
- 代码已落盘，未重启现有运行服务，也未 commit/push。
