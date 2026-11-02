# 第三方组件与数据

## 代码

- `server/agent/skills/upstream/anthropic-financial-services/`：来自 Anthropic 的金融 Skills，按 Apache License 2.0 使用，原 LICENSE 和 NOTICE 保留在该目录。改编方式见 [docs/FINANCIAL_SKILLS.md](docs/FINANCIAL_SKILLS.md)。
- npm 依赖：见 `package-lock.json`。生产依赖的许可证为 MIT、ISC、BSD-3-Clause 和 Apache-2.0，没有 copyleft 许可证。

## 数据

- 基金名称、净值和业绩来自东方财富（天天基金）的公开数据，运行时按需拉取并缓存；`server/fund-snapshot.json` 是 2026-10-20 的快照，用于离线回退。数据仅用于展示和分析，版权归原数据提供方。
- 行情指数通过公开行情接口获取，同样仅用于展示。
- 演示账户流水的来源和处理方式见 [docs/DATA.md](docs/DATA.md)。
