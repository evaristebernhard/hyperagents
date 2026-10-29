# 实测：同题创建中文个人主页（2026-10-29 08:54 UTC）

## 证据范围
本报告基于两站真实提交、官方线程工具调用记录、本地本次 run 的只读 SQLite 事件、保存源码与浏览器预览对照。不是私有服务架构推断。先前 HYPERAGENT-COM-PARITY-2026-10-29.md 中未经本轮实测的性能、恢复与能力泛化结论不作为本报告依据。

官方线程：https://hyperagent.com/thread/cmvtb4xlt0ese07adbgsldqbb
本地线程：https://hyper.chayu123.me/thread/thread-61d2bddb-ca18-4615-9dc2-40c8814b8f1c
本地 run：ab985330-22c8-4869-a143-c8ec57624f00
本地产物：artifact-c4985975-b853-49aa-a814-ee6b5c5dd483
官方产物：cmvtb6jki0f4f07adnyz987pb
完整相同提示词见 PROMPT.txt。两站默认模型/能力设置未人为对齐；本地 deepseek-flash，官方界面显示 Choose your model，未确认具体模型。因此不是模型性能或速度基准测试。

## 官方实际调用（逐次报告见 001–006）
1. 08:54:58.577 UpdateDocument：创建三步计划。
2. 08:55:47.811 Write：写入 /agent/workspace/linzhou.html。
3. 08:55:54.246 Bash：Python HTMLParser 静态断言（锚点、项目卡片、外链、CSS、断点等）。
4. 08:56:00.440 UpdateDocument：标记编写与静态检查完成。
5. 08:56:03.763 PublishWebpage：读取 HTML 文件，生成线程内网页产物，不是公开分享。
6. 08:56:08.571 UpdateDocument：标记发布完成。
共 6 次调用，其中实际交付链为 Write → Bash → PublishWebpage，其余 3 次为进度记录。右侧真实预览已看到深色背景、蓝色按钮、排版与导航。最终答复明确仅做静态检查、未用浏览器；没有把像素级验收说成已通过。

## 本地实际调用
create_artifact ×1 → resource_read ×1 → workspace_search ×14 = 16 次。
数据库 run：started 08:55:25.731，finished 08:56:19.927，succeeded，result_saved=1，54.196 秒。
usage 为各轮累计：prompt_tokens 216994、completion_tokens 10212、total_tokens 227206；不等于单轮上下文大小或美元成本。
首次 create_artifact 返回 prepared；产物在 run 成功后才出现，最终 Artifacts 1。运行中一度 Artifacts 0。本次切走并重新打开后运行仍在，最后成功保存；证明本次查看重连有效，不证明进程崩溃恢复。

持久化 tool 事件有 id/name/status/summary，缺少原始调用参数；resource_read 摘要在约 1200 字符截断。14 次搜索的精确 query 未保存在这些事件中，不能从答复反推成已证实参数。已有摘要能确认多次检索返回匹配片段或空结果，不能取代 DOM 结构断言。

## 已证实的交付缺陷：源 HTML 正确，预览破坏
从 Edit artifact 的未修改源码只读解析：18375 字符，style=1，a[href]=12，article.project=3；深色 #0a0e17、蓝色 #3b82f6、:hover、@media 都存在，10 个片段链接全部有对应 ID。
从实际 iframe.srcdoc 解析：5658 字符，style=0，带 style 属性元素=0；检查的链接 href 全部为 null。
真实截图：官方右侧为深蓝完整网页，本地右侧为白底黑字、默认列表、无样式页面。
定位：src/LibraryManager.tsx:43–74，DOMPurify.sanitize 对完整 HTML 采用默认片段净化，头部 style 未保留；FORBID_ATTR 显式包含 href（行 63），因此 #about/#projects 等内部锚点和 mailto 一并丢失。iframe 的 CSP 已允许 inline style，但缺失的 CSS 无法恢复。
本地 agent 虽称无浏览器验证，但依据保存前源码检索宣称交付完成，无法发现渲染管线破坏。运行成功不等于最终交付满足要求。

## 按本次证据排序的修复建议
P0：独立网页安全渲染函数，保留受控 CSS 和片段锚点；继续禁用脚本、事件处理、form、iframe、远程资源与危险 URL，保留隔离 sandbox/CSP。不要为显示样式直接取消所有净化。
P0：用此已保存产物加回归测试：深蓝背景实算样式、3 项目、窄屏布局、点击片段链接可达；另测 script/事件/javascript:/外部 CSS/url() 不导致执行或网络请求。
P1：提供 artifact_validate 静态验证工具，一次返回锚点、项目数、外部依赖、CSS 与净化前后差异；避免 14 次关键词搜索替代校验。
P1：tool 事件保存经过脱敏与限长的参数摘要、起止时间、结构化结果和 artifact ID；当前日志无法精确重放每次 query。
P1：更新工具描述/提示词：托管模式是服务端提交，不应继续告诉模型“client commits”；本次最终答复仍出现“客户端确认后保存”，与 Result saved by the server 不一致。
P2：在有独立性证据后才考虑工具并行。此任务的主要问题不是缺少并行；生成→检查→提交本身有依赖。

## 未做与限制
未修改产品源码、未安装依赖、未重启服务、未公开分享。浏览器只用于观察被测产物，不替任何被测 agent 生成页面。未在此次测试中验证调度、技能执行、浏览器工具、跨进程恢复或自动学习；不能据此宣称这些普遍可用或不可用。
