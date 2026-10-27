# Hyperagents UI recreation

根据实际浏览器采集的 Hyperagent 界面与导航规则，重新实现的独立前端演示。**不是 Hyperagent 官方应用，也不包含其私有源码或后端。**

## 0.3 更新：从页面演示到本地可用

本轮继续轻量化：**固定 Skills 随前端发布，用户内容保存在浏览器，不要求数据库。**

- Skills 完整的创建、编辑、预览、安装、复制、归档、删除、导入导出及 Agent 关联。
- Agent 模型/工具/知识偏好与已关联 Skills 一起保存，不再仅保存身份字段。
- 房间、笔记、团队身份、关联会话和计划配置可本地保存；后台执行始终关闭。
- Library 支持产物创建/导入/编辑/下载/归档/版本恢复，与会话画布共用数据。
- 会话分叉、项目迁移、归档恢复与导出；Memories 完整编辑；手工 Rubrics。
- 隔离的本地工作区、JSON 内容备份与带验证/确认的恢复流程。
- 集成页面可以保存/删除连接元数据，但不会发起 OAuth 或保存密钥。

详见 [docs/LOCAL-FIRST.md](docs/LOCAL-FIRST.md)。保留用户新增的 Vite `lp.chayu123.me` 主机配置。

## 页面范围

- 256px 全局侧栏、折叠图标栏、Personal 工作区菜单、账户菜单。
- 新任务首页、近期会话、案例预览、会话列表与筛选/网格。
- 会话详情、可拖动/键盘调整宽度的分栏、文档与网页画布、产物过滤、Tile/Carousel/Windows 展示状态、全屏预览。
- 搜索弹窗（Ctrl/Cmd+K、方向键、Enter、Escape）、输入框模型/执行模式/附件/输出格式菜单。
- Agent 列表、新建与编辑、Identity / Model / Tools & integrations / Invocations / Knowledge 五个页签。
- Skills 列表/详情/编辑器、Memories、新建记忆弹窗。
- Projects 列表/新建/详情、关联已有会话、项目内会话跳转。
- Library 列表与产物预览，Marketplace 深色首页与 Agent/Skill 详情。
- Inbox → Learning、Rubrics、Autowiki、Command Center。
- 13 个账户设置子页面，通过当前路径的 settings 查询参数展示。
- 营销参考页 `/marketing`、认证演示 `/login`、法律说明页、404。
- 桌面与窄屏布局；窄屏会话通过全屏弹窗查看产物。

## 明确不包含

LLM 推理、真实 Browser 控制、Thread 工具执行、OAuth、真实登录、多用户权限、外部集成、付款、后台任务、调度与知识检索均未连接。相关控件展示说明或本地预览，**不会调用原站写接口**。

分享采用本地文件导出，Skills 安装/导入、产物管理和计划配置已可本地操作；公共发布、真实授权、付款和实际自动化仍未连接。Documents、Workflows、Workspaces 增加的是本地扩展实现，不声称这些扩展完全等同于原站未采集的页面。HyperApps 保持显式空态。

## 技术与运行

React 18 + TypeScript + Vite 6 + lucide-react。使用浏览器 History API 的普通路径路由，**不使用 GitHub Pages 子路径或 hash 路由**。

需要 Node.js 20.19+（建议 Node.js 24）。

```bash
npm ci
npm run dev
```

默认开发地址 `http://localhost:5173`。本地 Vite 支持直接打开深层路由。

```bash
npm run build       # TypeScript 检查 + 生产构建
npm run preview     # 本地预览生产构建
npm run typecheck
npm test            # Playwright 浏览器测试
```

首次运行测试需要安装浏览器：

```bash
npx playwright install chromium
# Linux CI 可使用 npx playwright install --with-deps chromium
```

## 路由规则

| 界面                     | 路径 / 状态                                                     |
| ------------------------ | --------------------------------------------------------------- |
| 新任务首页               | `/threads/new`；`/` 重定向至此                                  |
| 会话列表 / 详情          | `/threads` / `/thread/:id`                                      |
| 会话配置侧栏             | `/thread/:id?panel=settings`                                    |
| Agent 列表 / 新建 / 编辑 | `/agents` / `/agents/new` / `/agents/:id`                       |
| 房间列表 / 新建表单      | `/rooms` / `/rooms/new`                                         |
| 技能                     | `/skills` / `/skills/:id` / `/skills/new` / `/skills/:id/edit`  |
| 记忆                     | `/memories`；新增为不改变 URL 的弹窗                            |
| 项目                     | `/projects` / `/projects/new` / `/projects/:id`                 |
| 产物库                   | `/library`；点击卡片全屏预览，URL 不变                          |
| 市场                     | `/marketplace` / `/marketplace/a/:id` / `/marketplace/s/:id`    |
| 学习相关                 | `/inbox` / `/learning` / `/rubrics` / `/wiki`                   |
| 运营概览                 | `/command-center`                                               |
| 账户设置                 | 当前页面 `?settings=personalization` 等查询参数                 |
| 集成设置兼容入口         | `/settings/integrations` → `/threads/new?settings=integrations` |
| 公开参考界面             | `/marketing` / `/login` / `/terms` / `/privacy`                 |
| 404                      | `/404` / `/signup` 与其他未知路径                               |

搜索、侧栏菜单、输入框菜单、Live 设置弹窗、Library 预览均不创建独立页面路由。Agent 五个页签也不改变 URL。完整说明见 [docs/UI-MAP.md](docs/UI-MAP.md)。

## 本地数据

内容通过 `WorkspaceProvider` 保存到 `hyperagents-demo:workspace-v1`；首次升级会读取 0.2 的旧内容键。多个工作区隔离保存 Skills、Agents、Projects、Memories、Rooms、Artifacts、Schedules 等内容。

- 数据只属于当前浏览器和站点 origin，没有服务器同步或多人协作。
- 发消息仍只保存本地占位，不请求模型。
- Agent 配置和 Skills 是可编辑数据；不运行代码或工具。
- 计划只保存配置，明确显示执行关闭。
- 文档变更可以保留和恢复版本；HTML 预览经过清理、sandbox 和 CSP 隔离。
- `/workspaces` 提供 JSON 内容备份/恢复，导入先校验并要求确认替换。
- 出现浏览器容量错误时会提示导出备份。导入文件有大小上限，适合小规模演示。

演示身份使用 `Demo User / demo@example.com`，没有采集时的真实账户资料。清除本域浏览器数据将清除本地内容，操作前应导出备份。全局外观/资料偏好不在内容备份中。

## 部署

`dist/` 可部署到任意支持 SPA fallback 的普通静态站点。刷新 `/thread/...` 等路径时，服务器必须回退到 `index.html`，且静态资源仍按真实路径返回。

仓库提供 Nginx 配置及多阶段 Dockerfile：

```bash
docker build -t hyperagents-ui .
docker run --rm -p 8080:80 hyperagents-ui
```

Docker 容器配置已提供，但本次未实际执行 Docker 构建。GitHub Pages 自动发布已移除；原 pages.yml 改为手动构建分发包，不会部署 Pages。CI 在 main/PR 上执行构建和浏览器测试。

## 验证

0.3 本地执行结果：TypeScript + 生产构建通过；56 项 Playwright 测试通过，覆盖直接路由、刷新/前后退、搜索与键盘、设置查询参数、Agent 身份保存、项目/记忆本地持久化、会话画布、移动端与无 API 调用边界。

测试中的页面截图是渲染检查，**不是逐像素对比基准**。界面布局以采集截图为参考，字体在无网络时回退系统字体；没有复制商业字体文件。

## 素材与来源

导航与布局参考采集自 `https://hyperagent.com` 和 `https://www.hyperagent.com/`（2026-10-27）。`public/examples/*.svg` 内的位图是公开营销首页案例图的裁切，仅用于界面参考，版权归各自权利人。上线自有产品前应替换为自有/获许可素材与品牌名称。

没有将私人会话截图、登录凭据、API keys 或采集资料包放入本仓库。
