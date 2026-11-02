# 测试说明

## 运行

```sh
npm test                                   # 全部 426 项，约 1～3 分钟
node --test tests/permissions.test.mjs     # 单个文件
node --test --test-name-pattern='注入' tests/agent-runtime.test.mjs   # 按名称筛选
```

- 需要 Node.js 24 或更新版本，以及开发依赖（`npm ci`）。
- 不需要任何密钥，也不访问外网模型：测试注入脚本化的假模型、假渠道传输层和可控时间。
- 测试运行器 `scripts/test.mjs` 对失败用例最多自动重跑两次。
- 部分测试会在 `test-results/` 写入临时数据库，所以项目目录需要可写。
- 每次 push 和 Pull Request，GitHub Actions（`.github/workflows/test.yml`，Node 24）会运行 `npm ci`、`npm test` 和 `npm run build`。

## 本次结果

2026-11-02，macOS，Node v26.8.2，代码为 v1.0.0：426 项全部通过，失败 0，用时约 34 秒。完整输出见 [test-report/2026-11-02-npm-test.txt](test-report/2026-11-02-npm-test.txt)。

## 赛题场景与测试的对应

| 场景或主题 | 测试文件 |
| --- | --- |
| 智能转账 | `bank`、`agent`、`permissions`、`risk-mvp` |
| 账单分析 | `analytics`、`bills`、`hidden-spend`、`merchant-categories`、`report-push` |
| 理财操作 | `wealth`、`earnings`、`products`、`bank` |
| 卡片管理 | `agent`、`permissions`、`bank`、`verify` |
| 订阅代扣 | `permissions`、`assistant-pause`、`agent`、`risk-mvp`、`demo-accounts` |
| 跨场景联动 | `agent`、`permissions`、`assistant-pause` |
| 权限分级 | `permissions`、`agent`、`verify` |
| 幻觉防护 | `agent`、`agent-runtime`、`onboarding` |
| 注入防御 | `agent`、`agent-runtime`、`chat`、`personalization`、`onboarding`、`modular-memory`、`sandbox` |
| 意图理解与规划 | `modular-memory`、`financial-skills`、`agent` |

文件都在 `tests/` 下，以 `.test.mjs` 结尾。其他测试覆盖记忆与个性化、飞书和微信渠道、语音、开通与协议、人脸和短信验证、风控与 PUMA 模块、演示数据。

## 这些测试能证明什么

测试用脚本化的模型输出驱动服务端，证明的是：不管模型说什么、调用什么工具，服务端都守得住权限、确认、注入过滤和幻觉纠正这些边界，资金账目始终平衡。它们不能证明某个真实模型能正确理解意图或做好规划，这需要用真实模型检查。

## 用真实模型检查

服务启动并配置好 `CHAT_API_KEY`，再用演示账户在 App 里开通智能助手，然后：

```sh
node --env-file=.env scripts/smoke-live.mjs http://127.0.0.1:5173   # 走一遍常用话术，自动取消生成的提议
```

[演示指南](DEMO_GUIDE.md) 里的提示词就是我们录制演示视频时用真实模型逐个跑过的。真实模型的回答会有差异，偶尔不出确认卡片时需要重问一次。

## 其他可以直接运行的检查

| 命令 | 内容 |
| --- | --- |
| `npm run demo:risk` | 在内存里跑一遍风控转账流程，打印结果 |
| `npm run replay:puma` | 用合成数据回放 PUMA 模块，结果写到 `test-results/puma/` |
| `npm run benchmark:memory` | 离线对比三种记忆方案，使用假模型 |
| `npm run test:risk`、`npm run test:puma` | 只跑风控或 PUMA 相关测试 |

`scripts/check-*-ui.mjs` 是界面检查脚本，需要先构建，并另外安装 Playwright。

## 已知缺口

- `propose_subscribe_product`、`propose_redeem`、`propose_credit_repay`、`propose_loan_draw`、`propose_loan_repay` 这五个智能体工具没有直接测试；对应的申购、赎回、还款和提款在银行接口层有测试。
- 真实模型的效果没有自动化评测，只有上面的手动检查和演示录制。
