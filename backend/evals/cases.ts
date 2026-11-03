export const CASE_VERSION = "research-delivery-1.0.0";
export const cases = [
  {
    id: "math-document-revision",
    sandbox: true,
    prompt:
      "生成一份中文数学练习文档和 PDF：6 道一元一次方程，按简单、中等、较难排列，每档两道；先列全部题目，所有答案与解题步骤统一放到末尾的“答案与解析”。写明难度。使用可渲染的中文字体。",
    formats: ["md", "pdf"],
    required: ["简单", "中等", "较难", "答案与解析"],
    tools: ["code_execute"],
    followup:
      "继续修改之前的文档与 PDF：在最前面加入“使用说明”，提醒先独立完成再查看答案；保留原题、解答及难度分组。更新原有产物版本。",
  },
  {
    id: "research-databases",
    research: true,
    prompt:
      "搜索并读取 PostgreSQL 与 SQLite 的官方文档，制作中文 Markdown 对比报告，解释单服务器多用户任务系统的并发写入和事务取舍。至少读取两个来源，正文保留出处 URL；不要声称运行了数据库性能测试。",
    formats: ["md"],
    required: ["PostgreSQL", "SQLite"],
    tools: ["web_search", "web_read"],
  },
  {
    id: "data-analysis-chart",
    sandbox: true,
    csv: "category,value\nA,12\nB,18\nA,8\nB,2\n",
    prompt:
      "读取上传的 CSV，必须运行 Python 计算各类别 value 合计，输出 result.csv 和 chart.png。A 和 B 应分别为 20 和 20；图表应与表格一致。",
    formats: ["csv", "png"],
    required: [],
    tools: ["file_read", "code_execute"],
  },
  {
    id: "markdown-brief",
    prompt:
      "写一份中文 Markdown 学习计划，标题“代数学习计划”，分成“第一周”“第二周”，每周给出目标、练习与自测。保存为真实文件。",
    formats: ["md"],
    required: ["代数学习计划", "第一周", "第二周"],
    tools: ["artifact_write"],
  },
  {
    id: "html-study-guide",
    prompt:
      "生成可离线打开的完整 HTML 页面，标题“方程复习卡”，解释 2x+3=11 的解题过程和答案 x=4。使用简洁 CSS，无外部脚本或字体依赖。",
    formats: ["html"],
    required: ["方程复习卡", "2x", "11"],
    tools: ["artifact_write"],
  },
  {
    id: "csv-cleaning",
    csv: "name,amount\nAlice,10\nBob,20\nAlice,5\n",
    prompt:
      "读取所附 CSV，按 name 合并 amount 并输出 totals.csv。只需输出数据，不要安装依赖。Alice 为 15，Bob 为 20。",
    formats: ["csv"],
    required: ["Alice", "15", "Bob", "20"],
    tools: ["file_read"],
  },
  {
    id: "json-structure",
    prompt:
      "生成一个 JSON 文件，包含 project 字段值“学习计划”，weeks 数组恰好两项，每项有 week 数字与 goals 字符串数组。另给简短说明。",
    formats: ["json"],
    required: ["学习计划", "weeks", "goals"],
    tools: ["artifact_write"],
  },
  {
    id: "document-version",
    prompt:
      "生成 Markdown 文档，标题“实验记录”，含“目标”“方法”“结果”三节；结果明确标注“尚未测量”，不要编造数据。",
    formats: ["md"],
    required: ["实验记录", "尚未测量"],
    tools: ["artifact_write"],
    followup:
      "修改之前的文档：在原有各节之后新增“下一步”，列出校准仪器、记录温度两项；沿用原有产物 ID 保存新版本。",
  },
  {
    id: "independent-research",
    research: true,
    prompt:
      "研究 Python 的 csv 标准库与 pandas.read_csv 的适用场景。两个官方文档可独立研究，必要时委派；搜索并读取两类官方来源，输出带出处 URL 的中文 Markdown 报告，明确依赖与内存限制。",
    formats: ["md"],
    required: ["csv", "pandas"],
    tools: ["web_search"],
  },
  {
    id: "printable-pdf",
    sandbox: true,
    prompt:
      "制作中文 PDF“数据核对清单”，含输入检查、计算复核、输出校验三节，每节三个复核项。要求中文可提取、字体嵌入且页面能渲染。",
    formats: ["pdf"],
    required: ["数据核对清单", "输入检查", "计算复核", "输出校验"],
    tools: ["code_execute"],
  },
  {
    id: "two-artifact-delivery",
    prompt:
      "生成一份 Markdown“采购比较”说明和 prices.csv。仅使用这些已知数据：甲产品 30 元，乙产品 45 元。说明价差 15 元，不搜索，不声称购买。两个文件都应真实保存。",
    formats: ["md", "csv"],
    required: ["甲", "乙", "30", "45"],
    tools: ["artifact_write"],
  },
  {
    id: "answer-order",
    prompt:
      "制作中文 Markdown 练习文档：题目区有 3 道分数计算题 1/2+1/3、3/4-1/2、2/3*3/5，分别编号 Q1、Q2、Q3；所有答案放到最后的“答案”章节，答案是 5/6、1/4、2/5。题目区不得出现答案。",
    formats: ["md"],
    required: ["Q1", "Q2", "Q3", "答案", "5/6", "1/4", "2/5"],
    tools: ["artifact_write"],
  },
] as const;
