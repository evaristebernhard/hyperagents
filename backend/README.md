# TypeScript 多用户 Agent 后端

这个目录是独立的 v1 后端，使用新 PostgreSQL 数据库、独立端口和私有文件目录。旧 `.mjs` 服务、SQLite、前端接口及现有未提交修改均保留。新系统不自动迁移旧数据，也不提供旧前端兼容层。

实际验证情况见 [VERIFICATION.md](VERIFICATION.md)。未通过真实任务质量门槛之前，不应把“编译通过”视为首期验收完成。

## 运行

需要 Node.js 24、PostgreSQL 17+、Poppler（`pdftotext`、`pdftoppm`、`pdffonts`）。代码和图表/PDF 生成还需要安装 Docker/gVisor 的 Runner 主机；缺少它不会回退到宿主 Python 或 shell。

```bash
cd backend
npm ci --ignore-scripts
npm run typecheck
# 设置环境变量，或将 .env.example 复制为 .env 并用 Node --env-file=.env 启动。
export DATABASE_URL='postgres://hyper:password@localhost:55432/hyper_v1'
export DATA_DIR="$PWD/.data-v1"
export PUBLIC_ORIGIN='http://localhost:8081'
npm run migrate
# ADMIN_EMAIL / ADMIN_PASSWORD 由私有环境传入；不要写进命令行参数或提交到仓库。
npm run cli -- bootstrap
npm run cli -- invite
npm run api
# 另一个终端，设置同样的环境变量：
npm run worker
```

脚本不隐式读取旧服务的 `.env`。评测脚本只在本地明确加载 `../.env` 中已有的模型密钥，且不打印密钥。生产建议使用服务管理器的私有环境文件或 secret 注入。

CLI 首次 bootstrap 仅在用户表为空时成功。`invite` 输出一次性注册令牌；API 管理员也能创建、列出和撤销邀请。邀请有效期 7 天，不提供首期邮件服务。邀请中的 `/register` 尚未提供注册表单；目前通过 CLI 或 `POST /api/v1/auth/register` 使用令牌。

```bash
# AGENT_EMAIL、AGENT_PASSWORD、AGENT_INVITE 由环境传入。
npm run cli -- register
npm run cli -- login
npm run cli -- upload ./input.csv
npm run cli -- task ./request.json stable-request-key
npm run cli -- get TASK_UUID
npm run cli -- events TASK_UUID 0
npm run cli -- instruct TASK_UUID ./correction.txt
npm run cli -- download FILE_UUID ./result.md
```

`request.json` 示例：

```json
{
  "prompt": "生成中文数学练习 Markdown 和 PDF，按难度分组，所有答案置后。",
  "inputFileIds": [],
  "acceptance": {
    "formats": ["md", "pdf"],
    "requiredText": ["简单", "中等", "较难", "答案"],
    "requireSources": false
  }
}
```

使用 `conversationId` 新建后续任务，可修改同一对话中的产物，保留版本。执行中的纠正使用 `tasks/:id/instructions`，下一安全边界生效。已完成任务继续修改应新建任务并沿用对话；重试不会重置消耗过的预算，`uncertain` 不允许自动重试。

## API 与客户端

全部业务 API 在 `/api/v1`。登录响应给出 `csrfToken`，服务端设置 HttpOnly/SameSite Cookie。所有修改请求必须带与 `PUBLIC_ORIGIN` 一致的 `Origin`；登录后还须带 `x-csrf-token`。CLI 自动处理这两项。任务创建要求 `idempotency-key`，返回 202。同一个工作区里重复同键同参数返回原 taskId，不同参数返回 409。

| 路径                                                              | 用途                                |
| ----------------------------------------------------------------- | ----------------------------------- |
| `POST auth/register, auth/login, auth/logout`；`GET auth/session` | 认证与会话                          |
| `POST/GET invites`；`DELETE invites/:id`                          | 管理员邀请管理                      |
| `GET conversations, conversations/:id`                            | 对话、消息与产物索引                |
| `POST/GET tasks`；`GET tasks/:id`                                 | 创建、列表、状态                    |
| `POST tasks/:id/instructions, cancel, retry`                      | 追加指令、取消、重试                |
| `GET tasks/:id/events?after=CURSOR&limit=100`                     | 持久事件分页；Accept SSE 时流式输出 |
| `GET tasks/:id/sources, tasks/:id/approvals`                      | 来源与精确动作审批                  |
| `POST tasks/:id/approvals/:approvalId`                            | 按 digest 确认/拒绝；不执行外部动作 |
| `POST/GET files`；`GET files/:id/download`                        | multipart 上传、列表、下载          |
| `GET artifacts/:id`                                               | 产物版本、源文件、校验与来源        |
| `GET capabilities, openapi.json`                                  | 实际配置/沙箱可用性与 OpenAPI       |

SSE 每次连接最多 25 秒，客户端用 `Last-Event-ID` 续接。客户端断开不影响任务。对话列表与任务列表当前最多 100 条；事件、文件正文和来源正文可分页。API 错误只包含安全错误码与请求 ID。

共享契约位于 `packages/contracts`，包括 Zod schema、状态/事件联合类型、模型与工具协议，以及带运行时响应校验的 `Client`。Fastify 使用同一套 Zod 契约生成 OpenAPI。

```ts
import { Client } from "@hyper/contracts";
const api = new Client("http://localhost:8081");
await api.login({ email, password });
const { taskId } = await api.createTask(
  {
    prompt: "生成学习计划 Markdown",
    inputFileIds: [],
    acceptance: {
      formats: ["md"],
      requiredText: ["学习计划"],
      requireSources: false,
    },
  },
  crypto.randomUUID(),
);
const task = await api.task(taskId);
```

## 执行与恢复约定

API 不执行模型循环。Worker 以 pg-boss 唤醒并定期扫描数据库；数据库中的状态和租约为准。默认每个工作区一项运行中的顶层任务，全局两项；每个父任务可创建两项独立子任务，子任务禁止再次分工。主子任务共享调用、token、传输和产物预算。

模型响应和工具意图事务性保存，然后逐项执行。每个操作有稳定 UUID。文件先以 SHA-256 内容地址持久写入，再提交文件与产物版本元数据。产物保存使用唯一 operation key，崩溃后重复保存不会产生额外版本。孤立内容对象可以出现，但不会产生伪造的下载记录；不得在任务运行中清理它们。

租约每秒续期，失去租约立即中止本地请求。旧 Worker 无权提交新结果。过期读取操作可恢复；过期代码执行进入 `uncertain`，不盲目重放。崩溃中的模型预留用量按保守上限计入消耗，以免重启绕过预算。

支持 `queued`、`running`、`waiting_children`、`waiting_user`、`waiting_approval`、`uncertain`、`succeeded`、`failed`、`cancelled`。取消会撤销租约并中止模型/Runner；保留已保存的文件。完成提交前再次检查是否有新指令，防止旧答案覆盖执行中纠正。

完成必须显式调用 `finish`：重新读取真实文件、验证格式/解析、必需内容与来源、检查真实下载引用，并调用模型审核内容覆盖。最多允许两轮修复。模型审核并非数学正确性的形式证明，真实评测仍有独立内容与结构评分。

长上下文会形成有界检查点，保留原请求、全部用户指令、来源与产物引用，以及最近工具状态。来源正文通过 `source_read` 分页，文件通过 `file_read` 分页。DeepSeek 的 `reasoning_content` 仅存在私有检查点，按供应商协议回传，不通过公开任务或事件 API 返回。

## 部署、备份和运维

详见 [deploy/OPERATIONS.md](deploy/OPERATIONS.md)。默认 8081 不占用旧服务端口；新数据卷独立。Docker 镜像构建、gVisor 执行、资源超限和取消残留容器必须在实际宿主机验收，不能用无 Docker 的单元测试代替。

```bash
npm test
npm run doctor
npm run eval
```

`npm test` 使用 `TEST_DATABASE_URL` 指定的**空测试数据库**；未指定时启动用户态临时 PostgreSQL。测试不连接生产数据库。真实评测通过 HTTP 上传、创建任务、轮询、下载和修订，并用独立生产 Worker 执行。默认固定 12 个案例、各 3 次；缺少必要能力计为 blocked 并影响总通过率。`EVAL_CASES=id1,id2`、`EVAL_REPEATS=1` 只用于有明确范围的回归，不构成完整验收。

## 原版前端接入

仓库根目录运行 `npm run dev:v1`，访问 `http://localhost:5174`。入口复用 main 的侧栏、首页、对话布局和产物面板；任务进度、追加指令、取消和产物历史版本均在原对话中处理。新账号、数据库、文件目录保持独立并持久保存。完整步骤和本次验收见 [前端接入报告](../docs/verification-v1-ui/REPORT.md)。
