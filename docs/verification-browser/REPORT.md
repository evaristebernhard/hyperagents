# 持久浏览器实施验证记录

日期：2026-11-03。实现对象为现有 TypeScript v1 后端和原 thread/Integrations UI；已有账户、任务、文件版本与 localhost:5173 开发入口保留。没有连接真实用户网站、复制电脑凭据或启用付费服务。

## 已实现

- 迁移 004：profile/grants、独占 session、控制代次、outbox、持久输入事件、单次票据、累计执行预算。
- 执行器异步浏览器协议；数据库 checkpoint → dispatch → result → resume；等待释放 lease，去重、取消、旧代次与 uncertain 保护。
- 独立 Chromium/Playwright/Xvfb/x11vnc 服务；非 root 容器、每身份 bubblewrap 文件系统/进程隔离、受控公网出口、固定数量和空闲关闭、持久 profile。
- `/api/v1/browser` API、授权、接管/交还、服务端只读视图、单次 WebSocket 票据；基础页面操作、授权上传、产物下载与截图。
- thread 的 Browser / Artifacts、放大、控制者/连接状态与人工提示；Integrations 身份管理与团队授权；任务 profile 选择。
- 容器配置、健康探测、加密备份脚本、受控测试站、真实容器验收脚本和运维文档。

## 本机已验证

| 检查                      | 结果       | 范围                                                                                                                                 |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| backend `npm test`        | 80/80 通过 | 16 项新增浏览器协议/出口测试 + 64 项原后端测试；临时 PostgreSQL，不改生产数据                                                        |
| `npm run build:v1`        | 通过       | TS 校验、Vite v1 生产产物、noVNC 单独动态 chunk；保留既有主包体积提示                                                                |
| `npm run test:v1-adapter` | 通过       | 原 UI 幂等请求、105 事件分页、断线续接、刷新去重、人工补充、取消、会话退出                                                           |
| 浏览器 UI contract        | 通过       | fixture API + 真实 WebSocket 模拟 RFB 握手/noVNC 连接；接管、断线不交还、刷新保持人工控制、交还说明、放大、Artifacts 与 Integrations |
| 私有数据/开发入口测试     | 4/4 通过   | profile 路径不能由 Vite 提供；已有开发入口隔离                                                                                       |
| Docker Compose 配置       | 通过       | 两文件合并语法/依赖检查，无需 Docker daemon                                                                                          |

协议测试包含真实 Engine 先落库、异步 yield、收到结果后继续并完成，重复结果仅写一次；两次并发接管仅一次成功；旧/重复票据、应用会话过期；团队身份明确授权与成员撤销；取消之后迟到结果；服务重启的 uncertain；等待超过原墙钟上限仍保留执行预算；私网、metadata、mapped IPv6 和混合 DNS 拒绝；接管边界的旧意图作废、模型预留预算归账，以及未确认计算保持 uncertain。

验证过程中发现并修复了 noVNC 1.7 的 package export/ES2022 构建要求，以及累计时间计费对原心跳故障注入路径的影响。修复后原断库恢复测试通过。

截图 [thread.png](thread.png) 使用 fixture 页面和连接状态，仅证明 UI 布局，不是实际网站、VNC 画面或登录成功证据。

## 当前阻塞与未作出的承诺

运行 `docker info --format '{{.ServerVersion}}'` 返回：`permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`。这只表示当前账号不能使用已有 daemon，不表示本机无法运行容器或虚拟机。追加探测已确认无特权 user namespace 可创建，bubblewrap 的 mount/PID/network namespace 可运行；subuid/subgid 已分配，但缺少 rootless 多 UID 映射 helper。当前 WSL2 未暴露 `/dev/kvm`。

仍未构建或运行真实浏览器镜像，未验证完整容器策略下的 Chromium profile 登录持久性、真实 VNC 输入/只读防篡改、容器网络实际隔离、真实网站验证码/原生弹窗与加密备份恢复。`acceptance.mjs` 和 fixture 已提供，但未在此环境执行。新的 [Rust + TS 架构说明](../architecture-rust-kernel.md) 区分了基础环境可行性与浏览器上线验收。

Browser 默认关闭。没有尝试提升 Docker socket 权限或回退宿主机浏览器。UI contract 的浏览器进程只用于前端测试，不承载用户 Browser 身份或登录。

## 架构调整后的追加探测

- 用户目录中的 QEMU 8.2.2 使用 TCG、1 vCPU、512 MiB，成功启动 Alpine `6.12.114-0-virt` 内核与 initramfs。guest 中 `id` 为 root、PID 1 为 `sh`，正常 poweroff 后进程退出。未使用 sudo、Docker socket、KVM、网卡或宿主目录共享。
- 这验证了当前账号可运行独立 Linux guest；仍需安装持久 guest 系统与浏览器容器，再验证网络、性能和全部人工往返。没有将 initramfs shell 当作已部署浏览器服务。
- 本地 Infinity `1abc6fc` 的 `system::builder::tests::` 3/3 通过，验证 step 模式基本行为；`driver_stays_alive_waiting_for_tool_result` 1/1 通过，确认本地常驻模式的等待行为。Rust 内核尚未替换当前 TS 执行器。

部署步骤和逐项验收清单在 [BROWSER.md](../../backend/deploy/BROWSER.md)。实际网站可能要求重新登录、拒绝服务器自动化、依赖 WebAuthn/硬件设备，或无法恢复页面内存；这些限制必须在手工验收记录中逐站注明。
