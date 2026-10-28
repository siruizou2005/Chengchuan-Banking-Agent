import { requireThat, hash } from '../errors.mjs';
export function registerRiskRoutes(route, bank, services, risk, transfers) {
  const draftSchema = { additionalProperties: false, required: ['sourceAccountRef', 'beneficiaryRef', 'amountMinor', 'currency'], properties: {
    sourceAccountRef: { type: 'string', pattern: '^[\\w-]{1,100}$' }, beneficiaryRef: { type: 'string', pattern: '^[\\w-]{1,100}$' },
    amountMinor: { type: 'integer', minimum: 1, maximum: 1000000000 }, currency: { type: 'string', enum: ['CNY'] }, memo: { type: 'string', maxLength: 100 } } };
  const bindingSchema = { additionalProperties: false, required: ['version', 'payloadHash'], properties: {
    version: { type: 'integer', minimum: 1 }, payloadHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } } };
  const limited = handler => (req, res) => {
    const key = `risk:${req.user.id}:${req.path}`;
    services.checkRate(key); services.badAttempt(key);
    try { return handler(req, res); } catch (error) {
      if (['INVALID_PIN', 'INVALID_VERIFICATION', 'VERIFICATION_REQUIRED'].includes(error.code)) {
        const d = bank.get('SELECT id,evaluation_id FROM risk_drafts WHERE id=? AND user_id=?', req.params.id || '', req.user.id);
        if (d) risk.metric(req.user.id, d.id, d.evaluation_id, 'AUTH_FAILURE');
      }
      bank.audit(req.user.id, 'risk.request.rejected', hash(req.path), { code: error.code || 'RISK_ERROR' }); throw error;
    }
  };
  route('get', '/v1/finance/risk-summary', '本人风控提醒（模拟）', (req, res) => res.json({ simulation: true, flags: risk.flags(req.user) }));
  route('get', '/v1/transfers/drafts', '本人转账草稿', (req, res) => res.json(bank.all('SELECT id FROM risk_drafts WHERE user_id=? ORDER BY created_at DESC LIMIT 50', req.user.id).map(d => transfers.drafts.view(req.user, d.id))));
  route('post', '/v1/transfers/drafts', '创建未授权转账草稿', limited((req, res) => res.status(201).json(transfers.drafts.create(req.user, req.body))), true, draftSchema);
  route('get', '/v1/transfers/drafts/:id', '可信转账确认数据', (req, res) => res.json(transfers.drafts.view(req.user, req.params.id)));
  route('patch', '/v1/transfers/drafts/:id', '版本保护的草稿修改', limited((req, res) => res.json(transfers.drafts.patch(req.user, req.params.id, req.body))), true, { ...draftSchema, required: ['version'], properties: { ...draftSchema.properties, version: bindingSchema.properties.version } });
  route('post', '/v1/transfers/drafts/:id/approval-intents', '交易绑定认证挑战', limited((req, res) => res.json(transfers.approvals.intent(req.user, req.params.id, req.body))), true, bindingSchema);
  route('post', '/v1/transfers/drafts/:id/approve', '认证后批准并由后端复核提交模拟支付', limited((req, res) => {
    transfers.approvals.approve(req.user, req.params.id, req.body);
    res.json(transfers.executor.submit(req.user, req.params.id));
  }), true, { additionalProperties: false, required: ['version', 'payloadHash', 'challengeId', 'pin'], properties: { ...bindingSchema.properties,
    challengeId: { type: 'string', pattern: '^[\\w-]{1,100}$' }, pin: { type: 'string', pattern: '^\\d{6}$' }, verificationToken: { type: 'string', pattern: '^[a-f0-9]{64}$' } } });
  route('post', '/v1/transfers/drafts/:id/cancel', '取消尚未提交的草稿', limited((req, res) => res.json(transfers.drafts.cancel(req.user, req.params.id))));
  route('get', '/v1/transfers/:id/status', '模拟支付状态', (req, res) => res.json(transfers.drafts.view(req.user, req.params.id)));
  route('get', '/v1/risk/flags', '本人可申诉风险事件', (req, res) => res.json(risk.flags(req.user)));
  route('post', '/v1/risk/appeals', '风险申诉', limited((req, res) => res.status(201).json(risk.appeal(req.user, req.body))));
  route('get', '/internal/risk/reviews', '受控风控队列', limited((req, res) => res.json(risk.queue(req.user))));
  route('post', '/internal/risk/reviews', '受控风控处置', limited((req, res) => res.json(risk.review(req.user, req.body))));
  route('get', '/internal/risk/fairness', '按客观风险分层的年龄策略指标', limited((req, res) => res.json(risk.fairness(req.user))));
  // No HTTP submit endpoint: only the local backend executor can consume approval.
  route('post', '/internal/payments/submit', '禁止用户或Agent直接执行付款', () => requireThat(false, '仅后端执行器可提交付款', 403, 'EXECUTOR_ONLY'));
  route('post', '/webhooks/payments/mock', '模拟支付签名回调', (req, res) => { transfers.executor.applyEvent(req.body); res.json({ ok: true, simulation: true }); }, false);
}
