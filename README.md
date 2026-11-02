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

https://github.com/user-attachments/assets/7b9d232c-fd62-47f1-bafb-f0e73e5c057d

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

```mermaid
flowchart TB
  subgraph ACCESS["接入层"]
    direction LR
    A1["手机银行 App<br/>银行页面 · 智能助手"]
    A2["飞书机器人<br/>共享与专属机器人"]
    A3["微信 ClawBot<br/>iLink 长轮询"]
    A4["外部程序<br/>OpenAPI 3.1 · 能力清单"]
    A1 ~~~ A2 ~~~ A3 ~~~ A4
  end

  GW["服务入口 · Express 5<br/>认证 · 来源校验 · 限频<br/>幂等键 · 资源归属校验"]

  subgraph AGENT["智能体运行时 · 理解与规划"]
    direction LR
    S1["① 输入防护<br/>话题闸门 · 注入检测"] --> S2["② 上下文组装<br/>记忆 · 9 个金融 Skills"] --> S3["③ 意图理解与规划<br/>函数调用 · 工具循环"] --> S4["④ 输出防护<br/>幻觉检测 · 先纠正再替换"] --> S5["⑤ 决策链路<br/>每轮输入与工具调用"]
  end

  FENCE["安全边界：模型只能提议<br/>权限由服务端判定<br/>资金操作须在 App 内确认"]

  subgraph RULES["规则层 · 服务端判定"]
    direction LR
    R1["权限分级 · 三级<br/>按操作和当日金额判定"]
    R2["确认与加强验证<br/>支付密码 · 人脸 · 短信"]
    R3["风控<br/>转账草稿 · 复核 · 拦截"]
    R1 ~~~ R2 ~~~ R3
  end

  subgraph BIZ["业务层 · 确定性计算"]
    direction LR
    B1["账户与转账<br/>行内 · 跨行 · 定时 · AA"]
    B2["账单分析<br/>报告 · 统计 · 异常"]
    B3["理财<br/>真实基金 · 风险匹配"]
    B4["卡片与订阅<br/>虚拟卡 · 挂失 · 代扣"]
    B5["渠道推送<br/>结果回推 · 定时报告"]
    B1 ~~~ B2 ~~~ B3 ~~~ B4 ~~~ B5
  end

  DB[("SQLite<br/>账户流水 · 动作计划<br/>授权记录 · 审计日志")]

  subgraph EXT["外部服务 · 均可不配置"]
    direction LR
    E1["大模型 · OpenAI 兼容"] ~~~ E2["百炼语音识别"] ~~~ E3["东方财富 · 基金数据"] ~~~ E4["飞书 · 微信开放平台"]
  end

  ACCESS --> GW
  GW -- 智能助手 --> AGENT
  AGENT --- FENCE
  FENCE -- 提议 --> RULES
  RULES -- 确认后执行 --> BIZ
  BIZ --> DB
  DB ~~~ EXT

  classDef access fill:#eef2ff,stroke:#c9d4fb,color:#1a2036
  classDef gate fill:#1a2036,stroke:#1a2036,color:#ffffff
  classDef guard fill:#fff4ec,stroke:#ffb98a,color:#1a2036
  classDef step fill:#ffffff,stroke:#c9d4fb,color:#1a2036
  classDef fence fill:#ffffff,stroke:#ff7a2f,color:#c2410c,stroke-dasharray:6 4
  classDef rule fill:#ecfdf3,stroke:#a7e3c3,color:#1a2036
  classDef biz fill:#ffffff,stroke:#d5dae6,color:#1a2036
  classDef data fill:#ffffff,stroke:#8a93a8,color:#1a2036
  classDef ext fill:#ffffff,stroke:#b8bfcc,color:#566078,stroke-dasharray:5 4
  class A1,A2,A3,A4 access
  class GW gate
  class S1,S4 guard
  class S2,S3,S5 step
  class FENCE fence
  class R1,R2,R3 rule
  class B1,B2,B3,B4,B5 biz
  class DB data
  class E1,E2,E3,E4 ext
  style ACCESS fill:#f6f8fd,stroke:#e6eaf3,color:#1a2036
  style AGENT fill:#f6f8fd,stroke:#e6eaf3,color:#1a2036
  style RULES fill:#f6f8fd,stroke:#e6eaf3,color:#1a2036
  style BIZ fill:#f6f8fd,stroke:#e6eaf3,color:#1a2036
  style EXT fill:#f6f8fd,stroke:#e6eaf3,color:#1a2036
```

智能体负责理解和规划，只能提出动作；安全边界以下的规则层由服务端判定权限，资金操作须客户在 App 内确认后，才由业务层在一个 SQLite 事务内执行。银行页面上的操作不经过智能体，同样要输入支付密码，重要操作同样要加强验证。各环节的细节见 [智能体设计](docs/AGENT.md)。

### 一句话转账的处理过程

客户说一句“帮我给万奇转200元，备注聚餐”之后，各部分依次做了什么。`opt`、`alt` 框里是只在特定情况下才发生的分支。

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
  opt 命中注入特征
    A->>B: 记入审计；15 分钟内 3 次则锁定助手 30 分钟
    Note over A: 本轮不学习记忆，并要求模型只按原有权限处理
  end
  A->>M: 系统指令 + 记忆 + 金融 Skills + 过滤后的上下文
  loop 工具循环 · 每轮对话最多 6 次模型调用
    M-->>A: 调用 resolve_recipient
    A->>B: 只读查询收款人
    B-->>A: 万奇 · 尾号 2169
    A->>M: 返回查询结果
    M-->>A: 调用 create_transfer_draft · 200 元
    A->>R: 提交转账草稿
    R->>R: 按操作类型和当日累计金额分级；检查首次收款、金额偏离
    R->>B: 写入草稿，15 分钟内有效，钱没动
    R-->>A: 需授权确认 · 首次向该账户付款
    A->>M: 返回草稿状态
  end
  M-->>A: 生成回复
  opt 回复声称已办成，但没有回单
    A->>M: 要求纠正
    M-->>A: 重新回答
    Note over A: 仍不对，就替换为“本轮没有执行银行写操作”
  end
  A-->>C: 回复 + 草稿卡片 + 可信核对页链接
  Note over U,C: 飞书、微信里只能取消，确认必须回到 App
  U->>C: 打开可信核对页，核对收款信息
  alt 当日累计不超过 1,000 元
    U->>C: 输入支付密码
  else 超过 1,000 元
    U->>C: 模拟人脸 + 短信验证码 + 支付密码
  end
  C->>R: 提交授权，服务端复核草稿、余额与额度
  R->>B: 一个事务内双边记账，生成回单
  B-->>C: 转账完成
  opt 从飞书或微信发起
    C-->>U: 结果回推到聊天
  end
  Note over A,B: 每轮输入、注入标记和工具调用都写入决策链路；客户可一键停止，撤销所有未执行的授权
```

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
