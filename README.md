<div align="center">

# 澄川银行智能体 · Chengchuan Banking Agent

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2024-4a6cf7?style=flat-square&logo=nodedotjs&logoColor=white) ![React](https://img.shields.io/badge/React-19-4a6cf7?style=flat-square&logo=react&logoColor=white) ![Express](https://img.shields.io/badge/Express-5-4a6cf7?style=flat-square&logo=express&logoColor=white) ![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-4a6cf7?style=flat-square&logo=sqlite&logoColor=white) ![测试](https://img.shields.io/badge/%E6%B5%8B%E8%AF%95-426%20%E9%A1%B9%E9%80%9A%E8%BF%87-22a06b?style=flat-square) ![2026 深圳国际金融科技大赛](https://img.shields.io/badge/2026%20%E6%B7%B1%E5%9C%B3%E5%9B%BD%E9%99%85%E9%87%91%E8%9E%8D%E7%A7%91%E6%8A%80%E5%A4%A7%E8%B5%9B-%E5%8F%82%E8%B5%9B%E4%BD%9C%E5%93%81-e5484d?style=flat-square)

### 一句话办业务，每一步都在安全框架之内

可以直接运行的中文手机银行模拟器，内置一个能办业务的银行 AI 智能体。

<img src="docs/images/hero.jpg" alt="六台手机并排展示首页、账单分析、可信页面核对、理财、跨场景联动和决策链路" width="100%">

[**演示视频**](#演示视频) &nbsp;·&nbsp; [**五分钟上手**](#五分钟上手) &nbsp;·&nbsp; [**演示指南**](docs/DEMO_GUIDE.md) &nbsp;·&nbsp; [**部署说明**](docs/DEPLOYMENT.md)

<sub>2026 深圳国际金融科技大赛 · 人工智能赛道参赛作品 · 团队：磐石金策（邹思瑞、万锦奇）</sub>

</div>

客户用一句话发起转账、分析账单、配置理财、管理卡片和订阅，或者让它把几件事串成一个按期执行的计划。**模型负责听懂和规划，服务端规则负责把关，最后由客户在 App 里确认。** 权限级别由服务端按金额和操作类型判定，模型改不了；聊天里永远不能直接动钱。

> 资金、交易、人脸和短信验证都是模拟的，不连接任何真实银行。两个公开演示账户的流水来自团队成员本人的对账单，个人姓名已替换为化名，详见 [演示数据](docs/DATA.md)。基金净值和业绩来自东方财富公开数据。

## 演示视频

<!-- 演示视频：在 GitHub 网页上编辑本文件，把 Chengchuan-Banking-Agent-demo-720p.mp4 拖到这一行，生成的链接单独占一行就会显示成播放器。 -->

4 分 26 秒，依次介绍六大场景、飞书和微信渠道、记忆与安全防护，画面均为真实运行截图。

## 界面一览

<table>
<tr>
<td width="50%"><img src="docs/images/scene-bill.jpg" alt="账单分析：月度账单、分类占比和数据来源"></td>
<td width="50%"><img src="docs/images/scene-transfer.jpg" alt="智能转账：三级权限，超过一千元需要模拟人脸、短信和支付密码"></td>
</tr>
<tr>
<td align="center"><b>账单分析</b>：月报和分类占比由服务端按流水计算，每条回答标明数据来源</td>
<td align="center"><b>智能转账 · 权限分级</b>：确认前钱不动，大额需要加强验证</td>
</tr>
<tr>
<td><img src="docs/images/scene-wealth.jpg" alt="理财：真实基金数据、风险匹配拦截和产品对比"></td>
<td><img src="docs/images/scene-plan.jpg" alt="跨场景联动：生日计划拆成四步，授权一次后按期执行"></td>
</tr>
<tr>
<td align="center"><b>理财操作</b>：接入真实基金数据，超出测评等级的产品会被拦下</td>
<td align="center"><b>跨场景联动</b>：一句话拆成带依赖的计划，可中断或转人工</td>
</tr>
<tr>
<td><img src="docs/images/scene-channels.jpg" alt="飞书和微信真机截图：查账单、提议转账，确认只能回 App"></td>
<td><img src="docs/images/scene-safety.jpg" alt="安全防护：故障注入下，模型谎称转账成功被服务端纠正"></td>
</tr>
<tr>
<td align="center"><b>飞书、微信</b>：聊天里查账单、提议转账，确认只能回 App</td>
<td align="center"><b>安全防护</b>：注入防御、幻觉纠正、决策链路可追溯</td>
</tr>
</table>

## 五分钟上手

需要 Node.js 24 或更新版本。

```sh
npm ci
npm run dev        # 打开 http://127.0.0.1:5173
```

不配置任何密钥，银行的全部页面都能用。要用智能助手，把 `.env.example` 复制为 `.env`，填写 `CHAT_API_KEY`（OpenAI 兼容、支持函数调用的模型，示例为 DeepSeek），然后重启。

登录页已预填演示账户：

| 用户 | 手机号 | 登录密码 | 支付密码 |
| --- | --- | --- | --- |
| 邹瑞 | 18662995523 | Bank123456 | 123456 |
| 万奇 | 15040147842 | Bank123456 | 123456 |

点底部导航正中的「智能助手」，同意三份协议后即可对话。各场景的试用步骤见 [演示指南](docs/DEMO_GUIDE.md)。

其他命令：

```sh
npm test                    # 426 项自动化测试，不需要密钥和网络模型
npm run build && npm start  # 生产模式，http://127.0.0.1:3000
```

服务器部署见 [部署说明](docs/DEPLOYMENT.md)。

## 赛题六大场景

| 场景 | 能做什么 | 试一句 |
| --- | --- | --- |
| 智能转账 | 按人名、手机号、卡号识别收款人，先生成转账草稿，在可信页面核对后授权；定时转账、AA 收款 | 帮我给万奇转200元，备注聚餐 |
| 账单分析 | 日报、周报、月报、年报；按分类、商户、平台、时间统计；异常交易；隐形消费 | 2026年10月我的钱都花在哪了？ |
| 理财操作 | 99 只公募基金的真实净值和业绩；风险测评；按收支给出配置方案；产品对比；模拟申购赎回 | 我有两万元闲钱，一年内可能要用，帮我看看怎么配置 |
| 卡片管理 | 虚拟卡、冻结、限额调整、挂失 | 帮我申请一张虚拟卡，额度500元 |
| 订阅代扣 | 列出按月扣费的订阅，到期前提醒，帮你取消 | 我现在有哪些订阅在扣费？ |
| 跨场景联动 | 一句话拆成带依赖关系的计划，授权一次后按期执行，执行前复核，可中断或转人工 | 下周五是我妈生日，帮我锁定800元预算，当天订鲜花和蛋糕各400元，提前一天提醒我确认 |

另外，飞书和微信里也能查账单、提议转账，但确认只能回到 App 完成。账单日报、周报、月报可以定时推送。

## 安全设计

| 级别 | 适用操作 | 客户需要做什么 |
| --- | --- | --- |
| 可直接办理 | 查询、账单报告、产品对比、消费统计 | 无需确认 |
| 需授权确认 | 当日累计一千元以内的转账和缴费、AA、虚拟卡、冻结、取消订阅、查看订阅明细 | 在 App 内输入支付密码 |
| 需加强验证 | 超过一千元、理财申购、贷款提款、卡片挂失、修改密码、调高限额 | 模拟人脸 + 模拟短信验证码 + 支付密码 |

- **权限在服务端判定**：`server/agent/policy.mjs` 按操作和当日累计金额分级，模型只能提议。
- **直接注入**：识别“忽略之前的指令”一类话术，拒绝并记入审计，连续触发锁定助手 30 分钟。
- **间接注入**：转账附言等第三方文字含有指令时，发给模型前替换为“[第三方内容已隐藏]”。
- **幻觉防护**：模型声称办成了但没有回单时，服务端要求它纠正，仍不对就替换回复。
- **可追溯、可停止**：每轮工具调用写入决策链路，客户可以一键停止助手并撤销所有未执行的授权。

## 功能状态

| 功能 | 状态 |
| --- | --- |
| 三级权限、确认与加强验证、注入防御、幻觉防护、审计、沙箱分析 | 开启 |
| 个性化记忆（称呼、偏好，可查看、修改、删除） | 开启 |
| 语音输入、飞书、微信、邮箱验证码 | 配置对应密钥后开启 |
| 记忆 v2、行为模型、诈骗风险评分、年龄保护 | 观察模式：只记录，不影响结果 |
| 自适应认证、委托审批、动态策略、问候个性化 | 关闭（`server/puma/policy.json`） |

## 架构

图中 ①～⑥ 是智能体处理一条消息的六个环节，橙色是输入和输出两道防护，绿色是服务端规则：权限只由服务端判定，模型改不了。

```mermaid
flowchart TB
  classDef client fill:#eef2ff,stroke:#4a6cf7,color:#1a2036
  classDef gate fill:#1a2036,stroke:#1a2036,color:#ffffff
  classDef agent fill:#ffffff,stroke:#4a6cf7,color:#1a2036
  classDef guard fill:#fff4ec,stroke:#ff7a2f,color:#1a2036
  classDef rule fill:#ecfdf3,stroke:#22a06b,color:#1a2036
  classDef core fill:#ffffff,stroke:#8a93a8,color:#1a2036
  classDef data fill:#f3f5fb,stroke:#566078,color:#1a2036
  classDef ext fill:#ffffff,stroke:#8a93a8,stroke-dasharray:4 3,color:#566078

  subgraph L1["接入层"]
    direction LR
    APP["手机银行 App<br/>React 19 · Vite 7<br/>银行页面 · 智能助手 · 可信核对页"]
    IMC["飞书 · 微信<br/>共享与专属机器人 · ClawBot"]
    API["外部程序<br/>OpenAPI 3.1 · 能力清单"]
    APP ~~~ IMC ~~~ API
  end

  GW["服务入口 · Express 5 · server/app.mjs<br/>会话认证 · 来源校验 · 限频 · 幂等键 · 资源归属校验 · HTTPS 由反向代理提供"]

  subgraph L2["智能体运行时 · server/agent/"]
    direction LR
    G1["① 输入防护<br/>guard.mjs<br/>话题闸门 · 注入检测<br/>第三方文字过滤 · 号码脱敏"]
    G2["② 上下文组装<br/>context-assembler<br/>模块化记忆 · 9 个金融 Skills"]
    G3["③ 意图理解与规划<br/>agent.mjs · inference.mjs<br/>函数调用，每轮最多 6 次工具往返"]
    G4["④ 工具<br/>tools.mjs<br/>只读查询 · 提议 · 联动计划<br/>沙箱分析 QuickJS WASM"]
    G5["⑤ 输出防护<br/>幻觉检测：无回单的成功说法<br/>先纠正、再替换"]
    G6["⑥ 决策链路<br/>agent_runs<br/>输入 · 注入标记 · 工具调用"]
    G1 --> G2 --> G3 --> G5 --> G6
    G3 <--> G4
  end

  subgraph L3["权限与执行 · 服务端判定，模型不能更改"]
    direction LR
    P1["权限分级<br/>policy.mjs<br/>可直接办理 / 需授权确认 / 需加强验证<br/>按操作类型和当日累计 1,000 元"]
    P4["风控<br/>server/risk/<br/>转账草稿 · 首次收款提示<br/>加强验证 / 人工复核 / 拦截"]
    P2["动作与计划<br/>agent_actions · agent_plans<br/>15 分钟内确认 · 计划按依赖执行"]
    P3["确认与验证<br/>authorization · verify<br/>客户在 App 可信页面确认<br/>支付密码 · 模拟人脸 + 短信验证码"]
    P1 --> P2 --> P3
    P4 --> P3
  end

  subgraph L4["银行业务 · 确定性计算"]
    direction LR
    B1["账户与交易<br/>services.mjs<br/>转账 · 卡片 · 订阅代扣 · 缴费 · 贷款"]
    B2["账单分析<br/>analytics.mjs<br/>消费口径 · 分类 · 统计 · 异常"]
    B3["理财<br/>wealth · products<br/>风险测评 · 配置建议 · 净值计息"]
    B4["渠道<br/>server/channels/<br/>消息队列 · 结果回推 · 定时报告"]
    B1 ~~~ B2 ~~~ B3 ~~~ B4
  end

  DB[("SQLite · node:sqlite<br/>账户与流水 · 会话与动作 · 授权记录 · 订阅 · 渠道 · 只追加的审计日志")]

  EXT["外部服务 · 均可不配置<br/>聊天模型（OpenAI 兼容）· 百炼语音识别<br/>东方财富 · 腾讯基金与行情数据 · 飞书开放平台 · 微信 iLink"]

  L1 --> GW
  GW -- 智能助手 --> L2
  L2 -- 提议动作 --> L3
  L3 -- 确认后在一个事务内执行 --> L4
  GW -- 银行页面直接办理 --> L4
  L2 -. 只读查询 .-> L4
  L4 --> DB
  L3 --> DB
  L2 -- 决策链路 --> DB
  L2 <-. 模型调用 .-> EXT
  L4 <-. 基金数据 · 渠道消息 .-> EXT

  class APP,IMC,API client
  class GW gate
  class G2,G3,G4,G6 agent
  class G1,G5 guard
  class P1,P2,P3,P4 rule
  class B1,B2,B3,B4 core
  class DB data
  class EXT ext
```

### 一句话转账的处理过程

```mermaid
sequenceDiagram
  autonumber
  actor U as 客户
  participant C as App · 飞书 · 微信
  participant A as 智能体运行时
  participant M as 聊天模型
  participant R as 权限与风控
  participant B as 银行核心 · SQLite

  U->>C: 帮我给万奇转200元，备注聚餐
  C->>A: 进入该客户的执行队列，App 与 IM 串行处理
  A->>A: 输入防护：话题闸门、注入检测、号码脱敏
  Note over A: 命中注入特征时拒绝并记入审计，连续触发锁定 30 分钟
  A->>M: 系统指令 + 记忆 + Skills + 过滤后的上下文
  M-->>A: 调用 resolve_recipient
  A->>B: 只读查询收款人
  B-->>A: 万奇 · 尾号 2169
  M-->>A: 调用 create_transfer_draft，200 元
  A->>R: 按操作类型和当日累计金额分级
  R-->>A: 需授权确认；首次向该账户付款，提示核对
  R->>B: 写入转账草稿，钱没动
  M-->>A: 生成回复
  A->>A: 输出防护：没有回单却说已转账，先纠正、再替换
  A-->>C: 回复 + 草稿卡片，附可信核对页链接
  U->>C: 在 App 可信核对页核对并输入支付密码
  Note over U,R: 超过 1,000 元还需要模拟人脸和短信验证码
  C->>R: 提交授权
  R->>B: 一个事务内双边记账，生成回单
  B-->>C: 完成；飞书或微信发起的，结果回推到聊天
  Note over A,B: 每一步写入决策链路和审计日志，客户可一键停止并撤销未执行的授权
```

各环节的细节见 [智能体设计](docs/AGENT.md)。

## 测试

`npm test` 运行 426 项测试，覆盖六大场景、三级权限、注入防御、幻觉防护、记忆、渠道和风控。测试使用脚本化的假模型，所以证明的是服务端在任何模型输出下都守得住边界，而不是模型本身的理解能力。场景与测试的对应关系、本次运行结果和已知缺口见 [测试说明](docs/TESTING.md)。

## 文档

- [演示指南](docs/DEMO_GUIDE.md)：评委按场景试用的步骤和提示词
- [部署说明](docs/DEPLOYMENT.md)：本地运行、生产模式、单机部署、环境变量
- [测试说明](docs/TESTING.md)：运行方法、场景对应、测试报告
- [智能体设计](docs/AGENT.md)：开通、权限、确认、安全、记忆、语音、渠道
- [演示数据与账单口径](docs/DATA.md)：数据来源与处理、统计规则、业务边界
- [API 说明](docs/API.md)：接口、OpenAPI、外部程序接入
- 专题：[人脸核身](docs/FACE.md)、[短信](docs/SMS.md)、[本地验证流程](docs/LOCAL_VERIFY.md)、[金融 Skills](docs/FINANCIAL_SKILLS.md)、[记忆架构](docs/MEMORY_ARCHITECTURE.md)、[风控](docs/risk-mvp/OPERATIONS.md)

## 目录

```
src/        前端页面与智能助手界面
server/     服务端：银行业务、智能体、风控、渠道、种子数据
tests/      自动化测试（node:test）
scripts/    测试运行器、演示与检查脚本、种子数据生成
docs/       文档；docs/images/ 截图
deploy/     部署脚本（本团队服务器的自动部署流水线）与通用模板 deploy/examples/
examples/   外部程序调用示例
```

## 许可

本作品不是开源软件。知识产权归参赛选手所有，主办方的使用权见 [LICENSE](LICENSE)。第三方组件按其各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
