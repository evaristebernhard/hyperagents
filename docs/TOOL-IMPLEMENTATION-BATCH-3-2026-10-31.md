# 第三批 Agent 实现：审批式文件、已安装脚本、只读委派

2026-10-31。三条隔离并行线，主线统一接入同一个 durable run / registry / approval / workspace persistence。新增11个模型工具，不新建第二套执行任务数据库。

## 1. Files（5个）

```js
list_files({path?})
read_file({path,offset?,limit?})
write_file({path,content,createExclusive?,expectedHash?})
edit_file({path,oldText,newText,expectedHash})
export_file({path})
```

- 用户需要显式启用 Files。目录由宿主绑定 APP_DATA_DIR/agent-files/<已授权workspaceId>，不是服务器源码、Linux home 或用户指定任意根路径。
- list/read 不执行写入；write/edit 使用现有 durable approval 机制，审批卡明确标为 Workspace file change，显示准确路径、内容/修改和hash；拒绝/取消不得写入。
- 新文件明确 createExclusive:true，原子 no-clobber 创建；已有文件必须提交 read_file 返回的 sha256。批准后再次检查，使用原子临时文件与锁，拒绝过期编辑。
- 文件仅UTF-8，写入最多16000 UTF-16字符、文件最多64000字节；一次edit的old/new各8000字符，oldText必须恰好出现一次。read以Unicode code point计offset/limit，列表最多200项。
- 拒绝遍历、绝对路径、符号链接、硬链接、非普通文件、secret/credential/私钥等路径或内容；不提供删除或任意二进制访问。
- export_file 写入真正的私有附件存储。文件结果通过 generated_file 事件进入最终assistant消息的 attachments，页面显示已有受鉴权下载链接，而不是让模型编造URL。此前table export与browser截图也复用这条真实附件链路（最多8个/消息）。
- 不会自动把上传附件拷贝进scratch，也不会通过Files读取服务端仓库。授权上传文件仍用既有workspace资源读取接口。

## 2. Skills（2个）：服务器安装脚本，不执行任意技能文档

```js
list_skill_scripts({})
run_skill_script({skillId,entrypoint,args})
```

- 必须有可信服务器catalog并显式开启 Skills。没有catalog时不暴露执行工具；普通workspace技能Markdown不赋予代码执行权。
- catalog固定id/version/entrypoints、绝对解释器、root相对脚本、固定argv和输入args策略、credential ID/envname及timeout。模型不能传manifest、root、解释器或endpoint。
- run先提交准确命令、cwd、timeout、脚本SHA-256的审批，批准前不取凭据、不spawn；执行前重验脚本path/hash。一次审批executor只可使用一次。
- 真实spawn shell:false，固定最小env，仅注入声明所需的凭据。拒绝危险环境变量覆盖。stdout/stderr合计64KiB，收集后跨chunk脱敏，超限丢弃输出并杀进程组；取消/超时/非零退出均有真实状态。
- 同步受管执行归属于父run，不创建单独skill task DB，不承诺后台恢复或完整操作系统沙箱。批准的可信脚本具有运行用户的系统权限，不应安装不可信代码。
- 本版凭据由可信host的 skillCredentialProvider 提供；尚无用户界面凭据保险库、workspace脚本安装/编辑/版本发布流程。不能称已完整复刻RunWithCredentials平台。

### 显式安装无凭据示例

仓库自带 examples/skills/inspect-json.mjs 与 catalog.json，只是可选样例，不自动启用。操作者确认需要后，可在自己的服务器配置设置：

```dotenv
APP_SKILL_ROOT=/home/ubuntu/hyperagents
APP_SKILL_CATALOG=/home/ubuntu/hyperagents/examples/skills/catalog.json
```

然后按原方式重载服务，在Tools选择Skills。示例调用：

```json
{"skillId":"inspect-json","entrypoint":"summarize","args":["{\"name\":\"Example\",\"items\":[1,2]}"]}
```

只总结argv JSON，不读主机文件、不联网。APP_SKILL_CATALOG必须是明确的绝对路径，解析失败即停止，不静默换catalog。不要把实际密钥放进catalog或聊天。Docker部署需显式挂载自己的安装root/catalog；默认镜像不假定打包了examples。

## 3. Delegation（4个）：真实子run与独立线程

```js
list_agents({})
delegate_agent({agentId,task})
get_delegated_run({runId})
wait_for_delegated_run({runId,timeoutSeconds?})
```

- 显式开启 Delegation，目标必须是当前workspace已有且未归档的agent。list返回真实元数据，不创建或虚构同事；缺目标明确失败。
- task是自包含任务，host原子保存一条新子线程用户消息，再创建真实durable子run。无父完整history、附件、连接或凭据暗中继承。
- 第一版继承候选仅 Thread Search、Search、Find Similar，取根run admission-time权限与目标agent.tools交集；子run同时带可信readOnly/allowedTools，最终registry与dispatch强制过滤。不能写Artifacts/Files、用Shell/Skills、调用集成或再委派。
- 相同父run+agent+task重试幂等；每父最多8children，tree32，单层模型委派，候选agent变更/归档重新检查。公开create请求不能伪造私有delegation metadata。
- 根worker并发仍为配置值，另有最多2个子worker，避免父任务等待占满所有槽位；总模型并发有界于root+2。
- get/wait只读直属子run，返回真实durable文本（最多12000字符）和status/resultSaved，未完成不冒充成功；wait一次最多30秒，事件等待，不busy polling。
- 父取消递归取消运行/排队子任务；重启标interrupted不重放。沿用既有lineage列及request JSON，无新增DB schema迁移。
- 页面显示子任务状态和子线程入口，可刷新而不重跑。子线程的只读约束属于该委派run；用户后来在此线程显式新发直接任务是独立授权，不是子run提权。

## 4. 主线接线

- agent-runs扩展可信 approveAndRun 回调，沿用现有approval ID、decision API、pending/denied/expired、run cancellation和事件游标；File/Skill与Shell卡片有不同标签。HTTP只接收approve/deny，不接受修改执行内容。
- Files根与附件持久化按workspace绑定；技能根和catalog由服务器配置；委派host回调在保存工作区时做正常revision/CAS验证。
- LLM只读边界过滤最后的工具definitions和dispatch，不只在提示词里说“只读”；不绑定集成、Shell、Files、Skills或递归委派。
- Composer、Agent工具选择、线程配置、运行审批和子任务面板补齐；默认不开新权限，必须用户显式选择。
- 原有未提交的media-maps/moli-browser-session等文件保留不改。未修改用户项目/消息、未自动安装技能、未改认证、未使用真实模型或外部凭据跑测试。

## 5. 验证口径

三个独立模块各6项关键测试，主线3项真实本地HTTP/SQLite流程测试：Files审批前零写入、批准后的文件/导出下载；Skills批准后才取合成凭据并脱敏；真实子线程创建、子模型执行、read-only伪造写工具拒绝及父结果保存。均使用临时工作区和合成模型，不是生产DeepSeek/Exa往返。

最终整体回归、构建与开发服务状态另追加本轮实际结果。代码修改不等于已安装任何真实skill或已替用户创建agent。

## 本轮最终验证

- 整体后端323/323通过，约6.5秒；本批新增21项关键测试。
- Typecheck与Vite production build通过，约2.2秒；仍有约635KB前端chunk警告。
- 原有三个参考checkout的HEAD与工作树状态保持不变，架构边界检查通过。
- 三条主线HTTP集成测试证明真实临时SQLite状态、审批前零写入/零凭据读取、批准后执行、私有文件下载、真实子模型与保存线程；模型和凭据均为合成数据。
- 无进行中的运行时已重载现有hyperagents-web.service，API/session HTTP200、ActiveState=active、NRestarts=0。未更改服务配置、账号、真实项目数据或安装catalog。
- 代码未commit/push；备份位于 /tmp/hyperagents-batch3-backup-uf36htfe。
