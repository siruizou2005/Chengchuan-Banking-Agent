# 人脸核身扩展接口

当前只实现项目接口与假适配器自动化测试，没有安装腾讯云 SDK、调用腾讯云或创建真实核身订单。默认保留本地摄像头摘要模拟；演示账户（含导入流水示例账户）始终模拟。模拟模式不收集真实身份信息。

## 服务端注入

在 `createApp(dbPath, { face })` 中提供：

```js
const face = {
  encryptionKey: process.env.IDENTITY_ENCRYPTION_KEY,
  returnUrl: 'https://你的App域名/#face-return',
  timeoutMs: 10000,
  provider: {
    channel: 'tencent_face',
    allowedOrigins: ['https://经核实的核身入口域名'],
    async start({ realName, idNumber, redirectUrl, reference, expiresAt, signal }) {
      // 将来通过 DetectAuth 提交绑定的姓名、身份证号和服务端生成的回跳地址。
      // reference 是本站核身流水号；signal 用于取消超时请求。
      // 返回 { bizToken, url, expiresAt? }；expiresAt 为 ISO 时间。
      throw new Error('Face provider not implemented');
    },
    async result({ bizToken, reference, signal }) {
      // 将来通过 GetDetectInfoEnhanced 拉取结果，不能相信浏览器给出的结果。
      // 返回 { bizToken, status: 'pending' | 'passed' | 'rejected',
      //        realName?, idNumber?, providerReference? }。
      // passed 必须同时带供应商实际核验的姓名、身份证号及核身流水号。
      // providerReference 对应供应商本次核验的流水（如 LivenessDetail.Seq），
      // 不能用客户端参数或发起请求时的预期身份直接填充通过结果。
      throw new Error('Face provider not implemented');
    },
  },
};
// createApp(dbPath, { face });
```

凭据未配置时不注入 `provider`，继续模拟。注入的真实适配器若缺少密钥、回跳地址或接口声明，启动时直接拒绝配置，避免错误配置导致验证降级。运行期间供应商拒绝、业务错误、超时均失败，不自动切换成模拟。供应商入口必须为 HTTPS 且属于服务端配置的精确 origin 白名单。

`IDENTITY_ENCRYPTION_KEY` 为独立的 32 字节密钥，使用 64 位十六进制表示；服务端可用 `randomBytes(32).toString('hex')` 生成。生产环境存入 `/etc/chengchuan-bank/env`，不要提交仓库。现有 systemd 服务会读取该文件。密钥需要安全备份；不要直接更换，否则旧记录无法解密。密钥轮换和实名资料更正需另行设计受控迁移，本次没有开放自行修改入口。

## 实名信息与接口流程

1. 登录用户请求 `GET /api/verify/identity`，得到 `{ enrolled, required, channel, maskedName?, maskedIdNumber? }`。真实核身模式的普通账户未录入资料时，`required: true`。
2. `POST /api/verify/identity` 提交 `{ realName, idNumber }`。仅首次录入，校验大陆18位身份证格式、生日、校验位；这只是格式校验，身份是否真实需后续核身确认。返回脱敏信息，号码输入框使用密码输入，不写入浏览器存储。
3. `POST /api/verify/start { actionId }` 创建绑定操作参数版本的验证；真实模式必须先录入实名信息。响应增加 `faceChannel: 'simulated_face' | 'tencent_face'`。短信仍按已有独立适配器发送。
4. 真实模式调用 `POST /api/verify/face/start { id }`，由服务端调用适配器获取 BizToken 和 H5 URL。返回 `{ sessionId, url, expiresAt, simulated: false }`。一条验证只能发起一次核身。
5. 前端在新标签页打开核身地址，保留原页面待确认的业务参数。供应商完成后回跳 `/#face-return?sessionId=...&state=...`；回跳页需要有效登录，并自动请求服务端查询结果。若浏览器阻止关闭返回页，用户可手动返回原标签页。当前不会跨页面自动执行付款或恢复支付密码。
6. `POST /api/verify/face/result { sessionId, state }` 验证用户归属、随机回跳状态和有效期，再从服务端保存的 BizToken 查询结果。只有返回通过且姓名、身份证号与录入信息完全匹配，才将 `face_status` 标为 `completed`。`pending` 可稍后再查询；通过、拒绝、失败后的结果提交均不可重放。
7. `GET /api/verify/face/sessions/:id` 只读取本人核身状态，不重新查询供应商，也不消耗核身凭据。返回页刷新或原页面检查已通过状态使用此接口。
8. 原验证页面确认通过后，继续原有短信验证码及支付密码流程；授权因子为 `tencent_face`。模拟仍使用 `simulated_face` 或已登记的摄像头降级原因。真实核身不能通过 `/verify/face` 的 `frameHash` 或 `skipped` 绕过。

## 持久化与安全边界

- 姓名和身份证号一起用 AES-256-GCM 加密，随机 IV，并用用户 ID 作为附加认证数据。独立的 `verification_identities` 表不会进入普通用户对象、dashboard 或模型工具数据。
- BizToken 加密存储并绑定用户和本地核身会话；另存全局唯一 SHA-256 摘要防止跨用户、跨验证复用。审计只保存摘要，不保存原 Token；Token 可能出现在供应商 H5 入口 URL 中，所以链接仅返回登录用户，不进入 IM。
- `verifications.face_session_id` 关联本地核身流水；通过后的供应商流水存入 `verifications.face_reference`、`face_sessions.provider_reference` 和 `verification.face_verified` 审计。
- 本站不落盘照片、视频、供应商完整回包。适配器只返回规范化的文本结果，核身结果中额外的照片字段也不会被数据库逻辑保存。
- `starting → pending → checking → passed / rejected / expired / failed` 由服务端控制；`pending` 查询未完成可退回 `pending`。查询采用数据库原子占用，并发请求不能重复领取结果。通过后的操作确认将会话标为 `consumed` 并清除加密 BizToken，保留摘要防重放。
- 核身有效期最多到本次验证码的5分钟期限，供应商更长的有效期不能延长它。发起及查询默认最多等待10秒；超时失败后重新开始加强验证。进程重启后，已创建的 `pending` 会话可继续；若中断在 `starting/checking`，不自动重试外部调用，应重新开始验证。
- 审计、模型输入/输出和 IM 输出统一脱敏18位身份证号，覆盖数字和 X 结尾、与中文相邻的情况；结构化身份字段被移除。供应商异常不会原样进入日志或 API。API仅允许18位大陆身份证；不承诺识别任意拆分、编码或其他证件类型。

## 将来接腾讯云时

1. 申请人脸核身服务及适用 H5 场景的 RuleId，核对支持的浏览器、域名和回跳配置；在服务入口构造上述适配器。
2. `start` 对接 [DetectAuth](https://cloud.tencent.com/document/product/1007/31816)，将其 BizToken、核身 URL 映射到接口。只从服务端读取姓名和身份证号。
3. `result` 对接 [GetDetectInfoEnhanced](https://cloud.tencent.cn/document/api/1007/41957)，显式请求 `InfoType: '1'` 的文本信息，不请求照片/视频。结合实际 RuleId 流程检查最终业务结果、活体和身份比对结果，不能以 HTTP 200 或有回包就认定通过。返回实际核验的 `Text.Name`、`Text.IdCard` 以及对应核验流水。
4. 腾讯云允许在结果保留期内多次拉取同一个 BizToken；本站只允许将通过结果消费到一个验证中。供应商结果查询能力不等于业务授权可重复使用。
5. SecretId/Key、RuleId、身份加密密钥放在 `/etc/chengchuan-bank/env`。配置真实调用的频控、费用上限与告警后，用受控真实账户在目标浏览器完成一次端到端验收。浏览器容器差异可能需要调整新标签页衔接方式。

上述腾讯云接口映射依据官方 [H5 配置流程](https://cloud.tencent.com/document/product/1007/103091) 与 API 文档；本仓库目前只有扩展接口和假适配器测试，尚未完成真实云端收码/刷脸验收。

测试：`node --test tests/face.test.mjs tests/sms.test.mjs tests/verify.test.mjs`。
