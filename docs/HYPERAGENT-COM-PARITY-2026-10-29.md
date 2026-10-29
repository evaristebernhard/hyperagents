# Hyperagent.com 调用模式对照报告 — 2026-10-29

> 视角：本报告由官方站（hyperagent.com）运行环境内的 agent 直接观察并撰写，
> 结合官方公开文档；对照对象是本仓库的本地实现（server/llm.mjs、server/tools.mjs、
> server/agent-runs.mjs、docs/agent-runtime.md）。与 OBSERVED-PARITY-2026-10-29.md
> （UI 层面对照）互补，本报告聚焦 **agent 执行与调用模式**。

## 1. 官方站一次调用的生命周期

1. 用户消息进入线程；运行时按需检索知识库（技能摘要、记忆、上下文文件）注入本轮。
2. 模型运行在**独立于 HTTP 请求生命周期**的环境中：服务端持久化 thread/run 状态，
   浏览器刷新、断线、关页都不中止运行；客户端重连后按游标续看事件。
3. 每轮模型输出 = 文本增量 + 0..N 个工具调用；工具结果回填后进入下一轮，
   直到出现无工具调用的最终答复。
4. 多个工具调用可**并行**下发；长任务可后台运行（本线程实测后台运行可达小时级）。
5. 触发通道除界面输入外，还有 Slack @提及、Telegram、Email、Webhook、定时任务、
   live 轮询监控（"brief once, ship forever"）。
6. 执行过程透明：每次工具调用（含浏览器操作、shell 命令）逐条展示，产物构建过程可见。

## 2. 本地实现现状（源码证实，非推测）

| 维度 | 本地实现 | 证据 |
| --- | --- | --- |
| 运行生命周期 | 已解耦：POST /api/runs 持久化 run，事件游标重放，刷新/关页不中止；重启标记 interrupted 但不自动续跑 | docs/agent-runtime.md、server/agent-runs.mjs |
| 模型 | 仅 DeepSeek 两档（deepseek-flash / deepseek-v4-pro），SSE 流式 | llm.mjs `MODELS`、`ENDPOINT` |
| 遗留路径限制 | /api/llm/chat：120s 超时、8 轮、每次运行 10-12 个工具调用、顺序执行 | llm.mjs `LIMITS`、`maxRounds ?? 8`、`maxTools ?? 12` |
| 托管运行限制 | 2 个并发 run、队列 20、20 分钟/run、24 轮模型、64 次工具调用 | docs/agent-runtime.md |
| 工具面 | workspace_search / resource_read / create_artifact / update_artifact / create_table + 只读公开 API + 需审批的集成写 + shell_execute（逐条审批，1..300s，64KiB 输出上限） | tools.mjs `DEFINITIONS`、agent-runtime.md |
| 工具执行 | 严格顺序（for 循环 await），无并行 | llm.mjs 工具循环 |
| 工具结果上限 | 单结果 24000 字符，会话 240000 字符即中断 | llm.mjs `boundedToolResult` |
| 技能 | 纯文档注入（提示词），不可执行；无凭据注入运行脚本 | llm.mjs buildConversation |
| 记忆 | 静态注入文本，执行中不自动沉淀 | llm.mjs buildConversation |
| 触发通道 | 仅手动界面输入；无定时/webhook/IM | docs/agent-runtime.md "Not implemented" |
| 产物 | SQLite + 客户端提交（staged patches）；沙箱 iframe 渲染；无托管发布 | tools.mjs `prepare` |

## 3. 主要差距（按对 agent 能力的影响排序）

1. **技能不可执行**：官方技能携带可运行脚本并由平台注入凭据；本地只是提示词文本。
   这是"agent 能做事"与"agent 只能说"的分界线。
2. **工具顺序执行 + 轮数/调用数上限小**：官方并行工具、后台小时级运行；
   本地 24 轮/64 次已是托管上限，遗留路径仅 8 轮/12 次。
3. **无外部触发通道**：定时、webhook、IM 接入缺失，无法形成持续运行的 agent。
4. **工具面窄**：无浏览器自动化、无媒体生成、无地图；公开 API 只读且有限。
5. **单模型供应商**：DeepSeek-only；官方多模型可切换。
6. **无跨 run 学习**：官方执行后自动沉淀记忆/技能建议；本地无。

## 4. 补齐建议（结合现有代码结构，工作量从小到大）

1. **提高遗留路径一致性**：把 /api/llm/chat 的 maxRounds/maxTools 对齐托管运行的 24/64，
   或引导前端全部走 /api/runs（推荐，改动小）。
2. **工具并行执行**：llm.mjs 工具循环改为 `Promise.all` 分批执行同一轮的 toolCalls
   （保持每类工具内部的锁语义；注意集成审批与 shell 审批仍需串行确认）。
3. **可执行技能**：给 skills 增加 scripts 字段与受审批的 `run_skill_script` 工具，
   复用 shell_execute 的审批/沙箱边界（cwd 限项目根、1..300s、输出截断）。
4. **定时触发**：最小实现为 cron 检查器读 schedules 表 → 创建 run（复用 /api/runs
   幂等语义），无需新的执行器。
5. **浏览器自动化**：接入 Playwright（仓库已有 @playwright/test 依赖）作为受审批工具，
   先只读（导航/截图/提取），再做交互。
6. **记忆沉淀**：run 结束时让模型输出"记忆建议"入库待审核，而不是直接写。

## 5. 实测记录（两站同题对照）

- [ ] 网页创建任务：官方站 vs 本地站，工具调用轨迹、产物、断线恢复对比
      （本地站今日一度 524，待恢复后填写）

## 6. 证据与边界

- 官方侧信息来自：本 agent 自身的运行环境观察 + 官方公开文档，未接触官方私有源码。
- 本地侧信息来自对仓库源码的直接阅读（2026-10-29，main @ 6ecce60）。
- 工作树有未提交修改（package-lock.json、scripts/dev.mjs），本报告未触碰。
