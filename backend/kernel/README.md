# Rust 持久执行内核

内核只运行 Infinity 执行片段，不为等待任务保留 driver、定时器或数据库连接。固定基线见 [vendor/UPSTREAM.md](vendor/UPSTREAM.md)，Apache-2.0 许可证随四个最小依赖 crate 保留。

```sh
cargo build --locked --manifest-path kernel/Cargo.toml
npm run build
npm test
```

`DATABASE_URL`、`KERNEL_SOCKET`、`KERNEL_BRIDGE_SOCKET` 由进程环境提供。两个 socket 应在同一个私有 0700 目录，socket 模式为 0600。Worker 提供版本 1 TS bridge，内核提供健康/指标与预算接口。模型密钥只在 TS 层，Rust 通过 Infinity 流式协议获取内容和用量。模型每次实际尝试拥有稳定 UUID，预留/结算幂等，交付审核也通过 Rust 的预算接口记账。取消或租约过期后的模型返回不能提交任何工具意图。

迁移 `005_kernel.sql` 是增量迁移，已有任务固定为 TypeScript。新任务分配由 `RUST_NEW_TASKS=false` 控制；API 不接受客户端选择内核。子任务继承运行版本；调度任务沿用同一开关。关闭开关只阻止新分配。已有 Rust 任务仍由 Rust 恢复，禁止交给 TS 重放。

每片段最多 32 条持久输入，进程内最多四项模型片段，每工作区最多两项；PostgreSQL 租约和单调 lease_epoch 在多个进程间强制互斥。跨工作区按最近运行时间选择。单个 LISTEN 连接用于唤醒，固定两秒扫描补偿丢通知；休眠任务不加载到内存。所有应用工具经过已提交 operations outbox，由 TS 工具 dispatcher 执行；计算和浏览器另有独立限流。等待队列和工具执行不占 Rust 模型槽。

PgStores 为每片段建立独立 working set。Infinity 的历史、去重 ID、metadata、订阅、压缩、原生子线程及 InputSender 消息均先暂存；成功后以一个短 PostgreSQL 事务提交 snapshots、消费输入、outbox 和任务状态。所有被修改的 snapshot 使用 revision CAS，主任务使用 lease epoch fencing。模型网络调用不持有事务。原生 spawn 的 child task 和唤醒消息在父片段提交后才可见。定时等待使用数据库 available_at，没有逐任务 tokio timer。上下文压缩使用 Infinity compaction 子线程；内部压缩线程单独标记，不占两项用户委派配额。

API、SSE、Browser/Artifacts UI、文件授权、内容寻址、产物版本与 finish 结构校验/模型审核继续使用现有实现。根任务树共享 20 分钟活动时间、32 次模型尝试、64 次工具调用和 200K token。外部工具已有自己的超时与恢复策略。浏览器的异步结果继续校验 operation ID 和 control epoch；任务取消后不会重启。未知计算/网站副作用沿用 uncertain，禁止自动重放。

`npm run dev:v1` 保持 PostgreSQL、文件和 localhost:5173。设置轻量运行包目录后会管理 Runner；启用浏览器时管理 browser service；设置 RUST_NEW_TASKS=true、KERNEL_ENABLED=true 或检测到尚未结束的 Rust 任务时构建并启动 kernel。已有账户和文件目录保持不变。独立部署时先迁移，再启动 kernel、worker/bridge、API、按需沙箱服务。

`GET /v1/health` 返回 backlog、active、sleeping、uncertain 和提交/重复事件/租约丢失等计数；应用 capabilities 显示真实内核与沙箱健康状态。`KERNEL_FAULT=before_commit|after_commit` 仅用于独立验收数据库中的进程终止测试。
