# 并行实现第二批：Slides、Exa、线程与文档工具

2026-10-30。三条并行代码线，主线统一接入模型循环、权限、持久化和 UI。新增 8 个模型工具；不是把全部 Hyperagent 工具宣称实现。

## 1. Slides：独立产物而非 Webpage 别名

```js
publish_slides({
  title: 'Presentation title',
  slides: [{ title: 'Slide title', body: 'Plain text\n• Bullet', notes: 'Optional notes' }]
})
```

- 仅在 Slides 开关启用时暴露；返回 prepared 的真正 kind=Slides 产物，托管 run 成功后由服务器保存。
- 1–40 页。title 最多240字符、每页body6000、notes4000；本工具沿用100000字符/256000字节 patch 总预算，超限原子拒绝。结构化存储格式是 `{title,slides}` JSON，不接收任意HTML/脚本。
- 1280×720固定画布；按钮、方向键、圆点、页码、50px触摸滑动、Esc/父窗口导航消息。
- 前后端使用同一个纯渲染器 server/slides.mjs；文本全部转义。只运行固定的导航脚本，CSP用确切SHA-256 hash授权。
- 专门的opaque-origin sandbox allow-scripts，不加allow-same-origin；不放宽既有Webpage预览的script-src none。静态父页面CSP只增加同一固定脚本hash，处理srcdoc继承策略，未开放unsafe-inline脚本。
- Library过滤/预览/JSON编辑/版本/下载.html、共享快照、线程Canvas、导入校验均识别新kind。
- notes虽然隐藏在展示中，仍是产物数据的一部分；导出/分享选中的Slides会包含notes。没有自动宣讲、PDF/PPTX导出、任意HTML版式或AI图片生成。

更新产物可用现有update_artifact；只有同线程和已启用Slides可修改，当前与历史JSON必须有效。

## 2. Exa：三个真实可配置的HTTP适配器

```js
exa_search({ query, numResults?, text?, highlights?, includeDomains?, excludeDomains?, startPublishedDate?, endPublishedDate? })
exa_contents({ urls, text?, highlights?, maxAgeHours? })
exa_find_similar({ url, excludeSourceDomain?, numResults?, text?, highlights?, includeDomains?, excludeDomains?, startPublishedDate?, endPublishedDate? })
```

- Search开关启用search+contents；Find Similar是独立开关。缺EXA_API_KEY不暴露任何Exa definitions，不匿名降级，不伪造结果。
- 受信服务器配置捕获EXA_API_KEY并从子进程环境移除；模型只看到工具schema，不看到key。没有读取或展示现有用户凭据，没有为测试创建付费请求。
- 固定HTTPS api.exa.ai，分别POST /search、/contents、/findSimilar。参数按Exa官方文档及官方OpenAPI核实，不照猜测工具清单实现。
- 最多10搜索结果、5输入URL；默认5结果、highlights开、全文关。完整schema和来源见EXA-TOOLS.md。
- 12秒统一deadline覆盖fetch及body；禁止redirect；响应≤1MiB，投影JSON≤20000字节（兼容模型工具结果预算），保留来源URL/检索时间、截断/部分成功状态；错误脱敏，不回传原始错误页/headers。
- 模拟传输覆盖接线；没有真实Exa账户往返验证。configured仅表示服务配置存在，不保证key有效、配额或网络可用。
- Exa Research/Websets、Standard搜索、Image search仍未实现。

## 3. 线程与文档：四个具体操作

```js
search_threads({ query, limit? })
get_thread_messages({ thread_id, offset?, limit? })
read_document({ id, version_index? })
update_document_section({ id, section_name, operation: 'append'|'prepend'|'replace', content })
```

- 前两项只由Thread Search启用；后两项只由Documents启用。严格参数，不借一个开关增加另一类执行权。
- 查找只在当前已授权workspace，过滤archived/excluded/isSearchable=false等不应检索记录。返回投影字段，不输出message.context、配置或整个保存对象。
- get_thread_messages使用offset/limit和next_offset分页，role/text/id/createdAt投影；单条4000、正文合计12000字符并额外控制JSON结构总量。被截断的单条长消息不会通过offset恢复剩余文本；需要全文可用既有resource_read_page。
- read_document只读Document，不把Webpage当文档；version_index为零基历史数组索引，省略读当前版；正文最多12000字符。
- update_document_section只改当前thread拥有的Document。以唯一Markdown标题定位，支持ATX/setext标题并忽略围栏代码中的假标题。操作正文包含其子章节，直到下一个同级或更高标题；保留选中标题与其他段落。
- 标题找不到或重复时明确失败，不退回整篇替换；复用版本、原始CAS base、100000 UTF-8字节文档限制和patch预算，失败不改变已有staged overlay。
- 跨线程读取遵循现有workspace授权；跨线程修改禁止。本批没有新的跨workspace共享、语义向量索引或全文消息游标协议。

## 4. 变更与验证边界

- 不新增依赖、不启动新常驻服务、不移动三个参考checkout、不改数据库结构或认证，不commit/push。
- 现有未提交media-maps/moli-browser-session等模块原样保留。
- 每条并行线4–6项关键测试，主线增加两项模型循环接线测试；最后做一次整体后端回归和生产构建，不扩展大测试工程。
- 测试中的模型/Exa transport是假provider，不等于真实DeepSeek或Exa生产调用。Slides导航脚本有VM行为测试；若本机已安装Chromium则补一次真实iframe/CSP导航smoke，不安装或替换浏览器。

实际完成结果以本轮最终命令日志/后附验证记录为准。运行中服务未自动重载，新代码需按原启动方式重新加载后生效。

## 最终验证记录

- 300/300后端测试通过，约4.6秒；首次回归发现一条旧测试把Thread Search可用工具固定为旧三项，已更新为包含新增两项，权限断言未削弱。
- Typecheck和Vite production build通过；仍有约631KB前端chunk警告。
- 已安装的Chromium真实smoke通过：继承父CSP的opaque iframe中Next按钮与方向键能导航；插入的脚本文字不执行。无新增浏览器安装。
- Exa使用模拟传输验证schema、脱敏、deadline及模型接线；未使用真实Exa账户或DeepSeek进行生产调用。
- 未重启服务、未改数据库/认证、未commit或push。备份位于 /tmp/hyperagents-batch2-backup-mvas11cw。
