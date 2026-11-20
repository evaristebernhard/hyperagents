# 结构化计划

用途：多步骤任务在对话里说明下一步、当前工作、调整原因及完成数量。简单问答可没有计划。计划不决定成功；根任务仍须通过 `finish` 与真实文件验收。

`update_plan` 参数：

```json
{
  "expectedVersion": 0,
  "reason": "先整理资料再交付",
  "steps": [
    { "id": "read", "title": "读取资料", "status": "in_progress" },
    { "id": "write", "title": "保存报告", "status": "pending" }
  ]
}
```

稳定步骤 ID 长度 1–100；标题最多 500 字符；每个计划 1–100 步。状态为 `pending`、`in_progress`、`completed`、`blocked`、`skipped`。修改时携带当前 `expectedVersion` 并说明 `reason`，版本从 1 开始递增。步骤 ID 不能重复；旧步骤不能直接删除，应标为 `skipped`，以保留修改语义。

工具 operation ID 来自持久派发记录。同一 operation、同一内容重放返回原版本且不重复发事件；同一 operation 内容变化报 `PLAN_OPERATION_CONFLICT`；过期版本报 `PLAN_VERSION_CONFLICT`。保存、事件和版本检查处于同一事务，并要求有效任务租约。当前模型已发出的计划操作可以在收到暂停请求后完成保存；暂停后不派发下一项操作。

`overview.plan` 是最新版本，`completedSteps/totalSteps` 为实际步骤计数。界面显示修改原因，支持折叠，刷新从数据库恢复。模型上下文和压缩检查点保留当前计划。子任务维护自己的计划，根任务概览给出子任务摘要。

限制：不从耗时估计百分比，不把未标记的步骤自动改成完成。任务完成后可能仍有模型未更新的计划步骤，任务最终结果以验收和执行状态为准。现阶段无人工直接编辑计划的 API。

验收：两种运行时执行同一计划任务；覆盖 CAS 竞争、稳定 ID、重复 operation、内容冲突、重启与刷新。状态明细见总验收记录。
