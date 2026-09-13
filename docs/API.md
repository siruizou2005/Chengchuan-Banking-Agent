# 银行 Agent API

本地：`http://127.0.0.1:3000/api`；云端：`https://bank.siruizou.com/api`。

所有写请求必须为 `Content-Type: application/json`。登录返回会话Cookie及24小时有效的 `token`，程序可使用 `Authorization: Bearer <token>`。不要将token记录到日志或提交到版本库。

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
5. `POST /transactions/{id}/confirm`：`{"pin":"123456"}`。
6. `GET /transactions/{id}` 查询最终状态；只有 `completed` 表示成功。确认接口即使HTTP 200也可能返回业务 `failed`，务必判断 `status`。
7. 放弃交易时 `POST /transactions/{id}/cancel`，请求体 `{}`。

超时重试创建时必须复用原幂等键和相同请求体；同键不同请求返回409。重复确认已成功交易不会重复入账。待确认交易15分钟后过期。每日转账限额按UTC日期统计；账户冻结、余额不足、姓名不匹配或超限均由后端拒绝。

## 交易类型

以下均使用 `POST /transactions`，公用字段 `amount`（元字符串）、可选 `accountId`、幂等键，然后经过同一确认流程。

| type | 必需业务字段 | 说明 |
| --- | --- | --- |
| transfer | recipientName、recipientAccount、bank | 附言note可选；scenario=`bank_rejected`模拟失败 |
| deposit | productId | deposit-90 / deposit-365，最低50元 |
| investment | productId | wealth-flex最低100元；wealth-180最低1000元；先风险测评 |
| redeem | holdingId | 部分或全部本金；固定持有期理财须到期 |
| loan_draw | months | 3/6/12/24个月，最低1000元，总待还不超过20万元 |
| loan_repay | loanId | 不超过待还本金 |
| credit_repay | 无 | 不超过信用卡待还金额 |
| credit_spend | merchant | 增加虚拟信用卡账单，受可用额度与冻结状态限制 |
| payment | billType、billNumber | water/electricity/gas/mobile/broadband/property/scan |

## 其他接口

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| POST /auth/register | phone、name、password（8至72位字母+数字）、pin（6位数字） |
| POST /auth/logout | {} |
| GET /me | 当前用户 |
| GET /dashboard | 账户、持仓、贷款、信用卡、最近500条流水/100条交易及消息等 |
| GET /transactions?status=pending | 最近最多500条交易，可筛选状态 |
| GET /ledger?direction=income&q=工资 | 最近最多2000条匹配流水；direction支持income/expense |
| GET /ledger/export | 全部流水CSV下载 |
| PATCH /accounts/{id} | status=active/frozen、pin |
| GET /products /holdings /loans /credit-card | 分别获取业务资源 |
| PATCH /credit-card | status=active/frozen、pin |
| GET /payees | 收款人列表 |
| POST /payees | name、number、bank；同卡号更新姓名及银行 |
| DELETE /payees/{id} | {} |
| POST /risk-assessment | answers：3个1/2/3整数，如[3,3,3]；返回level |
| PATCH /settings | pin以及dailyLimit（元）、newPin，或oldPassword+newPassword |
| GET /notifications | 本人站内通知 |
| POST /notifications/read | {}，全部标为已读 |
| GET /support | 本人工单 |
| POST /support | subject、content（5至2000字） |
| POST /appointments | branch、service、date（YYYY-MM-DD，未来30天内） |
| POST /appointments/{id}/cancel | {} |
| GET /audit | 最近500条本人操作日志 |
| GET /health /agent/manifest /openapi.json | 公开的健康状态、能力及接口信息 |

## 错误

错误响应：`{"error":{"code":"INSUFFICIENT_FUNDS","message":"可用余额不足"}}`。

400参数错误，401认证失效，403支付密码或来源错误，404资源不存在/无权访问，409业务状态冲突，415非JSON请求，429限频。常见代码：`INVALID_PIN`、`DAILY_LIMIT`、`ACCOUNT_FROZEN`、`HOLDING_LOCKED`、`RISK_ASSESSMENT_REQUIRED`、`IDEMPOTENCY_CONFLICT`、`INVALID_STATE`。

`GET /ledger`与`GET /transactions`均只返回自己的资源。行内转账收款人可在自己的流水中看到入账，但不能查询发款人的交易资源或支付信息。

## 网页 Agent

主要hash路由：首页 `/#home`、转账 `/#transfer`、收支 `/#ledger`、交易 `/#transactions`、账户 `/#accounts`、财富 `/#wealth`、定期 `/#deposit`、贷款 `/#loan`、信用卡 `/#credit`、生活 `/#life`、开发者 `/#agent`。

核心定位符：`login-submit`、`quick-transfer`、`transfer-form`、`create-transfer`、`confirm-transaction`、`cancel-transaction`、`transaction-status`、`transaction-id`、`nav-home`等。字段优先使用中文标签或name：`recipientName`、`recipientAccount`、`bank`、`amount`、`pin`。交易结果必须通过页面状态或API查询核对，不能仅凭点击完成判断成功。
