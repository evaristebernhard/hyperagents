# Agent 能力总览

`backend/` 的任务闭环：对话中查看计划、暂停整个任务树、按诊断恢复，并下载已保存的具体文件版本。现有 `server/`、旧数据和默认启动入口保持原样。本轮不增加定时任务或第三方执行器。

| 能力                      | 新后端 TS | 新后端 Rust                                 | 旧 server/ | 入口                                           |
| ------------------------- | --------- | ------------------------------------------- | ---------- | ---------------------------------------------- |
| [结构化计划](plan.md)     | 支持      | 共用同一工具服务                            | 未增加     | `update_plan`；概览与 plan 事件                |
| [暂停与继续](control.md)  | 支持      | 内核领取、模型、原生工具和 TS outbox 均受控 | 未增加     | `POST tasks/:id/pause`、`resume`               |
| [失败诊断](diagnosis.md)  | 支持      | 同一概览；内核保存安全错误码                | 未增加     | 概览 `diagnosis`、`availableActions`、`budget` |
| [交付与验收](delivery.md) | 支持      | 共用真实文件校验、模型审核                  | 未增加     | 概览 `deliverables`、`validation`              |

完整接口以 `/api/v1` 为前缀。`GET tasks/:id/overview` 一次返回任务、根任务控制状态及修订号、计划、已完成步骤数、预算、当前操作、诊断、可用动作、全部已保存版本、验收历史、子任务摘要和事件游标。读取使用同一个 PostgreSQL REPEATABLE READ 快照。`GET tasks/:id` 保持兼容。SDK 新增 `Client.overview/pause/resume`，响应经共享 Zod 契约校验；运行中的 `/api/v1/openapi.json` 由同一契约生成。

对话 UI 使用概览快照决定按钮，活动列表继续读取游标事件，下载链接绑定文件 ID。重新连接、刷新及第二个标签页都从服务端恢复。控制写请求沿用会话认证、工作区角色、Origin 与 CSRF 校验；浏览者没有写权限。

## 模块与依赖

- `task-control.ts`：根任务控制、派发准入、安全边界、暂停收敛。两种运行时和 browser service 共用数据库控制函数；短事务统一锁顺序，网络和沙箱工作不持有控制锁。
- `task-plan.ts`：计划读取、版本 CAS、operation 去重和持久事件。
- `diagnosis.ts`、`task-overview.ts`：真实记录聚合和恢复权限，不生成虚构进度或失败原因。
- `delivery.ts`：读取实际版本、结构校验、持久验收记录与已完成验收重用。Engine 协调模型审核、修复和最终提交。
- `tool-handlers/`：research、knowledge、files、compute、coordination、browser 六个领域。注册表经类型检查覆盖全部契约工具；工具共用参数、权限、租约校验，重放策略随共享工具定义传给 Rust。
- `kernel/src/control.rs`：原生 Infinity 工具暂停准入。已完成模型响应写入私有缓存，暂停导致片段暂缓时按请求匹配重用；片段提交后清理，不公开模型私有推理。

## 升级与限制

增量迁移 `010_task_lifecycle.sql` 只增加控制列、计划历史、验收历史、私有模型响应表和数据库函数。旧任务默认 `normal`，计划为空；不回填历史验收，也不迁移旧后端数据。

实际升级须先停止接受新任务并让正在执行的操作完成，协调停止 API、Worker、kernel 和 browser service，备份数据库与对象目录，应用迁移，再一起启动匹配版本的进程。不要混跑旧 Worker/内核/浏览器服务：旧进程不知道新的暂停准入规则。不能通过回退程序并忽略控制字段来恢复仍暂停的任务。本轮只在隔离数据库验收，没有升级现有数据卷或切换公开入口。

测试与真实模型样本见 [验收记录](../../../docs/verification-task-lifecycle/REPORT.md)。自动测试不等于所有第三方网站上的人工接管或副作用故障窗口都已验收。
