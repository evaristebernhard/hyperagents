# Legacy Agent的独立SCNet模型

这份说明针对当前`scripts/dev.mjs` / `server/app.mjs`的SQLite运行层，未切换到v1/PostgreSQL。真实运行态和能力审计见外层`docs/hyperagents-agent-audit.md`。

启动时显式读取外层`deploy/scnet-hyperagents/.runtime/model.env`中的`HYPERAGENTS_MODEL_BASE_URL`、`HYPERAGENTS_MODEL_API_KEY`、`HYPERAGENTS_MODEL_NAME`，三项必须齐全。URL必须是私有回环HTTP转发，可用`/v1`路径。环境变量优先；`HYPERAGENTS_SCNET_ENV_FILE`可指定专用新配置路径。此配置不写到浏览器、日志或SQLite设置中。loader不读取旧`.env`或用户数据；原启动器继续按原逻辑保留原DeepSeek配置。

配置存在时，`createApp({scnetModelConfig})`让主对话llm、Router/Worker模型和明确确认后的微小provider probe都使用这一个独立SCNet模型，配置元数据标记真实provider/model。不再把新服务显示为DeepSeek，也不会因点击新模型测试而调用旧付费API。fixture通过显式对象注入，不隐式打开专用运行文件。

回滚时由服务管理流程设置`HYPERAGENTS_MODEL_PROVIDER=deepseek`并重新启动应用，或移走专用新配置后再启动。原私有`.env`、账号、workspace SQLite和文件没有被本适配器改写或迁移。回滚只改变后续模型调用，不把历史产物或任务冒充由另一模型生成。生产备份/停止/切换由主流程统一处理，本实现没有自行重启服务。

## 文本接口如何执行工具

当前SCNet文本endpoint不支持原生tool_calls、tool角色或DeepSeek thinking字段，输出上限也低于原接口。适配器先给出名称、短用途和workspace/public-api来源的语义目录，再由真实模型输出`{"action":"tool","name":"已授权名称"}`或`{"action":"answer"}`，然后只发送选中单工具的schema生成参数。完整JSON必须通过原完整schema，真实执行仍由原registry、权限、审批和事件负责，不按中文关键词挑工具或伪造执行。可显式配置`toolAllowlist`缩小registry权限，实际名单在配置元数据中公布；SCNet默认不绑定可选追问建议和重复目录发现工具。

格式错误整轮最多修复一次；完整包住JSON对象的一层Markdown围栏可做格式归一化，不从任意解释中提取部分对象。未授权、重复错误、过大目录/schema和截断JSON明确失败。目录最多32个工具，选择/最终阶段文本最多2200字节、参数阶段1900字节，以当前3072输入token为保守限额。大上下文会缩短，不能声称保留旧服务全部40条/4万字符历史；显式选择的既有报告可提供有界正文片段。最终回答转发真实SSE，不输出隐藏推理。

2026-11-12 更新：原始任务和最新纠正分开保留，子任务事件作为观察；真实 agent ID、子运行状态/已保存结果及计划依赖有独立的有界投影。上下文优先保留原任务，参数阶段为编排场景使用最多2200字节；`update_plan` 参数生成省略该阶段无关的 agent 目录。375字节完整任务、七工具目录、两个子结果和三步计划的回归已通过。原任务初始超过600字节或最终预算仍需裁剪时，显式带上 `goalTruncated`；这仍不是完整长上下文支持。schema 唯一允许空对象时，仅用验证后的 `{}` 作为参数，工具选择仍由真实模型决定；可选字段与复杂约束照常生成并验证。最终修复后的真实模型多步质量尚未复验。

同run内连续重复同工具和规范化JSON参数触发`SCNET_REPEAT_GUARD`，第二次不执行且run明确失败。这只防循环，不强制下一工具；参数变化和新用户轮次仍可执行，不是跨请求exactly-once保证。

两个legacy入口的请求在同进程按SCNet origin共用有界FIFO，最终流结束/取消才释放。跨进程碰到接受前429等暂时状态最多6次有界退避；不会在已经接受的部分输出、非法决策或工具效果后自动重放。模型selector/参数生成属于额外真实模型调用，宿主的一轮并不等同于只有一次上游请求。当前最终文本流usage仅覆盖最终生成，不应据此编造完整token成本或美元账单。

## 持久浏览器接线

启动器显式加载外层`deploy/browser/.runtime/browser.env`，后端实例不自行读取凭据。`server/persistent-browser-tools.mjs`使用外层`server/persistent-browser-client.mjs`，因此当前嵌套checkout需保留外层client/broker文件。公开`/api/browser/*`仍经过现有登录、Host/Origin和CSRF校验，再校验workspace。

命名空间由服务器对workspaceId作SHA256，客户端不能选择owner。每次managed run以真实runId持有agent lease；无durable run的直接chat使用随机binding id。模型可导航、观察、保存截图，并使用真实观察引用点击、填写普通字段、按键、滚动、切换标签和访问历史。过期观察与人控期间的动作被拒绝；密码、验证码和支付字段通过用户接管画面输入。[当前浏览器与恢复说明](BROWSER-PERSISTENCE.md)。

takeover/handback和profile由共享broker控制。`browser_request_takeover`本身在宿主阻塞，不依赖模型再选择wait；明确交还后才返回实际observation。超时/未确认交还触发致命`BROWSER_HANDBACK_REQUIRED`，不会吞成普通工具错误继续下一模型轮。结束只释放lease，不关闭profile或自动夺回human控制。未配置broker时真实启动不回退为临时浏览器；`configured`只代表配置存在，健康与登录另需实测。

## 验证边界

受控SCNet回复、client和临时SQLite测试覆盖真实宿主工具循环、持久记录、非法决策、预算、重试、取消、scope、强制handback及重复工具拒绝，不能替代实际小模型多步质量或用户登录。

真实研究仍未达标：首轮主问题及追问未公开搜索、无报告；语义目录和精确授权后，只开放`web_search/create_artifact`，真实模型连续12次搜索，未保存报告，达到内部24次上游预算。失败保留在外层`docs/hyperagents-agent-live-before.json`与`docs/hyperagents-agent-live.json`。后加的通用循环保护只有fixture验证，没有再发样本模型请求。不能把API连通、fixture或浏览器控制器通过当成自主研究能力达标。
