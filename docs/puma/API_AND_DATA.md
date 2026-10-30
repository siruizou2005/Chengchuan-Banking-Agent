# PUMA 接口与数据权限

所有 HTTP 路径以 `/api` 为前缀，复用现有会话/同源检查；写请求必须 JSON。没有 Agent 可调用的付款、批准、保护关系或策略变更工具。

| 接口 | 契约及调用方 |
|---|---|
| GET /agent/control | 本人 stopped / epoch |
| POST /agent/control/stop | 已认证本人；原子取消排队/定时任务、未提交草稿及代理授权，发出本进程 AbortSignal；取消尚未发出的账单推送 |
| POST /agent/control/resume | `{pin}`；提升 epoch，旧任务不复活 |
| GET/POST /v1/puma/consents | `{scope,granted,expiresAt?,pin?}`；scope=data_read/personalization/agent_tools/trait_research；授予须 PIN；撤回无需付款批准 |
| GET /v1/puma/events | 本人最近100条事件引用，无原始对话/账号 |
| GET /v1/puma/behavior | 当前用户的分币种统计基线、样本覆盖、UNKNOWN |
| POST /v1/puma/context | `{taskScope}` 当前用户任务；最小来源记忆、候选意图、研究性诈骗输出；不赋予工具权限 |
| GET /v1/puma/risk-flags | 兼容既有标签的规范化视图，包含证据事件引用、复核状态与审核结论 |
| GET/POST /v1/puma/delegates | 建立关系使用 `{delegateUserId 或 delegatePhone,role,minAmountMinor,expiresAt,pin,jurisdiction?}` |
| POST /v1/puma/delegates/:id/verify | 被登记人独立登录并提供 PIN；不接受聊天“同意”；法定监护不能走此接口 |
| POST /v1/puma/delegates/:id/revoke | 本人 PIN 撤销自愿关系；原待批义务保留为 CONFLICT |
| GET /v1/puma/delegate-approvals | 当前共同确认人的脱敏交易明细和摘要挑战 |
| POST /v1/puma/delegate-approvals/:id/confirm | `{digest,decision:APPROVED或REJECTED,pin}`；后端验证身份、关系版本、冲突、过期及同一交易摘要。主用户已批准时才可能由后端继续提交 |
| POST /internal/puma/delegates/:id/legal-review | 独立白名单审核员 PIN + documentRef；材料只能来自后端 legalDocuments 可信快照，不接受客户端/LLM 自称有效。action=REVOKE 的独立审核材料撤销法律权限 |
| POST /internal/puma/review-feedback | 风控审核员；UNDER_REVIEW 案件 + rationale + evidenceIds + 明确 outcome。CONFIRMED_FRAUD 还需 nextReviewAt。INCONCLUSIVE/取消不作为监督标签 |
| GET /internal/puma/metrics | 既有风控审核员；延时、模型故障、STOP指标 |

原 `v1/transfers` API 保持；草稿响应新增 `delegateApprovals`。主用户批准后若共同确认未完成，响应仍是 `USER_APPROVED`，绝不返回虚假的已提交。没有单独面向用户/Agent 的 submit 接口。

## 内部模块

* EventAdapter/EvidenceStore：`puma/evidence.mjs`，后端能力，无公开 ingest HTTP。事件 ID 冲突拒绝、语义重复去重，received time 由后端生成；audit adapter 自动接入工具、审批、渠道结果、风险和保护关系。
* MemoryAdapter：`puma/memory.mjs`；沿用 memory API。只将具有显式/确认来源的有效记录作为 VERIFIED_FACT；其他推断保留假设标记。来源 sidecar 不存 value；历史未知来源不会补造成 verified。
* BehaviorProfile/IntentInference/ScamRiskPredictor：`puma/models.mjs`。当前指令优先，多候选含 UNKNOWN，意图1小时有效；影子推断由 `agent.mjs` 每个合格任务调用，没有额外 LLM 请求。
* FixedRiskEngine：`risk/policy.mjs`；R01–R21 注册表在 `puma/rules.mjs`。R19–R21 是实际支付授权、摘要和幂等硬控制，不是聊天打分。
* AuthorizationGateway/PaymentAdapter：复用 risk/transfers + authorization + risk/payment。新增费用承担、渠道和网络也进入摘要；旧未提交草稿应取消重新创建。

## 数据与权限

| 分区 | 存储 | 最小权限/删除 |
|---|---|---|
| 本人偏好 | 原 agent_memory/memory_candidates；puma_memory_provenance 只存来源与版本 | 本人管理，工具不能写已验证事实；撤回个性化后不检索、不推断，清除会话/派生缓存 |
| 数据/画像/工具同意 | puma_consents | 独立 scope、主体、签发、期限、版本、撤回；trait_research 默认无同意。现有账户/协议的原权限保留，显式撤回优先 |
| 工具授权 | operation_authorizations + puma_control/puma_queue_epochs | 已有 capability + 持久 epoch。STOP 不清除必要审核/支付对账 |
| 具体支付 | risk_approvals + risk_payments | 每笔交易独立批准，不能用个性化同意或共同确认替代 |
| 风险/审核 | risk_evaluations/risk_reviews、puma_risk_links/puma_feedback、puma_audit/puma_events | 后端/白名单审核员，用户只能读取自己的视图。事件、评估、复核、反馈与 PUMA 审计通过 SQLite trigger 禁止 UPDATE/DELETE |
| 委托关系 | puma_delegates/puma_delegate_requirements | 本人 + 被登记人 + 独立法律审核员各自有限权限；不给联系人全量财务历史 |

实例内租户身份仍由原 principal 模块决定；PUMA 不接受客户端 user_id/tenant_id 来选择数据。内部 EvidenceStore 对全部来源引用检查用户归属。金融/账户文本仍作为不可信数据处理。

不复制银行卡明文和私人对话到 PUMA 事件、指标或审计；payload_ref 仅允许 encrypted: 引用，本实现不伪造加密存储。HTTPS 与磁盘/SQLite 加密、真实身份源、法律材料管理、审计保留期限属于部署方责任，不能将本地模拟测试视为已经满足生产合规。
