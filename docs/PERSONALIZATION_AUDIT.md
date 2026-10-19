# 个性化升级：修改前审查

审查日期：2026-10-18。工作区开始时无未提交修改。只读审查后制定以下计划。

## 当前功能与升级对照

|模块|实际实现与文件|状态及处理|
|---|---|---|
|银行业务|`server/app.mjs`、`services.mjs`、`authorization.mjs`；SQLite 事务、确认、风险策略、DAG|已实现，复用，不改变资金规则|
|Agent|`server/agent/agent.mjs`、`tools.mjs`；最多六轮 tools 推理|已实现，扩展上下文及调用封装|
|模型|Agent 内 fetch chat/completions；`voice.mjs` 独立 ASR 请求|已实现，统一资源控制与元数据审计|
|身份|`sessions.token` 保存哈希，关联 `users.id`；HttpOnly Cookie/Bearer|已实现，复用；客户端 userId 不可信|
|微信|`channels/wechat*.mjs`；iLink 直连、扫码、持久收件/投递/代次隔离|已实现，复用；项目不安装/运行 OpenClaw|
|飞书|`channels/feishu*.mjs`；共享 WS、专属签名回调、持久收件投递|已实现，补齐共享 Bot 命名空间验证|
|会话|`agent_sessions`、`agent_runs`；归属检查、回放、归档|已实现，扩展 TTL 和上下文预算；Web 原来接受客户端历史|
|长期记忆|`agent_memory(user_id,key,value,updated_at)`；remember/recall 工具|部分实现，缺候选、来源、删除、期限、自动注入；扩展现有表|
|用户队列|`agent/execution.mjs`；SQLite FIFO、租约、工具副作用账本|已实现，复用，补 Web 请求幂等|
|后台任务|30秒业务维护、订阅/计划；渠道轮询、发送重试、反馈与租约续期|已实现，保留。未发现后台模型总结、embedding、启动探测或模型回退|
|前端|React 19、Vite、TypeScript；Profile/Security、ChatApp|已实现，在个人中心添加记忆入口|

## 接口及调用链

已有接口参数、响应结构经路由代码与 `docs/API.md` 对照：认证 `/auth/login/register/logout`，本人资料 `/me/dashboard`，交易 `/transactions` 及 confirm/cancel，账户 `/accounts`，流水 `/ledger` 与 export，产品 `/products/holdings`，贷款 `/loans`，信用卡 `/credit-card`，收款人 `/payees`，测评 `/risk-assessment`，设置 `/settings`，通知、工单、预约、审计，以及 `/verify/*`。这些接口保持不变，具体字段见 [API.md](API.md)。

`POST /agent/chat`（兼容 `/chat`）接收 messages、sessionId、expectedUserId，返回 text/events/trace/runId/sessionId/sources/asOf；`/agent/sessions` 管理本人 App 会话，`/agent/runs` 返回本人决策链。`/channels/*` 提供绑定、解绑、金额开关、扫码与请求结果。所有本人资源通过 route 的认证中间件确定用户。

- Web：认证中间件 → Agent 用户队列 → 工具循环 → 服务端卡片与 agent_runs。
- 微信：iLink 受信轮询 → sender 与绑定核对 → wechat_inbox 唯一消息 → 用户队列 → 同一 Agent → 持久投递。未知发送结果不重跑模型。
- 飞书：共享 WS/专属签名回调 → 私聊及主人检查 → feishu_inbox → 用户队列 → 同一 Agent → 持久投递。
- 模型出网：`agent.mjs` 工具循环与一次成功话术纠正；`voice.mjs` 用户上传录音 ASR。`scripts/check-asr.mjs`、`check-agent-live.mjs`、`smoke-live.mjs` 为人工运行的实测脚本，不是服务后台入口。

## 数据与风险

业务表包括 users/accounts/transactions/ledger/holdings/loans/credit_cards/payees；授权表 operation_authorizations/authorization_executions/subscription_mandates；会话、记忆、动作、审计和渠道表见 `server/db.mjs` 及两个渠道 schema 文件。主键是 `users.id`；channel_bindings 保存 user_id、external_id、external_bot_id、绑定代次及 binding_session_id。

现有数据库为单银行实例，不支持同库多租户账号。采用数据库固定实例租户，所有新查询同时约束实例租户与用户；不把客户端字段当租户。旧绑定唯一键仅为 channel+external_id，不能安全猜测其历史 Bot 来源；保留约束（冲突拒绝，不自动合并），补充受信 Bot 检查。部署多个银行应使用独立数据库。

旧 remember 对模型输出直接写库，缺少来源验证。旧 Web 历史可由客户端伪造。推理总 token 有运行记录，但缺每次请求的状态、配额与费用。迁移只添加字段/表，旧记忆保留为待确认；不删除业务数据。配置可停用个性化，不能绕过身份和推理审计。

## 实施与验收顺序

1. 复用 SQLite 与用户主键，添加记忆元数据、候选、撤销与版本控制。
2. 服务端会话、确定性偏好命令、相关检索及模型候选验证接入统一 Agent。
3. 聊天/ASR 统一推理审计、限额、超时、并发、Web 消息去重。
4. 加固渠道 Bot 边界；个人中心提供查看、修改、确认、删除。
5. 使用现有 node:test 验证隔离、并发、迁移、过期与零空闲推理，运行全量测试及前端构建。
6. 提供24小时实际审计脚本；本次不把时间模拟测试宣称为真实24小时运行验收。
