# 用户目录运行包

`python3 sandbox/build-runtime.py` 在 `~/.local/share/hyperagents/runtimes/` 构建浏览器和计算两个独立目录，不使用 Docker、sudo、宿主 pip 安装或常驻虚拟机。构建需要 Python 3.11+、pip、bubblewrap、dpkg-deb、gpgv、util-linux（flock）和网络；运行需要用户级 systemd、cgroup v2、可用的 user/mount/PID/IPC/UTS/network namespace，以及安装完整官方发行包的 runsc（包括相邻 gvisor-bin）。

默认读取提交的 `runtime.lock.json`，固定 Python/Node 镜像摘要、Debian 包 URL/大小/SHA-256 和全部 Python wheels。更新依赖时显式运行 `--update-lock` 并审阅锁文件。首次解析 Debian 软件包时校验 Debian 签名和索引校验和。OCI 每层校验摘要，归档提取阻止路径逃逸；保留 Debian usrmerge 链接。已安装包的所有文件和链接另存于 manifest，启动探针核对清单和文件。运行包通过只读挂载共享，任务不能安装依赖。

```sh
python3 sandbox/build-runtime.py --kind all
npm run build
COMPUTE_RUNTIME_DIR="$HOME/.local/share/hyperagents/runtimes/compute" npm run test:sandbox
```

计算使用受控 OCI 配置直接启动 runsc，`systrap`、`--network=none`、单 UID user namespace、只读 rootfs 和 inputs、128 MiB `/tmp`、1 GiB `/work`。此处采用 runsc 原生 rootless OCI 路径，不传会再次创建 user namespace 的 `--rootless` 开关，也不使用 `runsc do`。执行账户在宿主仍是普通用户。空闲时没有计算进程；默认一次一项操作。init 保持 tmpfs 存活，有限输出先在 guest 内以 `O_NOFOLLOW` 校验并导出，再停止完整 cgroup。回执先 fsync，结果不明时标记 uncertain；禁止删除回执后重放操作。

浏览器每身份一个 bubblewrap 沙箱，完整 Chromium/Xvfb/Openbox/VNC 同处其中。仅挂载只读 runtime、本身份 profile 和专用控制 socket 目录；临时工作区和 `/tmp` 是有界 tmpfs。没有宿主 home、完整宿主 `/etc`、数据库凭据、D-Bus、宿主网卡或其他 profile。HTTP/HTTPS 通过 namespace 内 loopback 转发到专用 Unix 出口代理；代理检查全部 DNS 结果并连接已检查数值地址。CDP、输入和只读画面均通过 Unix socket，不监听宿主 TCP。只读画面由独立 `x11vnc -viewonly` 强制执行。

Chromium 自身 namespace 和 seccomp sandbox 均须通过 `chrome://sandbox` 探针。Chromium 156 的 DevTools=2 策略会禁止 CDP target attach，因此轻量包使用 DevTools=1，同时保留 file/filesystem/devtools/chrome URL 限制；安全边界是 namespace、只读挂载和出口代理。人类仅能访问自己身份中的页面与数据。

`hyperagents-sandbox.slice` 共用 MemoryMax=5 GiB、MemorySwapMax=0、CPUQuota=200%。浏览器每身份 1536 MiB，最多两个；计算每项 2 GiB、120 秒。systemd 使用 KillMode=control-group，清理全部 sentry/gofer、浏览器和显示子进程。浏览器空闲 30 分钟关闭；连接和动作期间保活；关闭保存 profile，删除身份才删除持久数据。健康探测失败能力关闭，不回退宿主执行。`/metrics` 为带内部认证的真实 cgroup 读数。

Docker 部署仍可显式使用 `SANDBOX_BACKEND=docker`、`BROWSER_RUNTIME_KIND=docker`，与原镜像/compose 配套。新部署默认采用轻量路径。

真实沙箱、资源样本和完整流程结果见 [验收记录](../../docs/verification-rust-sandbox/REPORT.md)。启用开关保持关闭，直到真实网站人工登录与业务验收完成。

本地 `npm run dev:v1` 会发现用户目录下已安装的 compute 包，并在 8084 启动同版本 Runner（端口可用 `RUNNER_PORT` 指定）。不再自动读取旧 `backend/.data-v1/runner.env`。外部 Runner 只有在 `.env` 或环境明确设置 `RUNNER_URL` 时才使用，并须在健康响应声明 `protocol: 1`；缺少版本的旧进程会被报告为 `RUNNER_PROTOCOL_MISMATCH`，不再显示为可用。
