# 分阶段实施映射

PR0–PR6 是本次本地可审查工作阶段；不表示已创建或合并远程 PR。

| 阶段 | 实现 | 验收/回退 |
|---|---|---|
| PR0 | CURRENT_ARCHITECTURE、REUSE_GAP_MATRIX、本文件 | 只读审查，运行原测试基线 |
| PR1 | puma/control、schema；execution/guard/agent、交易摘要 | 先通过 STOP/撤销/支付安全测试，再改支付共同确认 |
| PR2 | puma/evidence、授权范围、Memory 来源适配 | 增量 sidecar，可保留旧记录；关闭 memory_v2 |
| PR3 | puma/models，复用 features 与行为路由 | 默认 shadow；数据覆盖、UNKNOWN、个性化撤销 |
| PR4 | 研究 trait/scam 契约 | 无标签/校准不足声明；关闭研究标志 |
| PR5 | delegates、规则注册表、风险标签适配 | 主用户批准不能由联系人替代；持久化要求不随关闭开关消失 |
| PR6 | HTTP/Agent 适配、T01–T24 测试、replay、Runbook | 全回归、构建、迁移重开/回滚演练 |

公共状态映射：USER_APPROVED=APPROVED、PRE_EXECUTION_CHECK=PRE_SUBMIT_RECHECK、SUBMITTING=SUBMITTED（结果未知）、HOLD_REVIEW=REVIEW_REQUIRED、BLOCKED=REJECTED。保留现有 API 字段以兼容 RiskTransfer.tsx。

不实施没有数据基础的时序训练/心理标签校准、不启用真实资金；这些限制在最终验收和 Runbook 中明确列出。
