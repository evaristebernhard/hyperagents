# Rust 内核与轻量沙箱验收记录

日期：2026-11-03。Ubuntu/WSL2，普通用户，user systemd、cgroup v2；无 KVM，无可用 Docker socket。实际工具版本见 [versions.json](versions.json)。自动验收使用独立临时数据库、文件目录与浏览器身份。最后恢复原数据目录上的开发入口并应用增量迁移，未重置账户或切换历史任务内核；具体状态见下文。

## 当前交付

实现了固定 Infinity `1abc6fcff1f186124f924b56aa92c3a3684c90c5` 的 Rust step 内核、PostgreSQL 原子提交/租约/inbox/outbox、TS 流式模型桥接与工具执行，以及 bubblewrap 浏览器和直接 runsc `systrap` 计算。默认 `RUST_NEW_TASKS=false`、`BROWSER_ENABLED=false`。旧任务固定原内核；关闭新任务开关后，已有 Rust 任务仍由 Rust 恢复。

运行包使用锁定的 OCI 摘要、Debian 包和 Python wheel 校验和，无需 Docker 构建。每个已安装包另有完整文件 manifest，启动时验证。当前计算包 manifest SHA-256 为 `4a88ed15ca2f7d87b5a3d638f1e824adccede73b3bd03bd2f855407109678643`，浏览器包为 `d6c7f1c55d9043e66e10a1862d2cd63b8b12bb39777cc943e601caa49dcd5026`。安装和回滚步骤见 [运行包](../../backend/sandbox/README.md)、[内核](../../backend/kernel/README.md)。

## 自动验收结果

| 范围 | 结果与边界 |
| --- | --- |
| v1 后端 | 97/97；包括 15 项真实 PostgreSQL/Rust 进程测试、16 项浏览器业务测试及 Runner 独占锁/OCI 配置测试 |
| 旧后端 | 414/414；保留文件版本、资源、权限、模型与任务回归 |
| Infinity 核心 | 108/108，1 项文档示例忽略；集成补丁使去重存储错误向外传播 |
| 静态检查 | 后端/UI TypeScript、UI v1 build、Rust fmt/check/clippy `-D warnings` 通过 |
| Browser UI | 专项浏览器面板、接管/交还、产物与身份管理契约通过 |
| 旧 UI fixture | 90 项最终全部验证；首轮 87 通过、2 项页面加载超时、1 项焦点断言失败，单 worker、90 秒限时分别重试后 3/3 通过；保留该稳定性限制 |
| 旧 UI 业务流程 | 38 项最终全部验证；首轮 36 通过，2 项在共享宿主负载下超时，使用 90 秒限时单独重试通过 |
| 真实 runsc | Python/Node、科学计算、中文 PDF/PNG、断网、无密钥/socket、回执幂等、链接导出拒绝、内存/磁盘/PID 限制、取消、120 秒超时及进程组清理均通过；见 [compute.json](compute.json) |
| 真实 Chromium | 自身 namespace/seccomp sandbox、私网/元数据出口拒绝、file URL 策略、实际公网 HTTPS、独立只读 VNC 拒绝键盘输入、可写 VNC 输入、下载导出、双身份隔离、正常重启保留 Cookie/localStorage/IndexedDB 和进程组清理均通过；见 [browser.json](browser.json) |
| 单机完整流程 | Rust 流式模型 → 持久 outbox → 登录页 → 接管/交还 → 新页面观察 → 下载 CSV → runsc 读取该文件 → 校验并交付版本化 `6 * 7 = 42` 产物；见 [flow.json](flow.json) |

完整流程使用受控模型和测试登录页，实际运行 Rust、TS 工具层、PostgreSQL、浏览器服务、Chromium/VNC、gVisor 与产物存储。自动接管动作通过浏览器测试适配执行；真实 VNC 键盘输入与只读隔离在独立沙箱测试中验证。它不代表真实用户已完成某个第三方网站的人工登录，也不代表真实供应商模型的任务质量已经验收。

Rust 故障测试实际终止 kernel，覆盖模型调用期间、提交前、提交后恢复；另覆盖去重写失败、重复输入、父子创建提交边界、取消后的迟到结果、持久延迟事件、上下文压缩、四个全局/两个工作区片段限流与数据库心跳争用。浏览器业务测试覆盖双人接管竞争、旧票据、重复交还、退出/撤权、动作中接管及 uncertain 结果不重放。人工等待超过 20 分钟的测试通过推进持久时间状态验证预算语义，未让真人在第三方网站连续等待 20 分钟。

这些测试覆盖具体故障窗口；尚未逐一对所有真实外部网站副作用和回传窗口执行进程终止。生产启用前须完成下述人工与站点验收。

## 资源实测

共享 slice 上限为 5 GiB、两个 CPU 核、禁止 swap；浏览器每身份 1.5 GiB、最多两个，计算每操作 2 GiB、同时一个。以下为 cgroup 瞬时总内存，包含文件缓存；tasks 是 cgroup 线程/任务计数，不等于进程数。CPU 是该 slice 自建立以来的累计 CPU 秒，不能当成单项耗时或稳定利用率。

| 场景 | 内存 MiB | cgroup tasks | 累计 CPU 秒 |
| --- | ---: | ---: | ---: |
| 空闲 | 38.4 | 0 | 306.858 |
| 单浏览器 | 274.8 | 213 | 318.411 |
| 双浏览器 | 527.6 | 426 | 327.490 |
| 浏览器全部关闭 | 43.9 | 0 | 337.054 |
| 计算超时测试等待中（另一轮采样） | 55.8 | 39 | 306.833 |

浏览器启动至 CDP 可用：326 / 3329 / 3348 ms，冷探针（含全文件校验与隔离检查）40960 ms。采样不是长期基准；关闭后页缓存仍可被内核保留，不代表残余进程。最后确认无运行中的浏览器/计算 service，仅空 sandbox slice 留存。计算采样见 [compute-resource.json](compute-resource.json)。

10,000 个持久等待线程（覆盖完整两秒调度扫描周期）：模型活动槽为零，测试数据库连接实测 8，Rust RSS 相对空载增加 48 KiB，低于 64 MiB 目标。内核连接池上限为 8，另有一个共享 LISTEN 连接，连接数量不随等待线程数量增加。并发唤醒达到四个模型片段，单工作区最多两个；见 [kernel-load.json](kernel-load.json)。此数值是本次测试样本，不是任意上下文规模的 RSS 保证。

## 重现

前置条件与隔离失败行为见 [沙箱说明](../../backend/sandbox/README.md)。`SANDBOX_RUNSC` 应指向包含相邻 `gvisor-bin` 的完整官方安装。以下命令从仓库根目录运行，测试使用临时状态；不得把验收数据库配置为生产数据库。

```sh
python3 backend/sandbox/build-runtime.py --kind all
export COMPUTE_RUNTIME_DIR="$HOME/.local/share/hyperagents/runtimes/compute"
export BROWSER_RUNTIME_DIR="$HOME/.local/share/hyperagents/runtimes/browser"
export SANDBOX_BACKEND=runsc
export BROWSER_RUNTIME_KIND=lightweight
npm --prefix backend test
npm --prefix backend run test:sandbox
npm --prefix backend run test:lightweight-browser
npm --prefix backend run test:single-machine
npm run test:backend
npm run test:browser-ui
npm run typecheck
npm run build:v1
cargo clippy --locked --manifest-path backend/kernel/Cargo.toml -- -D warnings
```

UI fixture 与旧业务流程分别使用临时 Vite 端口 5185、5174，避免使用现有 5173。原 `npm run test:fixtures` 配置会复用 5173，因此本次使用临时 Playwright 配置改端口运行；其覆盖项为 `use.baseURL=http://127.0.0.1:5185`，`webServer.command=VITE_STORAGE_MODE=fixture node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5185 --strictPort`，并设置 `webServer.url` 为同一地址、`reuseExistingServer=false`。回归结果汇总见 [regressions.json](regressions.json)。

## 启用前剩余验收

- 在拟使用的真实网站，由用户在 Browser UI 手动登录；跨任务、正常应用重启后检查持久会话，登录过期转回人工。验证搜索、填写、下载及网站自身限制。测试页面内未提交表单不作为恢复承诺。
- 在真实 UI 上由两人操作接管、断线、重复交还、退出与撤权；安排一次超过 20 分钟的真实等待，同时运行其他任务。自动化已覆盖相应状态语义，但不能代替实际交互体验。
- 使用配置的真实模型执行代表性任务并检查工具选择和交付质量；本次内核/完整流程验收使用受控模型，没有消耗生产供应商额度。
- 针对拟使用网站的非幂等动作，演练动作分发/回传时强制退出，确认不能确定的副作用停在 uncertain，不自动重放。检查重启后没有旧控制者或残留进程。

完成这些验收后才设置 `RUST_NEW_TASKS=true`、`BROWSER_ENABLED=true`。回退时关闭新分配，保留 Rust kernel 服务直到原 Rust 任务完成；保留数据库、对象文件、profile 和 Runner 回执。没有引入付费浏览器、搜索、代理或验证码服务。

## 当前本机入口

最终检查时 5173/55432 无监听，原 `hyperagents-web.service` 已于本次实现开始前停止。使用现有 `scripts/dev-v1.mjs` 和 `backend/.data-v1/interactive` 恢复运行，应用增量 `005_kernel.sql`。原账户登录、capabilities 与 `http://localhost:5173` 均返回 200；数据库保留 4 个用户、34 个文件与 15 个历史任务，历史任务全部为 TypeScript、无活动任务。新任务 Rust 分配与浏览器仍关闭，现有 Runner 健康检查可用。

迁移后正常停库，已将 PostgreSQL、文件及原登录配置保存到私有 `backend/.data-v1/backups/rust-kernel-installed-20261103T133320Z/`，然后恢复服务。该副本是迁移后备份，不作为迁移前快照。备份含私密数据，不应提交或公开。

当前由临时 user systemd unit `hyperagents-v1-dev.service` 管理开发启动器，可用 `systemctl --user stop hyperagents-v1-dev.service` 正常停止，再运行 `npm run dev:v1`。临时 unit 不提供重启机器后的自动启用。启动器同时排除 Infinity 参考目录及 Rust target/vendor 的文件监听，避免构建产物消耗 Vite watcher。

## 后续修复：实际应用仍连接旧 Runner

发现旧 8082 Runner 的 `/health` 返回可用，但会将携带 `protocol/threadId/eventId/leaseEpoch` 的新版请求以 HTTP 400 拒绝。同一个 `print(1+2)` 以旧请求格式可执行。因此上文健康检查可用并不能证明当前应用协议兼容，这是初次接入遗漏。

现已移除旧进程与旧 `runner.env` 启动配置。开发启动器自动发现已安装的 compute 包，并管理 8084 上的新版直接 runsc Runner；显式配置的外部地址仍须通过版本检查。两个 Runner 实现的健康响应均声明 `protocol: 1`，客户端拒绝缺失或不匹配的版本。60 项相关后端测试通过，包含旧版健康响应误报可用的回归。

在当前应用上，Python 和 Node 最小示例均真实输出 `3`；随后在用户原对话重跑其 Python 附件和独立 Node 循环，两者均退出码 0、输出 `500500`，最终任务成功并保存 `sum_verified.txt`。检查了持久化 operation stdout、原对话渲染与登录后的文件下载。真实模型过程中曾收到工具阶段限制/参数错误并自行修正，未再次出现 Runner 协议错误。此次结果证明这条具体真实任务链路恢复，不代表所有站点或所有模型任务质量已验收。
