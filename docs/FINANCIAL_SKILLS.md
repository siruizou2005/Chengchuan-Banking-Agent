# 第一批通用金融 Skill

2026-10-20：基于 Anthropic 官方 [financial-services](https://github.com/anthropics/financial-services) 仓库的三份 Skill，增加三个适合本项目的中文工作流。上游固定版本为 `574ed3624aebd0418c7e96cd101262f30210ab26`，Apache-2.0 许可原文、未修改的源文件及 SHA-256 清单保存在 `server/agent/skills/upstream/anthropic-financial-services/`。

这是应用 Agent 的 Skill 内容建设，不是给开发工具安装的插件。原有六个基础 Skill 保留，新版注册表共九个 Skill。

| 本地 Skill | 上游材料 | 触发示例 | 适配重点 |
| --- | --- | --- | --- |
| cashflow_reconciliation | fund-admin / gl-recon | 核对本月流水和交易、对账、重复扣款 | 账户/期间/金额单位统一，可靠标识匹配，金额/时间/单边差异，疑似原因不当结论 |
| budget_variance | fund-admin / variance-commentary | 本月支出为什么超过预算、比较实际与预算 | 同口径、预算缺失不当零、差额及比例、零基准处理、用流水解释变化 |
| product_comparison | financial-analysis / comps-analysis | 比较两款基金、对比存款产品 | 同类同期间、来源日期、过时数据、收益口径、费用/流动性/风险及不可比项 |

## 模型真正收到什么

新文件标记 `format: structured-v1`。`loader.mjs` 将整个本地工作流的 `instructions / inputs / sources / workflow / limits / output` 渲染为一段 system 指令，并附 Skill ID 和版本号；不再只加载新文件中的 instructions 一句。三段独立完整内容分别为 616、606、652 UTF-8 字节，均低于默认 900 字节的 Skill 总预算。

路由先选匹配的专项 Skill，再考虑原模块基础 Skill，每轮仍最多两个候选。总预算不足时整段跳过，不截断步骤或风险限制。因此常见专项任务默认加载一个完整的专项 Skill；不会承诺每次两个都能装下。已确认的会话承接语保留该专项选择，成功的 compare_products 工具调用也能触发产品比较 Skill。

原六个基础 Skill 仍按既有 instructions 方式加载。上游完整 Markdown 仅用于溯源和人工评审，不会被通配扫描或整份塞入 Prompt。当前“完整加载”指三个精简后的本地工作流，不代表已实现上游完整的机构级对账、企业估值或 Excel 工作簿生成。

## 业务与数据边界

- 只引用已登记的本人银行工具。账单/统计卡片仍遵循每轮数量限制；补充计算使用已有只读 run_analysis 沙箱，不执行上游脚本。
- run_analysis 只能读取本人银行数据；用户确认预算可作为明确标注的比较基准，不能伪装成银行已记录事实。比例分母为零时输出不可用，不填造出的百分比。
- 外部对账单未接入时，只能核对可获得的内部记录；没有第二来源或明细被截断时，不声称完成全部对账。
- 产品推荐继续由 wealth_advice 产生，比较 Skill 不自行挑选推荐、不修改风险测评、不绕过交易确认。
- 没有安装上游 MCP、Python/Office 脚本或商业数据连接。企业估值示例、默认重大性阈值、估值倍数范围等未移植到个人银行场景。
- 来源、版本与本地修改说明保存在独立清单中，不属于用户长期记忆；聊天内容和行为进化引擎不能修改 Skill。

## 更新和验证

更新时先固定新的上游 commit，逐份核对差异和许可，再修改本地适配、Skill version、来源校验值及测试。服务运行时不联网同步上游文件。正式部署需重启服务以清除 Skill 定义缓存。

运行 `node --test tests/financial-skills.test.mjs tests/modular-memory.test.mjs`，验证文件来源校验、工具白名单、专项触发与非触发、所有结构字段实际注入、完整字节预算、会话承接、成功工具重路由和普通 Agent 调用中零新增分类/总结请求。

本次没有改动数值业务引擎或接入外部金融数据。测试使用可控模型响应验证调用链，真实模型是否始终按工作流给出正确解释仍需上线前实测。

2026-10-20 验证结果：Node.js v24.21.0 下运行 `node --test --test-concurrency=2 tests/*.test.mjs`，全量 **196/196 通过，0 失败**，其中新增专项测试 5 项。日志位于 `test-results/financial-skills-full-tests.log`。本次没有修改前端，未重复运行浏览器验收或前端构建。
