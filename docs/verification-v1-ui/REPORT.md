# main 原版 UI 接入 backend v1

日期：2026-11-03。界面基准：`main` 的 `cffd7c34e62608d3bb84996aea3d62433b280007`。

## 实现

复用 main 的 App 侧栏、首页、登录卡片、Composer 样式、对话布局和 ArtifactCanvas。移除分支新增的 Tasks 页面、入口和旧页面专用浏览器测试，以及尚未提交的简化工作区。原有 fixture 模式的修复保留。

`src/v1-client.ts` 连接 `/api/v1`，处理 Cookie 会话、CSRF、稳定提交键和会话失效；`V1Composer` 使用真实 capabilities 显示模型、文件格式及沙箱状态；`V1Thread` 在原对话中显示消息和执行状态，支持运行中补充指令、取消、文件预览/下载和历史版本。后端保存的助手结果 JSON 映射为正文，文件引用由原产物面板承载。

事件按 `after` 游标分页读取并去重，断线重试续接；刷新从服务器重建消息、任务和产物。登录失效卸载私有工作区，重新登录后重新加载；不导入旧 localStorage 样例。模型由服务端选择，工具按服务端能力管理；自定义 Agent、额外工作区、分享、集成、项目、手动编辑/恢复产物等未实现入口禁用。历史版本可预览下载，继续对话生成新版本。

## 本机复现

```sh
npm ci
npm --prefix backend ci --ignore-scripts
npm --prefix backend run build
npm run dev:v1
```

访问 **http://localhost:5174**。旧服务继续使用 `5173/8787`，v1 使用 `5174/8081/55432`。重复启动先检查端口并退出，不停止已有服务。

新账号、PostgreSQL 和文件位于 `backend/.data-v1/interactive`。首次初始化自动生成本机账号，登录凭据只写到该目录的 `access.json`（0600）；已有账号不重置。`.env` 提供模型配置，私有 `backend/.data-v1/runner.env` 提供 Runner 地址/令牌；无 Runner 时 PDF/PNG 选项禁用，不回退宿主执行。Runner 单独启动，参见 [部署说明](../../backend/deploy/OPERATIONS.md)。本地入口仅绑定回环地址。

验证脚本：

```sh
npm --prefix backend test
node --test server/frontend-safety.test.mjs
npm run build:v1
npm run test:v1-adapter
# 需要已启动的 dev:v1、真实模型与 gVisor Runner；会创建测试对话、文件和隔离测试账号。
npm run test:v1-ui
```

`build:v1` 包含 TypeScript 检查。确定性浏览器脚本启动临时 5184 Vite，拦截全部 API，不访问模型、数据库或用户数据。真实浏览器脚本读取本机私有凭据，不在日志或报告中输出密码/令牌。

## 本次验证

- 后端：49 项通过，0 失败、0 跳过；使用独立临时 PostgreSQL。
- 私有文件保护：3 项通过，覆盖原目录、`.data-v1`、编码路径、`@fs`、`?raw`、数据库旁文件和符号链接。
- 原默认前端构建、v1 前端构建与 TypeScript 检查通过。Vite 保留大于 500 kB 的 bundle 提示，不影响构建。
- 确定性浏览器：缺失沙箱禁用 PDF、提交响应丢失后使用同一幂等键、105 条事件分页、断线后从 105 续接、刷新无重复、等待用户时展示真实问题与继续指令、无请求体取消、会话失效卸载工作区，全部通过。
- 真实浏览器：原样式邮箱登录 → 上传要求文件 → 中文数学 Markdown/PDF → 执行中补充指令 → 刷新恢复同一任务 → 下载 → 继续修改 → 同一产物 version 2 → 查看/下载 version 1，全部通过。
- 真实浏览器：取消任务、服务端注销后的自动登录提示与重新登录通过。
- 第二用户：对话列表为空；另一用户的对话、任务、事件、产物、下载均返回 404。
- 新入口停止并重启后，既有账号、对话、两份产物的版本与下载内容保留；修订 PDF 的中文文本提取包含“使用说明”和“答案”。额外浏览器检查无未预期 console error。
- 两个开发端口的 `.data-v1` 直接、编码与 `@fs` 请求均返回 403。旧进程仍保持运行。
- 最终浏览器 pageerror 为 0，旧 `/api/*` 接口请求为 0。检查侧栏、首页、对话和产物面板截图。

机器结果见 [result.json](result.json)，截图见 [首页](home.png)、[完成任务](completed.png)、[历史版本](versions.png)。本次发现并修复了无请求体 POST 错带 JSON 请求头导致取消/注销返回 400，以及助手结果 envelope 直接显示的问题。

## 保留的限制与历史证据

PDF 内嵌预览使用浏览器原生阅读器；无原生阅读器的环境需使用下载。图片、Markdown、文本和隔离 HTML 在产物面板预览。画布布局偏好属于当前页面状态，刷新后恢复默认；不会伪装成服务端持久设置。当前后端对话/任务列表最多 100 条、单对话消息最多 1000 条。

原有完整真实模型评测 **35/36**、数学/PDF/修订 **3/3** 和 gVisor 验收保留在 [后端报告](../../backend/VERIFICATION.md)。这些是历史质量证据；本次前端验收不声称重新执行全部 36 次评测。先前简化工作区的报告保留为历史记录，与本报告区分。

没有提交数据库、密钥、账号凭据或运行缓存，也没有 push。
