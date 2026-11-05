# 持久浏览器部署与验收

本功能默认关闭 (`BROWSER_ENABLED=false`)。代码已接入 TypeScript/PostgreSQL 执行器与原 thread 界面；真实 Chromium、VNC、持久登录和容器隔离仍须验收。当前开发账号无法访问已有 `/var/run/docker.sock`，这不排除在本机部署 rootless 容器或用户态虚拟机。后续核心方向已调整为 [Rust Infinity 核心 + TypeScript 业务层](../../docs/architecture-rust-kernel.md)，当前代码尚未切换执行内核。

本机已通过无特权 user namespace 与 bubblewrap 的文件系统/进程/网络 namespace 探测。rootless Docker 尚缺正确安装的 `newuidmap/newgidmap` 等组件；WSL2 未暴露 `/dev/kvm`，QEMU 可另行验证 TCG 软件模拟路线。配置兼容的 Docker 服务可以运行在宿主或 guest 中；两者都需执行下方完整验收，不能仅凭 namespace 探测就启用 Browser。

## 部署

1. 保留已有数据库和文件卷，构建新版 backend，运行新增迁移 `004_browser.sql`。API、worker、browser 必须使用同一迁移版本。迁移不删除现有账户、任务、产物。旧任务的墙钟消耗按保守值转入累计执行预算。
2. 在服务管理器的私密环境中设置已有 `POSTGRES_PASSWORD`、`RUNNER_TOKEN`，另生成至少 32 字符的 `BROWSER_TOKEN`。不要把它放到 Vite 环境、源码或网页。
3. 由有容器权限的运维账号执行：

   ```bash
   cd backend/deploy
   docker compose -f compose.yml -f compose.browser.yml config --quiet
   docker compose -f compose.yml -f compose.browser.yml up --build -d
   ```

4. 浏览器容器以非 root 用户运行，保留 Chromium sandbox。`bubblewrap` 给每个身份单独的 user/PID/mount namespace，只挂载本身份 profile、临时下载和认证过的 X display。内核必须允许无特权 user namespace；所附 seccomp profile 扩充 namespace 内 mount 操作。不要以 `--privileged`、`--no-sandbox` 或宿主 Chromium 绕过失败。若宿主 AppArmor 禁止此隔离方式，配置专用允许规则后再启动。
5. 浏览器只有 internal network；公网经独立 egress proxy。代理对所有 HTTP/CONNECT/WebSocket 目标解析、拒绝非公网地址，再连接已校验的数值 IP，防 DNS rebinding。只开放公网 HTTP 80、HTTPS/WSS 443；IPv4/IPv6 私网、loopback、metadata、非标准端口均拒绝。Chromium 强制代理、禁用 QUIC 和非代理 WebRTC UDP，默认 loopback 代理绕过已取消。
6. 不发布 8083、5900–5903、CDP 或 X11 端口。画面只能经过已登录 API 的 WebSocket gateway。现有 `npm run dev:v1` 仍使用 `localhost:5173`；已补上 `/api/v1` WebSocket 转发。公网反向代理须转发 Upgrade/Connection，使用 HTTPS，并禁止记录 `/api/v1/browser/sessions/*/view` 的查询串。浏览器 HTTP API 保持原 Origin/CSRF 检查。

健康检查会实际启动一次隔离 Chromium/Xvfb/VNC，验证本地文件导航限制及出口代理可达；失败则服务不就绪。API `/api/v1/capabilities` 返回 `browser.available=false`、空操作列表，UI 禁用 Browser。镜像设置最多两实例、3 GiB 内存、2 CPU、512 PIDs 和有界 tmpfs。禁用配置后仍保留数据库记录及 profile 卷。

`browser-seccomp.json` 基于 [Playwright v1.64.1 的 Docker seccomp profile](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json)（Apache-2.0），追加 bubblewrap namespace 内 mount/chroot 操作；Chromium 容器建议参照[官方部署说明](https://playwright.dev/docs/docker#crawling-and-scraping)。使用[持久 context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)而非 Cookie 导出，画面使用 [noVNC RFB](https://github.com/novnc/noVNC/blob/master/docs/API.md)。

## 使用

在 Integrations → Browser identities 创建身份。个人身份只在本人个人工作区使用；团队身份单独创建，管理员给当前团队成员明确授权。身份不可复制或转为另一工作区。给自定义 Agent 配置 Browser 工具，并在发送任务时选择身份。

thread 右侧选择 Browser。登录、验证码或 CAPTCHA 需要用户输入时，任务进入 `waiting_browser`，原对话显示提示。点击 Take over，服务端完成代次切换及执行通道停止后，点击 Connect controls 操作实际浏览器。登录直接在远端页面输入；不写到对话中。页面刷新、视图断线和应用退出都不交还 Agent。点击 Hand back to agent，可附说明；旧票据、旧元素引用和交接前尚未执行的意图失效，Agent 从新的观察继续。

人工可写连接仅授予当前控制者；同代次只保留一个可写连接。观察连接走独立的 `x11vnc -viewonly` 端口，修改前端 `viewOnly` 也不能输入。每个输入帧及每秒心跳重新验证应用会话、工作区成员资格、身份授权和控制代次。人工断线时页面与控制权保留，空闲 30 分钟后正常关闭并保留身份。

上传只允许任务 `inputFileIds` 中的工作区文件；服务拦截原生 file chooser，避免人工/网页通过文件选择器读取 profile。其它网页/浏览器弹窗可直接人工处理。下载和截图按 operation key 保存为原产物版本，未知文件扩展名作为 `bin` 原始文件保存，仅提供下载。已有上传格式限制仍适用。关闭会话保留 profile；删除身份要求先关闭会话且没有未结束任务，然后清除 profile 卷内相应目录。

## 执行和恢复

- 模型消息和意图先持久化。`prepareBrowser` 在 fenced 事务内登记 outbox 并将任务转 `waiting_tool`；worker 返回、释放租约。独立 dispatcher 重试发送稳定 operation ID，服务端事务去重，结果与 `task_inputs` 同时提交。
- 所有 browser 结果/交还/连接异常由同一持久输入入口消费；取消事务记录取消输入并立即撤销代次。同一任务串行消费，重复或过期结果不能二次推进。任务累计执行 20 分钟、token/tool 上限保留；人工等待、排队和异步浏览器等待不计入执行预算。浏览器页面动作独立限时 30 秒，会话启动另受启动超时限制。
- Take over/Hand back 必须带 `expectedEpoch` 与 `idempotency-key`。传输失败留在 `transferring`，用同一键、同一 body 重试。取消或成员撤权后不可发送后续动作。
- 服务用 PostgreSQL session advisory lock 保证单实例。失锁立即终止浏览器。启动时将上一实例 `running` 操作标为 `uncertain`，不重放点击/提交；未分发记录明确作废。恢复任务中，`uncertain` 不接受自动交还或重试，确认外部实际结果后取消旧任务、另开新任务。
- 服务重启/空闲关闭后，等待中的任务可在 Browser 面板 Reopen browser，接管检查后再交还。已保存登录身份及可恢复的地址重建，URL 查询串和 fragment 不保存；不保证未提交表单、页面 JS 内存、网站过期登录、下载中断等状态恢复。
- Agent 休眠不代表浏览器零资源消耗。已连接视图保活；浏览器继续占用容器资源。

## 加密备份

profile 不在 Git、普通文件 API、Memory 或模型上下文中；不启用浏览器录像、trace、键盘记录。备份只用加密流：

```bash
# age 接收者是公钥，私钥保存在另一受保护位置。
BROWSER_BACKUP_RECIPIENT='age1…' ./backup-browser.sh /secure-backups/browser-2026-11-03.tar.age
```

脚本先正常关闭 browser，直接 `tar | age`，不落地明文归档，不覆盖旧备份，结束时重新启动服务。数据库和普通文件使用原备份流程，并分别加密。恢复时先关闭 browser，在受限容器内解密到 profile 卷，保持 UID 1000、目录权限 0700，再启动；不可把解密数据解压到网站目录。应同时备份身份 metadata、授权、任务/outbox 的数据库状态。

## 可重复验收

不使用付费浏览器、搜索、代理、代登录或验证码服务。

开发环境可运行：

```bash
cd backend && npm test
# 回到仓库根目录
npm run build:v1
npm run test:v1-adapter
node scripts/test-browser-ui.mjs
node --test server/browser-profile-protection.test.mjs server/dev-ingress.test.mjs
```

真实容器验收提供 `browser-service/fixture.mjs` 和 `acceptance.mjs`。将 fixture 部署在自有**公网**测试地址（`BROWSER_FIXTURE=1 node browser-service/fixture.mjs`，只含公开 dummy 账号），使用单独空测试数据库。不要为测试放开生产私网出口。再在 browser 镜像内执行：

```bash
# 通过私密 env 注入 BROWSER_ACCEPTANCE_DATABASE_URL；必须与生产 DATABASE_URL 不同且没有用户。
# BROWSER_TEST_ORIGIN 指向公网 dummy fixture，不能填真实登录站点。
docker compose -f compose.yml -f compose.browser.yml run --rm \
  -e BROWSER_ACCEPTANCE_DATABASE_URL -e BROWSER_TEST_ORIGIN \
  browser node browser-service/acceptance.mjs
```

此脚本测试 Cookie/localStorage/IndexedDB 跨任务、浏览器关闭重开、服务重启、登录过期、填写、授权上传、下载产物和截图。它不会伪装成人工登录或真实网站验收。

仍需在部署机逐项记录：

1. Agent 打开 fixture 登录页 → 用户通过真实 VNC 输入公开 dummy 密码/OTP/CAPTCHA → 交还 → Agent 搜索、选择、滚动、标签页、alert、上传和下载；再次接管改值，交还后确认旧 ref 被拒绝。
2. 观察连接用修改过的客户端发送键盘/鼠标/剪贴板，确认页面不变化；写连接在交还、退出登录、撤权后即失效。两位获授权成员同时接管，只一位成功。
3. 在点击/提交中 kill browser/service、丢失结果响应、重复提交 operation、乱序结果、取消；核对 `uncertain` 与外部站点的提交次数，不能盲目再提交。
4. 人工等待超过 20 分钟后交还；期间另一个任务完成，等待任务没有 lease。无连接 30 分钟后正常关闭，profile 仍可复用。
5. 浏览器访问 metadata、localhost、私网 IP、IPv6 私网、重定向至私网、公网 DNS 混合/重绑定及 `file://` 均失败；原生文件选择器不能读取 profile 或普通服务器文件；两个身份的 namespace 不互通。
6. 使用用户自己手动登录的真实网站做最终往返。列出各网站 OAuth、会话过期、WebAuthn、下载/弹窗和自动化检测限制。不开启本地浏览器连接器，不读取电脑已有凭据。

当前环境实测结果见 [验证记录](../../docs/verification-browser/REPORT.md)。在完成这些部署验收前，不应宣称完整上线。
