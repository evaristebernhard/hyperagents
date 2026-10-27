# 0.3 local-first content layer

## 为什么现在不需要数据库

Skill 在这一阶段是名称、说明、适用时机、标签、Markdown 文档和 Agent 引用关系，并不是需要运行的后端程序。几条固定内容可以随前端静态发布。用户编辑后的内容存到浏览器，JSON/Markdown 可用于交换。只有多人共享、多设备同步、权限、审计、大体积文件或服务端执行进入范围时，才需要数据库和身份服务。

本版本没有引入数据库 SDK、后端 API、LLM SDK 或任务队列。继续使用 React / TypeScript / Vite，新增 DOMPurify 用于 HTML 预览清理。

## 数据结构

`WorkspaceProvider` 管理工作区集合。每个工作区隔离保存：

- Threads：消息占位、星标、归档、项目/房间关系、工作笔记、是否排除知识的本地标记。
- Agents：身份、模型/提供商/推理偏好、工具开关、已关联 Skills、记忆模式、学习建议偏好、Library 开关。
- Skills：Markdown 文档、标签、适用时机、来源标记、时间戳、归档状态。
- Memories：内容、类别、重要性、标签、适用时机、置顶、范围标记。
- Rooms：主题、已关联 Agent、讨论笔记、关联 Threads。
- Artifacts：Document / Webpage / Image / File、内容、关联项目/会话、归档状态、可恢复版本。
- Schedules：名称、指令、频率、Agent/Room 引用、启用配置标记。没有执行器。
- Rubrics：手工名称与逐行评审标准。没有 LLM 评估。
- Connections：服务名称、标签、公开 HTTPS endpoint、UI binding 状态。没有 OAuth、密钥或真实连接。

存储键为 `hyperagents-demo:workspace-v1`。现有 0.2 的 threads/projects/agents/memories 会在没有新存储键时迁移，不删除旧键。全局外观、账户演示资料和默认偏好仍使用旧前缀键，不属于内容备份。

## 已完成的本地操作

### Skills

创建、Markdown 预览、编辑、归档/恢复、复制、删除、JSON/Markdown 导出、JSON/Markdown 导入、市场模板安装、避免重复安装、关联 Agent、显示使用数量、全局搜索入口。

导入文件限制 1 MB；不运行脚本；社区内容是标注的可编辑 sample，不声称抓取了原站完整官方技能。

### Rooms 与计划

新建/编辑/归档/删除房间，添加本地 Agent 身份，持久化讨论笔记，关联已有会话；计划配置支持新建、编辑、启用标记、删除和刷新后保留。

计划的启用标记不代表后台运行。所有计划明确显示 Execution off。

### Library 与会话

新建文档/HTML/文本产物，导入小于 2 MB 的本地文件或常见图片，编辑并留存版本，恢复旧版本，下载、归档/恢复、删除，关联会话/项目。会话画布读取同一份数据；工作笔记保存后在 Library 可见。

HTML 预览经过 DOMPurify 清理，移除脚本、嵌套活动内容与资源 URL 等属性；之后放入没有 allow-scripts 的 sandbox iframe，并设置 CSP。预览不会执行嵌入代码或加载远程图片。导出的 HTML 保留用户原文，打开下载文件前应自行审核。

会话支持本地分叉、移动项目、归档/恢复、重命名和导出。所谓 regenerate name 只从已有消息/摘要取标题，不调用模型。

### 工作区和备份

`/workspaces` 可以创建、改名、切换隔离的本地工作区；导出所有工作区为 JSON。导入时先验证结构、必需字段、集合和重复 ID，再显示替换确认；错误文件不会改变当前数据。

备份导入限制 10 MB。浏览器 localStorage 配额因环境而异；保存失败时会显示导出备份警告，不声称已持久化。

## 服务边界

仍然不包含：真实登录/OAuth、跨设备/多人同步、真实邀请、公共分享链接、付费升级、远程 API 凭据、后台调度、自动生成 Wiki、LLM 对话与工具执行。

这些是联网服务或执行能力，而不是仅靠页面切换可以实现的功能。相应 UI 不会把本地配置展示成真实认证或实际执行。

## 验证与基线

基于仓库提交 `50f7fc95c3e57f5a891b238a644930594db785d5`，保留 `vite.config.ts` 中用户配置的 `lp.chayu123.me` allowedHosts。

新增回归覆盖 Skills 编辑/导出/安装、完整 Agent 配置、Memory 编辑、Room/计划、文档版本与画布联动、Thread 分叉归档、本地工作区隔离、备份校验和旧数据迁移、HTML 预览隔离、连接元数据配置与手工 Rubrics。
