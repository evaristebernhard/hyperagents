# Hyperagents UI recreation

根据实际浏览器采集的 Hyperagent 界面与导航规则，重新实现的独立前端演示。**不是 Hyperagent 官方应用，也不包含其私有源码或后端。**

## 本次实现

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

部分配置、分享/安装/导入/自动化/发布按钮仅展示前端状态与提示，不声称具备真实后台能力。Documents / HyperApps / Workflows / Workspaces 为显式标记的补充空态，不代表已经观察到原站这些页面的完整行为。

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

演示会话、Agent 身份、项目、记忆、主题与部分默认配置存储于带 `hyperagents-demo:` 前缀的 localStorage。没有服务端同步。

- 发送消息只创建本地会话，并返回固定的“未连接模型”说明。
- 新建 Agent 只保存身份字段，不启动运行环境。
- 新建记忆和项目、关联会话仅影响当前设备。
- 工作笔记、部分表单/菜单配置是当前视图的临时状态。
- 选择导入文件仅本地预览，不上传；Agent JSON 导入可填入本地身份表单。

演示身份使用 `Demo User / demo@example.com`，不包含采集时的真实账号资料。清除本域浏览器数据可重置演示状态。

## 部署

`dist/` 可部署到任意支持 SPA fallback 的普通静态站点。刷新 `/thread/...` 等路径时，服务器必须回退到 `index.html`，且静态资源仍按真实路径返回。

仓库提供 Nginx 配置及多阶段 Dockerfile：

```bash
docker build -t hyperagents-ui .
docker run --rm -p 8080:80 hyperagents-ui
```

Docker 容器配置已提供，但本次未实际执行 Docker 构建。GitHub Pages 自动发布已移除；原 pages.yml 改为手动构建分发包，不会部署 Pages。CI 在 main/PR 上执行构建和浏览器测试。

## 验证

本次本地执行结果：TypeScript + 生产构建通过；41 项 Playwright 测试通过，覆盖直接路由、刷新/前后退、搜索与键盘、设置查询参数、Agent 身份保存、项目/记忆本地持久化、会话画布、移动端与无 API 调用边界。

测试中的页面截图是渲染检查，**不是逐像素对比基准**。界面布局以采集截图为参考，字体在无网络时回退系统字体；没有复制商业字体文件。

## 素材与来源

导航与布局参考采集自 `https://hyperagent.com` 和 `https://www.hyperagent.com/`（2026-10-27）。`public/examples/*.svg` 内的位图是公开营销首页案例图的裁切，仅用于界面参考，版权归各自权利人。上线自有产品前应替换为自有/获许可素材与品牌名称。

没有将私人会话截图、登录凭据、API keys 或采集资料包放入本仓库。
