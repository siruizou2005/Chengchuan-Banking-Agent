# 银行 Agent API

本地：`http://127.0.0.1:5173/api`（开发）或 `http://127.0.0.1:3000/api`（生产）；云端：`https://bank.siruizou.com/api`。

所有写请求必须为 `Content-Type: application/json`（语音接口除外）。登录返回会话 Cookie 及 24 小时有效的 `token`，程序可使用 `Authorization: Bearer <token>`。不要将 token 记录到日志或提交到版本库。金额请求为元字符串，响应为整数分。

## 最短工作流

1. `POST /auth/login`：`{"phone":"13800138000","password":"Bank123456"}`。
2. `GET /accounts`：读取账户、账面余额 `balance`、预留 `held`、可用余额 `available`，单位为分。
3. `POST /transactions`，传请求头 `Idempotency-Key: <8至100字符唯一键>`：

```json
{
  "type": "transfer",
  "amount": "100.50",
  "recipientName": "陈屿",
  "recipientAccount": "6218808888000088096",
  "bank": "澄川银行",
  "note": "模拟测试"
}
```

4. 核对返回的交易 `id`、金额和收款人。此时状态为 `pending`，尚未扣款但已预留资金。
5. `POST /transactions/{id}/confirm`：`{"pin":"123456"}`。当日转账/缴费累计超过 1000 元时该确认属于红色操作，需先按下文「强验证」取得 `verificationToken`，并在请求体附带 `verificationActionId` 与 `verificationToken`，否则返回 403 `VERIFICATION_REQUIRED`。
6. `GET /transactions/{id}` 查询最终状态；只有 `completed` 表示成功。确认接口即使 HTTP 200 也可能返回业务 `failed`，务必判断 `status`。
7. 放弃交易时 `POST /transactions/{id}/cancel`，请求体 `{}`。

超时重试创建时必须复用原幂等键和相同请求体；同键不同请求返回 409。重复确认已成功交易不会重复入账。待确认交易 15 分钟后过期。每日限额与累计按固定 `Asia/Shanghai` 业务日统计；完成交易按完成时间，未来操作按预计执行日归集，实际执行再次复核；账户冻结/挂失、余额不足、姓名不匹配或超限均由后端拒绝。

## 交易类型

以下均使用 `POST /transactions`，公用字段 `amount`（元字符串）、可选 `accountId`、幂等键，然后经过同一确认流程。

| type | 必需业务字段 | 说明 |
| --- | --- | --- |
| transfer | recipientName、recipientAccount、bank | 附言 note 可选；scenario=`bank_rejected` 模拟失败 |
| deposit | productId | deposit-90 / deposit-365，最低 50 元 |
| investment | productId | wealth-flex 最低 100 元；wealth-180 最低 1000 元；先风险测评 |
| redeem | holdingId | 部分或全部本金；固定持有期理财须到期 |
| loan_draw | months | 3/6/12/24 个月，最低 1000 元，总待还不超过 20 万元 |
| loan_repay | loanId | 不超过待还本金 |
| credit_repay | 无 | 不超过信用卡待还金额 |
| credit_spend | merchant | 增加虚拟信用卡账单，受可用额度与冻结状态限制 |
| payment | billType、billNumber 或 merchant | water/electricity/gas/mobile/broadband/property/scan 需 billNumber；`merchant` 为模拟商户消费（鲜花、蛋糕、订阅代扣），需 merchant 名称 |

## 其他接口

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| POST /auth/register | phone、name、password（8 至 72 位字母+数字）、pin（6 位数字） |
| POST /auth/logout | {} |
| GET /me | 当前用户 |
| GET /dashboard | 账户、持仓、贷款、信用卡、最近 500 条流水/100 条交易、消息，以及 agentActions、agentPlans、subscriptions、virtualCards、reservations、scheduledTasks、bindings、agentLockedUntil |
| GET /transactions?status=pending | 最近最多 500 条交易，可筛选状态 |
| GET /ledger?preset=last_30_days&direction=expense&category=餐饮美食&q=美团 | 最多 2000 条匹配流水。时段（北京时间）用 `preset`（同智能体工具取值）、`period`（YYYY / YYYY-MM / YYYY-MM-DD）或 `from`+`to`，不传为全部；`direction` 为 income/expense；`kind`（`spend` 表示消费加退款）、`category`、`platform`（如 支付宝、银行卡快捷支付、澄川银行）按统一口径筛选；`q` 匹配摘要、对方、商户、附言、交易编号。每行附带 `kind`、`tag`、`bj_time`，导入流水另含 `txn_type`、`counterparty`、`merchant`、`platform` 等统一字段，见 README |
| GET /ledger/export | 按与 `/ledger` 相同的筛选导出 CSV：交易编号、北京时间、摘要、金额、余额、分类、类型、交易类型、对方户名、商户、支付平台、附言、来源银行 |
| PATCH /accounts/{id} | status=active/frozen/lost、pin；解冻（lost/frozen→active）与挂失为红色，需附 verificationActionId + verificationToken |
| GET /products /holdings /loans /credit-card | 分别获取业务资源 |
| PATCH /credit-card | status=active/frozen/lost、pin；解冻与挂失同上 |
| GET /payees | 收款人列表 |
| POST /payees | name、number、bank；同卡号更新姓名及银行 |
| DELETE /payees/{id} | {} |
| POST /risk-assessment | answers：3 个 1/2/3 整数，如 [3,3,3]；返回 level |
| PATCH /settings | pin 以及 dailyLimit（元）、newPin，或 oldPassword+newPassword；调高限额、改密码为红色，需附 verificationActionId + verificationToken |
| GET /notifications | 本人站内通知（含模拟短信验证码、待验证提醒） |
| POST /notifications/read | {}，全部标为已读 |
| GET /support | 本人工单 |
| POST /support | subject、content（5 至 2000 字） |
| POST /appointments | branch、service、date（YYYY-MM-DD，未来 30 天内） |
| POST /appointments/{id}/cancel | {} |
| GET /audit | 最近 500 条本人操作日志 |
| GET /health /agent/manifest /openapi.json /chat/status | 公开的健康状态、能力、接口信息；`/chat/status` 返回 `{configured, model, voice, agentDisabled, channels:{feishu,feishuPersonal,wechat}}` |

## 智能体接口

### 对话

`POST /agent/chat`（`POST /chat` 为兼容别名）：

```json
{ "messages": [{ "role": "user", "content": "给陈屿转 200 备注午饭" }], "sessionId": "SESSION…", "expectedUserId": "U…" }
```

- `messages` 只接受 user/assistant 角色，最多 24 条、单条 6000 字、合计 12000 字，最后一条必须是 user。历史 assistant 消息不构成已执行的证据。
- `sessionId` 可选；首轮由服务端生成并返回，后续携带以归入同一对话。`expectedUserId` 可选，登录账户变化时返回 409 `ACCOUNT_CHANGED`。
- 返回 `{ text, events, trace, runId, sessionId, sources, asOf }`。`events[]` 为服务端卡片：`action`（待确认动作）、`plan`（联动计划）、`report`（账单报告）、`stats`（多维统计，两者都带 `suggestions` 追问建议，每轮最多一张）、`anomalies`、`subscriptions`、`products`、`handover`、`locked`；`trace[]` 为工具调用链路（脱敏）。
- 智能体锁定时返回 200 且 `events` 含 `locked`；`AGENT_DISABLED=true` 或锁定期间的工具调用与提议接口返回 423 `AGENT_LOCKED`。

### 动作与计划

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| GET /agent/actions | 本人最近 100 条动作，含 `level`（green/yellow/red）、`status`、`args`（脱敏）、`result`、`plan`、`decision`、`accountTail`、`authorization_until`、`verification_until`、`pause_reason` |
| POST /agent/actions | `{tool, args}` 从业务页面直接提议，如 `{"tool":"propose_card_action","args":{"card":"A…","action":"report_lost"}}`；返回 201 与动作 |
| POST /agent/actions/{id}/confirm | `{pin, verificationToken?}`；只接受 App 渠道（IM 渠道发起的动作也在此确认）；黄色需 pin，红色还必须附有效一次性 token（403 `VERIFICATION_REQUIRED` / `INVALID_VERIFICATION`）；返回动作，`status` 为 completed/confirmed（已授权待执行）/failed；同一接口也完成 awaiting_verification 的补充授权与恢复，不能修改已保存业务参数 |
| POST /agent/actions/{id}/cancel | {}，取消待确认或已授权未执行的动作，释放预授权 |
| GET /agent/plans | 本人联动计划及步骤状态 |
| POST /agent/plans/{id}/abort | {}，中断计划：取消未执行步骤、释放锁定资金 |
| POST /agent/plans/{id}/handover | `{reason?}`，中断并创建模拟人工工单 |
| GET /agent/runs | 最近 100 轮决策链路：channel、input、injection、trace、events、output、duration_ms、tokens、topic（null 为银行相关；greeting、off_topic_rule、off_topic_model 为寒暄或无关话题拦截） |
| POST /agent/unlock | `{pin}` 解除智能体安全锁定 |
| GET /agent/splits/{id}/{index} | 本人收到的 AA 收款请求（金额、收款方），页面 `/#pay-request/{id}/{index}` 使用 |

动作状态：`proposed → confirmed → executing → completed | failed`，以及 `awaiting_verification`、`cancelled`、`expired`。提议 15 分钟过期；未来任务的 `authorization_until` 默认为最后预计执行时间后 24 小时（锁定步骤使用 until），等待验证以 `verification_until` 单独保存，默认 15 分钟且受原授权窗口限制。IM 渠道发起的动作在 `GET /agent/actions` 中 `channel` 为 feishu/wechat，一律在 App 确认：黄色输入 pin，红色先完成强验证；服务端对非 App 渠道的确认返回 403 `APP_CONFIRMATION_REQUIRED`。


### 策略决策、授权与调度

`decision` 包含 `level`、`outcome`（allow / require_confirmation / require_verification / deny）、`reasons[{code,message}]`、`requiredFactors`、`policyVersion`、`evaluatedAt`、`businessDate`。对转账及缴费，`amounts` 为整数分：completed（已完成）、committed（已授权未执行）、proposed（其他有效待确认）、current（本笔）、total、threshold（100000）。DAG 增加 `amountsByDate`，逐个预计业务日列明本计划支出和计入后的累计，不把跨日预算当作今日累计。

红色动作仍缺模拟强验证时返回 403 `VERIFICATION_REQUIRED`，并附最新 `error.decision`，动作保持待确认。调度风险升高则持久暂停，不算执行失败或触发连续业务失败熔断。前端刷新卡片，使用原 actionId 验证后再次调用 confirm；返回 confirmed 表示已重新授权并等待调度，不能显示付款成功。

授权参数从服务端读取。客户端额外提供 `amount`、`recipient`、`level`、`skipConfirmation` 不会修改已授权操作。确认后的关键参数修改应创建新动作并取消旧动作。授权精确覆盖原步骤和金额，任务每步使用独立幂等键；重复确认、重跑和重启不会重复扣款或重复预留。

`operation_authorizations` 保存授权版本、摘要、精确范围、批准等级、实际模拟因素、策略版本、确认来源及时间窗口；`authorization_executions` 保存每步唯一执行记录。取消、解绑、过期和业务失败撤销许可。`/audit` 关联 runId、actionId、planId、stepId、authorizationId、transactionId，包含策略金额快照、签发、撤销、暂停、恢复与拒绝原因，不含完整 token、PIN 或验证码。

订阅的长期固定月度授权独立于即时转账授权，固定商户、金额、周期与每期幂等键均由服务端校验。演示种子来源为 `explicit_demo_seed`；没有证明来源的旧订阅 status 为 awaiting_authorization，需要重新授权，当前版本没有通用新增持续代扣授权接口。

模拟身份验证不能代表生产级多因子认证。摄像头跳过记录 skipped 和原因，并在授权因素中登记模拟替代路径；站内短信不接短信服务。

### 对话历史

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| GET /agent/sessions | 本人 App 对话列表：`id`、`title`（首条提问）、`turns`、`updated_at`、`handover` |
| GET /agent/sessions/{id} | `{id, handover, updatedAt, messages:[{role, text, events?, trace?, runId?, at}]}`，逐轮回放含服务端卡片 |
| DELETE /agent/sessions/{id} | {}，归档对话；记录不再显示，`/agent/runs` 与审计保留，该会话不能再续聊 |

### 强验证（红色操作）

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| POST /verify/intent | `{path, body}` 业务页面直接操作前询问是否需要强验证，如 `{"path":"/settings","body":{"dailyLimit":"60000"}}` → `{required, actionId?, decision}`；token 与具体参数及服务端保存的交易参数绑定 |
| POST /verify/start | `{actionId}` → `{id, expiresIn:300, simulated:true}`，6 位验证码哈希存库并投递到消息中心（标题「模拟短信验证码」）；不向模型或审计记录明文验证码 |
| POST /verify/face | `{id, frameHash}`（64 位十六进制 SHA-256，前端摄像头画面摘要）或 `{id, skipped:true, reason:"unavailable"|"denied"|"unsupported"}` 降级，降级写审计 `verification.face_skipped` |
| POST /verify/complete | `{id, code}` → `{verificationToken}`；未完成人脸步骤 403 `FACE_REQUIRED`；错误 8 次限频并计入熔断；token 10 分钟有效、一次性、绑定 user、actionId、revision 和规范化参数摘要；确认事务内消费，并签发独立持久操作授权，计划不依赖短期 token 长期有效 |

### 语音

`POST /voice/transcribe`：`Content-Type: audio/wav`，请求体为 PCM16 单声道 16kHz WAV 原始字节，最长 60 秒、8MB；返回 `{text}`。未配置返回 503 `VOICE_NOT_CONFIGURED`；类型错误 415，格式或时长错误 400 `INVALID_AUDIO`；上游错误映射为 502 `PROVIDER_AUTH` / `PROVIDER_BALANCE` / `PROVIDER_RATE_LIMIT` / `PROVIDER_ERROR` / `VOICE_TIMEOUT`，不透传详情。

### 消息渠道

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| GET /channels | 已绑定渠道：`id`、`channel`、`status`（active/revoked/expired）、`created_at`、`personal`（飞书专属机器人） |
| GET /channels/preferences | 本人渠道设置：`{feishu:{maskAmounts:false},wechat:{maskAmounts:false}}`，默认均不隐藏 |
| PATCH /channels/preferences/{channel} | `{maskAmounts:boolean}` → `{maskAmounts}`；channel 只能为 feishu/wechat，只修改当前登录用户的指定渠道，不接受请求体切换身份 |
| POST /channels/code | `{pin}` → `{code, expiresIn:300}` 飞书一次性绑定码；在飞书私聊发送「绑定 123456」 |
| POST /channels/{id}/unbind | `{pin}`，解绑并撤销该渠道未执行的动作 |
| POST /channels/wechat/qr | `{pin}` → `{id, qrcode_img_content, expiresIn}`，需 `WECHAT_ENABLED=true` 与 `CHANNEL_SECRET` |
| GET /channels/wechat/qr/{id} | `{id,status,expiresAt,retryAfterMs,message,bindingId?}`；状态为 `waiting_scan/waiting_confirmation/awaiting_code/confirmed/expired/failed/cancelled`，仅本人可读取 |
| POST /channels/wechat/qr/{id}/verify | `{code}`；提交微信扫码页面显示的验证码，不是银行支付密码；仅 `awaiting_code` 可提交 |
| DELETE /channels/wechat/qr/{id} | `{}`；取消本人的未完成扫码，已完成绑定使用解绑接口 |
| GET /channels/wechat/requests | 本人最近 30 个微信请求，返回数组 `{id,status,received_at}` |
| GET /channels/wechat/requests/{id} | `{id,status,receivedAt,finishedAt,result,deliveries}`；完整 Agent 结果及最新操作卡片，仅本人可查看；投递状态不是手机送达证明 |
| POST /channels/feishu/register | `{pin}` → `{id, url, expiresIn}`，一键创建飞书专属机器人；`url` 用飞书扫码或在飞书中打开。需 `FEISHU_PERSONAL_ENABLED=true`、https 的 `PUBLIC_ORIGIN` 与 `CHANNEL_SECRET`；已有专属机器人返回 409 `FEISHU_BOT_EXISTS`，创建排队已满返回 429 `FEISHU_REGISTER_BUSY` |
| GET /channels/feishu/register/{id} | `{status: wait|confirmed|denied|expired|failed, bindingId?, error?}`，页面可见时轮询；3 分钟无人查询则中止 |
| POST /channels/feishu/events/{bindingId} | 飞书事件回调（无需登录），按该绑定的 Encrypt Key 解密并校验签名，自动应答 URL 校验；绑定不存在或已解绑时返回空对象 |

IM 侧命令：「帮助」、「绑定 123456」（飞书）、「取消 ACT…」、「确认 ACT…」，均限当前用户、渠道及绑定内动作。「确认」不会执行任何操作，只返回 App 直达链接 `${PUBLIC_ORIGIN}/#tasks?action=ACT…`（无公网地址时为文字指引）及所需验证方式；已授权待执行或已结束的动作返回当前状态。多笔不带编号时返回简短列表；只有一笔时可省略编号。其他文本进入智能体。

微信请求状态为 `queued/running/completed/failed/interrupted/cancelled`；投递状态为 `pending/sending/retry_wait/api_accepted/unknown/failed/cancelled/expired`。`api_accepted` 只证明接口接受，`unknown` 不自动重发或重新执行。微信直接返回查询及分析结果，超长内容和 App 完整结果入口为 `/#wechat-requests/{id}`，未登录先登录并保留入口。绑定快照增加 `auth_state`、`connection_state`、`last_inbound_at`、`last_api_accepted_at` 等安全元数据，凭据及 context 不返回前端。

金额开关按用户和渠道持久保存，解绑/重绑不会重置；飞书共享与专属机器人共用该用户的飞书设置。回复和业务通知发送前读取最新开关，已发出的消息不追溯修改，App 原始结果不改变。开启时常见金额、金额标签后的数值和财务表格数值显示为 `****`，链接、操作编号、日期、利率保持；账户标识及凭据的既有脱敏始终生效。明确拒绝后的微信重试若因设置变更导致正文改变，会换用新 client_id；正文不变仍复用原编号，unknown 不重发。

### 工具清单

查询（绿）：`get_overview`、`get_ledger`、`get_transactions`、`get_products_and_holdings`、`get_credit_card`、`get_loans`、`get_payees`、`resolve_recipient`、`bill_report`、`spending_stats`、`detect_anomalies`、`compare_products`、`get_risk_profile`、`get_scheduled_tasks`、`get_cards`、`run_analysis`、`recall`。

已登记低风险副作用（绿）：`remember` 仅保存本人主动要求的非敏感偏好，`set_reminder` 仅创建站内提醒，`handover_to_human` 仅创建模拟工单。

需确认查询（黄）：`list_subscriptions`。确认前只返回范围及动作卡片，不返回订阅列表；确认结果 `result={query:true, subscriptions, detected}`，没有付款回单。

提议（黄/红由策略决定）：`propose_transfer`、`propose_payment`、`propose_split`、`propose_subscribe_product`、`propose_redeem`、`propose_loan_draw`、`propose_loan_repay`、`propose_credit_repay`、`propose_card_action`、`propose_virtual_card`、`propose_set_daily_limit`、`propose_cancel_subscription`、`propose_lock_funds`、`create_plan`（DAG，最多 12 步，步骤只能引用提议工具或 `set_reminder`）。

## 错误

错误响应：`{"error":{"code":"INSUFFICIENT_FUNDS","message":"可用余额不足"}}`。

400 参数错误，401 认证失效，403 支付密码/验证/来源错误，404 资源不存在或无权访问，409 业务状态冲突，415 非 JSON 或非 WAV 请求，423 智能体锁定，429 限频，502 上游模型或语音服务错误，503 未配置，504 对话超时。

常见代码：`APP_CONFIRMATION_REQUIRED`、`INVALID_PIN`、`DAILY_LIMIT`、`ACCOUNT_FROZEN`、`ACCOUNT_LOST`、`CARD_LOST`、`HOLDING_LOCKED`、`RISK_ASSESSMENT_REQUIRED`、`IDEMPOTENCY_CONFLICT`、`INVALID_STATE`、`RECIPIENT_NOT_FOUND`、`AGENT_LOCKED`、`VERIFICATION_REQUIRED`、`INVALID_VERIFICATION`、`APP_VERIFICATION_REQUIRED`、`FACE_REQUIRED`、`INVALID_CODE`、`VERIFICATION_EXPIRED`、`SUPPLEMENTAL_VERIFICATION_REQUIRED`、`AUTHORIZATION_REQUIRED`、`AUTHORIZATION_INVALID`、`AUTHORIZATION_MISMATCH`、`AUTHORIZATION_BUDGET`、`MANDATE_INVALID`、`CHANNEL_NOT_BOUND`、`INVALID_BIND_CODE`、`CHANNEL_SECRET_REQUIRED`、`WECHAT_DISABLED`、`WECHAT_EXPIRED`、`VOICE_NOT_CONFIGURED`、`INVALID_AUDIO`、`CHAT_NOT_CONFIGURED`、`CHAT_BUSY`、`CHAT_TIMEOUT`、`INVALID_MESSAGES`。

`GET /ledger` 与 `GET /transactions` 均只返回自己的资源。行内转账收款人可在自己的流水中看到入账，但不能查询发款人的交易资源或支付信息。智能体的所有查询与动作同样按会话或渠道绑定的用户隔离。

## 网页 Agent

主要 hash 路由：IM 确认直达 `/#tasks?action=ACT…`（未登录时登录后仍停留在该页）、首页 `/#home`、转账 `/#transfer`、收支 `/#ledger`、交易 `/#transactions`、账户 `/#accounts`、财富 `/#wealth`、定期 `/#deposit`、贷款 `/#loan`、信用卡 `/#credit`、生活 `/#life`、智能助手 `/#assistant`、智能助手操作与计划 `/#tasks`、消息渠道绑定 `/#channels`、安全中心 `/#security`、开发者中心 `/#agent`、AA 收款 `/#pay-request/{id}/{index}`。

核心定位符：`login-submit`、`quick-transfer`、`transfer-form`、`create-transfer`、`confirm-transaction`、`cancel-transaction`、`transaction-status`、`transaction-id`、`agent-action`、`nav-home`、`nav-assistant` 等。字段优先使用中文标签或 name：`recipientName`、`recipientAccount`、`bank`、`amount`、`pin`、`code`。交易结果必须通过页面状态或 API 查询核对，不能仅凭点击完成判断成功。
