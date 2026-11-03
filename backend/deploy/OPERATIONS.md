# 部署与恢复

## Docker + gVisor

在有权限管理 Docker 的 Linux 主机，按 [gVisor 官方说明](https://gvisor.dev/docs/user_guide/quick_start/docker/) 安装 runsc 并注册 Docker runtime。先验证 `docker run --runtime=runsc --rm hello-world`，然后构建镜像：

```bash
cd backend
# 构建由维护者执行，用户代码不能构建镜像或安装依赖。
docker build -t hyperagents-sandbox:1 -f deploy/Dockerfile.sandbox .
# POSTGRES_PASSWORD 使用 URL 安全字符；RUNNER_TOKEN 至少 32 个随机字符。
# 设置 DEEPSEEK_API_KEY、PUBLIC_ORIGIN 等私有环境变量后：
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d
# 首次初始化；ADMIN_EMAIL / ADMIN_PASSWORD 从维护者环境传入。
docker compose -f deploy/compose.yml exec -e ADMIN_EMAIL -e ADMIN_PASSWORD api node apps/cli/dist/index.js bootstrap
docker compose -f deploy/compose.yml exec api node apps/cli/dist/index.js invite
docker compose -f deploy/compose.yml exec api node apps/cli/dist/index.js doctor
```

API 只绑定宿主 127.0.0.1:8081，在前方配置 HTTPS 反向代理，`PUBLIC_ORIGIN` 必须是实际公开 origin。代理转发 Cookie、Origin 和 SSE，关闭 SSE 缓冲。不将 Runner 端口、PostgreSQL 端口或 Docker socket 暴露到公网。HTTP 本地开发使用非 Secure cookie；HTTPS origin 自动使用 Secure。

API 和 Worker 没有 Docker socket；只有独立 Runner 持有。Runner 使用内部网络及 Bearer token，固定镜像和固定参数创建容器。宿主 `/var/lib/hyperagents-runner` 必须与 Runner 容器内路径一致，Docker 才能正确挂载该操作的只读输入。它与 API 文件卷分离；输入按权限校验后由 Worker 传输。

每次代码操作使用独立 gVisor 容器，属于单一任务；后续操作通过真实 fileId 读取先前产物，不隐式继承前一操作的临时文件。只挂载该操作输入，工作目录是 1 GiB tmpfs。网络关闭、根文件系统只读、2 vCPU、2 GiB 内存、128 PID、120 秒执行限时。用户程序无模型密钥、宿主工作区或 Docker socket。执行器的命令使用参数数组，不执行宿主 shell。

Runner 的就绪检查实际运行 runsc 探针并验证沙箱镜像。失败时 `capabilities.sandbox.available=false`，代码执行返回明确错误。Runner 保存请求摘要及结果回执；同一个 operation ID 改变内容会被拒绝。重启时清理自己命名前缀的未完成容器并将它们标记 uncertain。不得删除未完成操作回执后盲目重试。

在具备宿主条件的机器上运行 `npm run test:sandbox` 验证 Python/Node、断网、内存/磁盘/PID 限制、超时、取消和 symlink 输出拒绝。该项不在无 gVisor 环境中计作通过。

## 数据与备份

旧系统：本次使用 SQLite 在线 backup API 创建快照，同时复制其它旧数据文件，生成 SHA-256 清单并校验每份 SQLite。脚本不删改原始数据。

```bash
python3 backend/deploy/backup-legacy.py \
  --source .data \
  --destination /private/backups/hyperagents-legacy-YYYYMMDD
```

快照包含 `.data` 内文件；部署时若上传目录配置在别处，应额外备份该目录。密钥使用独立加密备份，不复制进源码或报告。恢复旧系统时先停止旧服务，将快照恢复到原配置的数据目录；不要将旧 SQLite 导入新 PostgreSQL。保留当前旧文件作为二次回退副本，核对清单与 SQLite integrity_check 后再启动旧服务。

新系统：同时备份 PostgreSQL 数据和 `files` 数据卷。最简单的一致快照方法是停止 API/Worker、等 Runner 无活动容器，然后执行 `pg_dump` 与文件卷快照；恢复时保持相同版本的 SQL migrations 和对象数据。Runner 回执也应备份，防止未知操作被误判为首次执行。恢复后先启动数据库、跑 migrations，再启动 Runner、Worker 和 API，检查 `doctor` 及任务事件。

模型密钥只进入 Worker/API 服务配置，Runner 不配置。数据库与文件卷是私有数据：只有维护者和对应服务账户访问，不能静态公开 objects 目录。

## 运行限制与监控

默认每用户 1 / 全局 2 顶层运行任务；每父任务最多 2 子任务、一层深度。20 分钟期限包含等待时间；超过期限的任务在重新调度时失败。每任务树 32 模型尝试、64 工具调用、200K 累计输入输出 token、单次输出最多 32768 token；重试也计数。研究工具最多 12 次，或累计 10 次模型调用 / 60K tokens 后转入交付阶段；停止继续搜索与分工，为生成和校验保留预算。模型流单次 8 MiB、整个任务树 64 MiB、单文件 20 MiB、产物总计 100 MiB，代码输入/输出各合计 20 MiB。

当前预算预留采用保守输入字节上界，并在拿到真实 usage 后结算。HTTP 402 单独报告 MODEL_QUOTA，不重试；已知 HTTP 拒绝不计 token 消耗。未知流中断或 Worker 崩溃按预留上限计费到任务预算；此数字不是供应商账单，报告应区分实际 usage 与保守预留扣减。pg-boss 的队列递送不是任务事实来源，可重建唤醒队列。

监测 `tasks.state/error_code`、`model_attempts`、事件中的 model usage/elapsedMs，以及对象卷和 Runner 回执盘占用。日志不输出原始供应商错误或 reasoning。大规模日志保留、对象 GC、Runner 回执回收、用户持久存储配额与管理员 UI 仍需运维策略，当前不自动删除用户数据。

## 协议参考

- [DeepSeek thinking/tool 上下文](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)
- [Fastify TypeScript](https://fastify.dev/docs/latest/Reference/TypeScript/)
- [pg-boss](https://github.com/timgit/pg-boss)

模型名称由 `DEEPSEEK_MODEL` 配置；评测报告记录实际请求名称。供应商别名可能更新，严格复现实验应使用供应商提供的固定版本名称（若可用），并保存提示词/案例/工具版本与报告。

## 本机独立 Runner 评测

Runner 可由受限的专用服务账户或维护者启动，API/Worker 保持普通用户权限。不要把普通 Worker 账户加入 Docker 组。维护者创建私有 Runner 环境文件（只含 Runner token、目录和监听设置，不含模型密钥），启动后可通过 `npm run eval -- --runner-env=.data-v1/runner.env` 运行完整评测。`--cases=research-databases,independent-research` 只用于针对性回归。

当前 gVisor 官方发行包采用多文件布局，必须同时安装 `runsc` 和相邻的 `gvisor-bin/` 配套二进制，不能只复制 runsc。手动安装前校验官方 SHA-512；优先遵循官方 apt 仓库安装流程。

构建机器使用代理时，可显式传入 Docker 标准 `HTTP_PROXY`/`HTTPS_PROXY` build args；代理仅用于构建，任务容器仍断网。后端镜像只复制 Docker CLI，不启动 Docker daemon；API/Worker 没有 socket。

PDF 文档代码可使用预装的 `from hyper_document import markdown_pdf`，传入统一 Markdown 字符串与输出路径。该函数离线嵌入中文字体，并将 Unicode 减号规范为可渲染的 ASCII 减号。数学内容仍须通过代码代入与交付审核。
