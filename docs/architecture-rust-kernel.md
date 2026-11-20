# Rust Agent 核心与 TypeScript 业务层

2026-11-03：根据用户后续意见，替代原方案中“不直接引入 Rust 运行时”的限制。以下保留最初架构审阅与环境探索记录；其中 rootless Docker/QEMU 建议已由后续 bubblewrap + 直接 runsc 方案取代。本阶段没有引入 QEMU 依赖。

现已实现 Rust/PostgreSQL step 内核和无 Docker 浏览器/计算路径，受控单机完整流程及真实沙箱测试通过。新任务入口仍默认关闭，尚未切换现有任务。当前实现、实测结果与人工验收边界见 [验收记录](verification-rust-sandbox/REPORT.md)、[内核说明](../backend/kernel/README.md) 与 [沙箱说明](../backend/sandbox/README.md)。

## 边界

- **Rust Agent kernel**：优先复用本仓库 Infinity 的 `infinity-agent-core`，承载模型执行片段、线程树、父子消息、事件处理、中断、订阅和上下文压缩。补充持久调度、预算、背压及取消策略。
- **TypeScript 业务层**：保留 HTTP API、账户、工作区权限、资源与文件版本、工具适配、浏览器控制权、SSE 和 React UI。现有模型配置与用量记账通过适配层接入，避免双重记账。
- **PostgreSQL**：保留现有业务数据；新增 Rust store 适配与线程映射。输入、执行租约、操作意图、outbox 和结果均有持久记录。
- **隔离浏览器服务**：Chromium/Playwright/Xvfb/VNC 保持独立进程生命周期与持久 profile。容器或虚拟机提供运行边界，不与 Agent 执行槽绑定。

Rust 与 TS 使用独立进程及版本化内部协议。协议携带 task/thread、event/operation ID、租约 fencing token 与 browser control epoch；不能仅靠消息到达顺序判断权限。API 不允许客户端指定内部回调地址。

## Infinity 的复用范围

审阅本地 Infinity `1abc6fc`，以源码为准：

- [`AgentSystem::step`](../infinity/crates/infinity-agent-core/src/system/builder.rs) 在一个输入批次内按线程分组、跨线程并发运行，每次加载状态并在片段结束后释放。跨进程的同线程互斥仍由宿主调度器负责。
- [`Thread::step_no_defer`](../infinity/crates/infinity-agent-core/src/system/thread.rs) 在异步工具分发前调用 `history.sync()`。但这个顺序本身不等同于 PostgreSQL 中 checkpoint 与 outbox 的原子事务；需专门实现提交与恢复适配。
- [`HistoryManager::sync`](../infinity/crates/infinity-agent-core/src/event_processor.rs) 分别写 history 与 processed message IDs；当前源码还忽略后者的写入错误。集成时必须补齐事务与错误传播，并测试该故障窗口，不能仅因复用 Rust 就宣称具备完整崩溃恢复保证。
- [`ConversationStore`、`StateStore`、`InputSender`](../infinity/crates/infinity-agent-core/src/traits.rs) 是主要扩展边界；还需要持久 `DeferQueue` 与模型、工具适配。
- [`local/driver.rs`](../infinity/crates/infinity-agent-core/src/system/local/driver.rs) 在 `awaiting_tool_result()` 时返回 `AwaitInput`，保留 driver；订阅空闲才可退出。不能把本地常驻模式描述成所有工具等待都不保留内存。
- [`local/router.rs`](../infinity/crates/infinity-agent-core/src/system/local/router.rs) 使用 `FuturesUnordered` 和 `LocalSet`。这是异步并发，不意味着每个 Agent 独占 OS 线程，也不自动提供跨进程分布式调度。

因此首选 **step 模式 + PostgreSQL 持久调度**。不照搬 Lambda/AWS 基础设施，也不把本地内存 channel 当作可靠队列。

## 并发与故障语义

1. 同线程串行处理输入；独立线程与子 Agent 可并发。按工作区、模型额度、计算资源和浏览器身份分别限制并发。
2. 只在执行片段期间持有执行租约。浏览器动作、人工接管、外部事件等待均落库并释放执行槽；唤醒后重新加载。
3. 模型决策、checkpoint 和待分发意图在一个数据库事务中提交；外部动作只从已提交 outbox 分发。事务不能横跨人工等待，也应避免横跨模型网络调用。
4. 事件至少一次投递，稳定 ID 去重；租约代次阻止旧 worker 提交。外部副作用不宣称 exactly-once，结果不确定的提交进入 `uncertain`。
5. 父子线程关系、延迟事件、取消和预算均持久化。限制线程数量、队列长度及同时运行的模型请求，不能以无限 channel 代替背压。
6. 浏览器同 profile 独占、同 session 操作有序；Agent 跨线程并发不赋予同一页面多控制者。

## 迁移顺序

1. 单独验证 Infinity 核心的多线程片段、工具分发提交边界、等待后重建与重复事件行为。
2. 实现 PostgreSQL stores/inbox/outbox 与 TS 工具、模型和事件适配；用受控模型与假工具做进程终止和重启测试。
3. 为新任务持久记录 `runtime_kind` 与 `runtime_version`，按开关路由到 Rust。已有活跃 TS 任务留在原执行器完成，禁止两个内核同时推进同一任务。
4. 接入浏览器人工往返和真实计算回归，再逐步放量。关闭 Rust 新任务入口不会把执行中的 Rust 任务盲目交给 TS 重放。

## Ubuntu 隔离部署判断

不能从 `/var/run/docker.sock` 权限不足推断 Ubuntu 无法运行隔离环境。本机实际为 WSL2：无特权 user namespace 可创建，`bubblewrap` 的 mount/PID/network namespace 探测成功；`ubuntu` 在 `/etc/subuid`、`/etc/subgid` 各有 65,536 个 ID。当前缺少 rootless Docker 所需的 `newuidmap/newgidmap` 和 rootless 启动组件；已有 Docker daemon 的 socket 不向当前账号开放。

- 优先使用配置齐备的 rootless Docker/Podman。多 UID 映射的 helper 需要正确的宿主安装与权限，不能把普通用户目录解压当成已满足要求。参照 [Docker rootless 前置条件](https://docs.docker.com/engine/security/rootless/)。
- 需要完整 guest OS 时可使用 QEMU。当前没有 `/dev/kvm`，因此硬件加速尚不可用；[TCG 软件模拟](https://www.qemu.org/docs/master/system/introduction.html) 不依赖 KVM，但吞吐与浏览器交互延迟需单独验证。
- 无论采用哪种方式，都要实测资源限制、受控出口、profile 隔离与 VNC 权限。namespace 探测或 guest 启动成功不能替代浏览器服务验收。

本机后续实测：将 Ubuntu 仓库的 QEMU 8.2.2 软件包及依赖解压到 `~/.local/share/hyperagents-vm`，通过 TCG 成功启动 Alpine `6.12.114-0-virt` 内核与 initramfs。宿主进程为普通用户，guest 中 `id` 返回 root，PID 1 为 shell，执行 poweroff 后 QEMU 正常退出。测试使用 1 vCPU、512 MiB、无网卡、无宿主目录共享；只证明独立内核可运行，尚不是装好 Docker/Chromium 的持久 VM。

已运行 Infinity `system::builder::tests::`：3/3 通过，覆盖单片段、多线程批次及 OAuth 事件混合输入。另运行 `driver_stays_alive_waiting_for_tool_result`：1/1 通过，确认本地模式等待普通工具结果时保留 driver。该结果是上游核心验证，不是本应用 Rust/PostgreSQL 适配已完成。

浏览器现有验收记录继续保留在 [REPORT.md](verification-browser/REPORT.md)，不能将架构调整或基础环境探测记成 Rust 生产迁移完成。
