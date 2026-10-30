# 复用与缺口

| 资产 | 决策 | 真实路径与理由 |
|---|---|---|
| 认证、交易批准 | REUSE | server/authorization.mjs、server/verify.mjs；现有 PIN/加强认证与参数绑定 |
| 支付状态与幂等 | EXTEND | server/risk/transfers.mjs；保留状态名，补充授权集合、STOP、费用/渠道摘要 |
| Mock Provider | REUSE | server/risk/payment.mjs；签名回调、顺序/重复保护 |
| 真实银行付款/冻结/撤回 | NOT_APPLICABLE | 无真实 provider；不能用模拟结果表示真实执行 |
| 全局 STOP / resume | NEW | server/puma/control.mjs；复用 execution 租约、services.cancel |
| 四类授权 | EXTEND | 保留 operation_authorizations、risk_approvals；新增有期限与版本的范围同意 |
| 事件与来源 | NEW | server/puma/evidence.mjs；引用已有资源，不复制金融明文 |
| Memory | EXTEND | 现有 memory API + PUMA provenance sidecar/适配视图，不迁移旧记录 |
| 行为与意图 | EXTEND | risk/features.mjs、agent/behavior-router.mjs；确定性 baseline、候选/UNKNOWN |
| 心理与诈骗模型 | NEW | 研究接口，无有效标签返回不足证据，不参与强制拒付 |
| 固定风险 | EXTEND | risk/policy.mjs、risk/service.mjs；保留已有规则并扩充注册表与可信信号 |
| 年龄 | REUSE | risk/age.mjs；新增显式年龄带映射，默认 shadow，不生成监护关系 |
| 保护关系、共同确认 | NEW | server/puma/delegates.mjs；身份验证、摘要绑定、撤销、利益冲突 |
| 风险事件/人工反馈 | EXTEND | risk_flags/risk_reviews；状态适配、来源关联、追加审核 |
| 多币种 | NOT_APPLICABLE | 无可信 FX；保留原币，不合并为伪造基准 |
| 数据加密/真实身份服务 | NOT_APPLICABLE | 部署/运营方依赖，模拟版不能证明真实合规或生产可用 |

安全机制变更理由：旧机制没有用户全局 STOP 和交易共同确认集合。新增后端检查仅收紧未执行动作；兼容旧接口和没有配置共同确认的用户。替代方案“只在前端取消/提示词约束”不能阻断排队任务，故不采用。
