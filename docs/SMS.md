# 验证码发送：邮件（Resend）与短信扩展接口

加强验证与注册的验证码按以下顺序选择渠道（`server/sms.mjs`）：

1. 用户邮箱为 example.com、`.test` 等保留域名（演示账户）：模拟发送，验证码在验证页直接显示，并提示"这只是演示，登记真实邮箱的账户会收到真实验证码"；同时抄送消息中心。
2. 登记了真实邮箱且配置了 `RESEND_API_KEY`：通过 Resend 发送邮件（`server/email.mjs`），`channel: 'resend_email'`。邹瑞（19900000000）登记 owner@example.com，会收到真实邮件。
3. 注入了腾讯云短信适配器且不是演示号码：发送短信（尚未实现，见下文）。
4. 其余情况：模拟发送，验证码在页面显示。

注册须先通过 `POST /api/auth/email-code` 验证邮箱，验证码只会发往本人确认过的地址。5 分钟有效期、8 次错误上限、错误计数和熔断逻辑保持不变。

## 启用 Resend 邮件

1. 在 Resend 创建 API Key，写入 `/etc/chengchuan-bank/env`：`RESEND_API_KEY=re_…`。
2. 发件人：未验证域名时默认 `onboarding@resend.dev`，Resend 只允许发到 Resend 账户本人的邮箱；要发给其他人，需在 Resend 验证域名（如 `mail.siruizou.com`，在 DNS 添加其给出的 SPF/DKIM 记录），并设置 `OTP_EMAIL_FROM=澄川银行 <no-reply@mail.siruizou.com>`。
3. 重启服务。未配置密钥时不启用，所有验证码继续在页面显示。

真实发送（邮件或短信）持久化频控（`otp_sends` 表）：同一地址 60 秒一次、每天 10 次，每日总量 `OTP_DAILY_LIMIT`（默认 90，Resend 免费版每天 100 封）。请求带 `Idempotency-Key`（验证 ID），重试不会重复发信；失败返回 503 `SMS_SEND_FAILED`，不回退成模拟，错误中不含验证码、地址或供应商响应。

## 短信适配器（腾讯云，尚未实现）

## 注入服务端适配器

`createApp(dbPath, { sms: { provider } })` 接受以下接口。发送目标由登录用户的数据库记录决定，不能由请求参数指定。

```js
const provider = {
  channel: 'tencent_sms',
  async sendVerificationCode({ phone, code, expiresIn, verificationId, actionTitle }) {
    // 在这里调用将来实现的短信 SDK 适配器。
    // phone: 注册手机号；code: 六位验证码；expiresIn: 300 秒。
    // verificationId: 本次发送的唯一关联 ID；actionTitle: 操作名称。
    // 仅在供应商确认受理后 resolve，失败或超时必须 throw。
    // 不要直接复制此空实现用于真实发送。
    throw new Error('SMS provider not implemented');
  },
};
// createApp(dbPath, { sms: { provider } });
```

适配器由服务端代码注入，不能从 HTTP 请求注入。内置适配器选择位于 `server/sms.mjs`；目前接受 `tencent_sms`，若增加其他供应商，需要同步扩展适配器校验及 `hasSmsFactor`。

没有 provider 时，所有用户继续在消息中心收码。内置演示号码（包括导入示例流水的账户）即使注入 provider 也强制模拟。测试外部适配器请使用独立测试账户。未来的配置工厂应在凭据缺失时返回未配置状态，而不是注入空实现。

## 异步发送与审计

- `/api/verify/start` 等待适配器成功后返回 `{ id, expiresIn: 300, simulated, channel }`。默认 `simulated: true`、`channel: 'simulated_sms'`。
- 验证记录保存 `sms_channel` 和 `delivery_status`。旧记录迁移为 `simulated_sms` / `sent`。
- 网络调用在数据库事务之外执行；`pending` / `failed` 记录不能用于验证。在同一操作发送未结束且未过期时拒绝重发。
- 新码发送成功并通过操作有效性复核后才使旧码失效。发送失败返回 `503 / SMS_SEND_FAILED`，不自动回退成模拟发送，不记录供应商原始异常。
- `verification.started`、`verification.send_failed`、`verification.invalidated` 审计包含实际渠道；模拟发送附带 `demo_account` 或 `provider_not_configured` 原因。授权因子保留实际渠道，策略中的 `sms` 表示短信验证要求。
- 前端按 `simulated` 展示手机收码提示或模拟收件箱。验证码不通过 start 响应返回，真实适配器不写入站内消息。
- 适配器必须设置有界超时，并将供应商返回的业务拒绝转成异常；禁止将验证码、密钥或未经脱敏的完整供应商响应写入日志。当前仅存验证码哈希，服务重启后不能恢复发送中的验证码；过期后重新发起。

## 将来启用真实短信前

（按地址的持久化频控已随邮件渠道实现，短信同样适用。）

1. 实现腾讯云适配器，核对手机号格式、模板参数和每个号码的受理状态；配置缺失时不注入 provider。SecretId/Key、SdkAppId、签名、模板 ID 写入 `/etc/chengchuan-bank/env`，现有 systemd 服务已经加载该文件。
2. **实现按手机号持久化、原子限流：60 秒一次及可配置每日上限**，并明确时区、超时额度处理、并发与重启行为；同时配置腾讯云侧限额和告警。本次只预留接口，仍沿用原有同用户同操作约 1 秒重发限制，不具备上线真实收费短信所需的频控。
3. 需要时增加请求标识和送达回执；供应商受理成功不等于运营商送达。
4. 在服务入口构造并注入适配器；运行自动化测试，再以受控真实手机号验证收码、授权、频控及失败处理。新增示例账户时同步维护模拟号码名单。

`tests/sms.test.mjs` 使用假适配器验证异步发送、失败保护、渠道审计和后续授权，不发送真实短信。
