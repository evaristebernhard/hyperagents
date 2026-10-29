# 网页预览修复与回归验证（2026-10-29）

## 修改范围
- src/LibraryManager.tsx：网页 iframe 改用 buildWebpagePreview；保留 sandbox="" 与 no-referrer。
- src/webpage-preview.ts：DOMPurify WHOLE_DOCUMENT 保留完整页面 head CSS；显式禁止脚本、事件处理、表单、嵌套 frame、外部资源属性；首位注入严格 CSP。只保留片段导航和简单 mailto 地址，外部链接移除。
- scripts/webpage-preview.test.mjs：真实 Chromium 5 项专项回归；仅绑定 127.0.0.1 临时端口，不启用真实应用或工作区，不加载生产凭据。

srcdoc 的相对 # 链接可能基于父页面地址解析，因此预览内的片段改写为 about:srcdoc#目标。原始保存 HTML 没有被改写；下载仍是原始文件。

修改前文件备份：本目录 LibraryManager.before-preview-fix.txt。未覆盖其他已有工作树修改，未提交 git、未安装依赖、未重启服务。开发服务现有热更新已应用修复。

## 验证结果
1. npm run typecheck：通过。
2. node --test --test-timeout=20000 scripts/webpage-preview.test.mjs：5/5 通过。
   - 完整 HTML 的 head 样式、深色背景/蓝色文字、3 项目卡片。
   - 不透明 sandbox iframe 内片段点击滚动，父页面不导航。
   - 390px 媒体查询与真实 hover 样式。
   - script/onload/onclick/iframe/form/base/javascript:/外部链接仍被移除或阻止。
   - 外部 @import、CSS url()、转义 URL、图片不实际发出网络请求；浏览器报告 CSP 拒绝。
   注：Chromium 对 CSP 拒绝的尝试仍发 request 事件，本测试通过网络路由零派发 + requestfailed 的 csp 错误验证，不能简单把 request 事件当作网络已发出。
3. node --test server/frontend-safety.test.mjs server/tools.test.mjs：11/11 通过。
4. 真实 https://hyper.chayu123.me/thread/thread-61d2bddb-ca18-4615-9dc2-40c8814b8f1c ：原有林舟网页产物无需重新生成，右侧恢复深色蓝调；实际点击“项目”，滚动到项目标题及第一张项目卡，父应用仍在原线程。

最终专项测试任务：2905ec69f2a94f00a6a814bdd8a5236a，succeeded。
既有安全/工具测试任务：ee08734add3949b194d6567d12ff3501，succeeded。
早期测试曾暴露正则兼容性与测试服务挂载位置/动画帧等待/浏览器 CSP 错误文本差异，已修正后重新执行；以上为最终结果，不声称首次即通过。

## 尚未覆盖
没有跑完整所有项目测试或重新打包生产 dist；没有修改 agent 的验证工具、调用日志、提示词、并行调度。mailto 被保留供显示/导出，但不放开 sandbox 去启动外部应用。后续优先增加 artifact_validate，让 agent 能发现保存源码和最终预览之间的差异，而不是连续做关键词搜索。
