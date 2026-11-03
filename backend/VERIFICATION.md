# 后端验收记录

验证日期：2026-11-03。范围为独立的 `backend/` 与对应 CI；旧服务已有修改不计入本次成果。

## 确定性验证

`npm test`：49 项通过，0 失败，0 跳过。包含严格类型检查、实际 PostgreSQL migrations/事务、HTTP API 和 SSE 续接、跨工作区访问、邀请与会话、任务幂等、取消与追加纠正、共享预算、子任务、租约失效、进程 SIGKILL 恢复、产物提交崩溃窗口、DeepSeek 多轮工具协议与 429/503/402/流中断/截断、SSRF 和格式校验。PDF 回归实际渲染 12 页。

## 真实模型评测

固定案例见 `evals/cases.ts`，完整门槛为 12 个案例各 3 次，至少 33/36 通过，且数学文档/PDF/修订案例 3/3。内容、文件、执行、版本分别评分；缺少 gVisor 计入 blocked，不从分母排除。

历史报告保留在 `evals/results/`。早期运行发现并修复了研究循环耗尽预算、工具产物 ID 字段不一致、答案排序评分误判和 HTTP 402 未区分余额不足等问题。充值后的针对性研究回归为 6/6；该结果不能替代完整 36 次验收。

真实 gVisor 验收 15 项全部通过：Python、Node、无模型密钥、无 Docker socket、断网、幂等、中文 PDF 渲染、PNG、符号链接拒绝、内存/工作目录/PID 限制、取消、120 秒超时及无残留容器。发现并修复了冷启动探针不足、Docker 日志配置、临时文件回收时机及超时返回码问题。

新增固定的离线中文 PDF 函数 `hyper_document.markdown_pdf`，从统一 Markdown 生成可提取中文并保留减号的 PDF；全部页面通过 Poppler 渲染。模型完成调用漏带产物 ID 时，从本任务、同一工作区的实际最新版本补齐所需格式，再做完整校验。新增 PostgreSQL NUL 字符回归、12 页 PDF 和漏带文件 ID 回归通过。

最终完整评测 **35/36（97.2%）通过，0 blocked，质量门槛通过**；数学文档/PDF/修订案例 **3/3**。原始报告：[2026-11-03T07-51-23-167Z.json](evals/results/2026-11-03T07-51-23-167Z.json)，机器汇总：[verification.json](evals/results/verification.json)，确定性测试输出：[deterministic-tests.log](evals/results/deterministic-tests.log)。

唯一未通过评分的案例为 HTML 第 2 次：文件内容、格式与下载检查通过；模型使用 `code_execute` 生成 HTML，而评测要求出现 `artifact_write`，因此执行评分失败。保留严格原始分数，没有改写为 36/36。

该轮共 213 次模型尝试；实际输入 1,115,283 tokens，输出 101,252 tokens，未知 usage 为 0；合计 1,216,535 tokens。传输 30,161,195 字节，产物 761,238 字节，共 59 份产物文件（含修订版本）。这些数字仅覆盖最终完整运行，不包含历史回归及中止运行；后者数据库和中止原因仍保留。

后端与沙箱镜像构建成功，Compose 配置校验通过，生产镜像中的 Node、Argon2 与数据库 doctor 检查通过。真实数学 PDF 六页已逐页渲染检查，中文、ASCII 减号和解题步骤可读；图表中的 A/B 均为 20。样例与 SHA-256 来源清单保存在 `evals/examples/`。

历史失败报告保留；中止运行在私有评测目录中有 `ABORTED.json`，不计为通过。

`npm run audit:eval` 从保留的评测数据库重新汇总实际供应商 usage、未知 usage 次数、保守预算扣减和产物字节；预算扣减不等同于供应商账单。报告不包含密钥或供应商 reasoning。

## 部署与数据

旧 SQLite 与文件已通过在线备份保存至私有 `.data-v1/backups/legacy-20261103/`，共 5 文件、2,826,240 字节，附 SHA-256 清单；SQLite integrity_check 通过。

已安装 Docker 与 gVisor `release-20261102.0`，gVisor 官方发行包通过 SHA-512 校验。普通 Worker 账户未加入 Docker 组；独立 Runner 管理 Docker，用户代码只在断网的 gVisor 容器中执行。

运行与恢复步骤见 `deploy/OPERATIONS.md`。模型名称 `deepseek-chat` 是供应商别名；报告记录请求名称和提示词/工具版本，不能保证供应商以后维持同一模型快照。

## 历史前端试验

`evals/results/ui-verification.json` 保留先前简化工作区的浏览器试验记录，仅为历史证据；该界面和启动脚本不属于本次后端提交，也不代表 main 原版界面接入验收。原版 UI 接入将在后续提交中单独记录。
