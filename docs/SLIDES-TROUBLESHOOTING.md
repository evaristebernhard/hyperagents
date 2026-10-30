# Slides 测试：授权与项目背景

## 为什么请求里写 publish_slides 仍不可调用

模型只能调用这条消息保存的工具集合。默认线程可能只有 Thread Search、Documents、Webpages、Tables；正文中的工具名不是授权，服务上实现了 Slides 也不等于当前线程已开启。

- 输入框的工具菜单中勾选 Slides，或在线程 Configuration 的 Tools preference 加入 Slides 后保存。
- 新增的显式按钮会启用 Slides 并选择 Slides 输出；必须由用户点击，不根据正文自动授权。
- 在旧运行后开启工具不修改它的历史快照。开启后发送一条新消息，不是重连旧运行。
- 观察工具历史中的 publish_slides 和产物 kind=Slides；Succeeded 仅表示运行正常结束，不证明某个指定工具被调用。

## 不做虚假的产物替代

选择 Slides 输出时，create_artifact 的 Document/Webpage 替代会被拒绝，必须使用 publish_slides。未启用 Slides 时模型应说明开关步骤并等待，不应擅自做网页骨架。未选择输出格式的自由文本也有明确的模型行为约束，但没有用不可靠的自然语言关键词来自动授予权限。

已有 Webpage 不会被自动改型或删除；它依旧是 Webpage，预览仍禁止脚本，不能据网页源码里的翻页逻辑宣称 Slides 导航可用。

## “本项目”的范围

工作区内选择的 Project、附件、文档和用户消息才是模型的项目背景。agent 不会自动读取运行服务的源码仓库。下面的测试提示自带背景，不依赖一个空工作区猜测事实：

> 项目名称：Hyperagents。目标：本地实现可追踪、可审批的 agent 工具平台。前端使用 React、TypeScript、Vite，后端使用 Node.js 24 和 SQLite。当前已有持久化运行与工具日志、审批式 Shell、文档与表格操作、Moli 浏览器子集、独立 Slides 产物和可配置的 Exa 搜索适配器。请只使用以上事实，调用 publish_slides 保存三页：第一页面向用户的目标，第二页整体架构，第三页已有能力与后续方向。不要以 Webpage 替代，不要编造用户数或性能数据。

本次修正不编辑用户既有消息、项目或产物。验证使用合成模型响应，不以此冒称生产模型端到端成功。
