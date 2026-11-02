import { readFileSync } from 'node:fs';
// Documents the user must accept before the assistant opens. Bumping a version makes every user re-accept before the next use.
const body = file => readFileSync(new URL(`./agreements/${file}`, import.meta.url), 'utf8');
export const AGREEMENTS = Object.freeze([
  { id: 'service', title: '智能助手服务协议', version: '1.0', effectiveDate: '2026-10-22', summary: '服务范围、资金操作须在App确认、开通与关闭', body: body('service.md') },
  { id: 'privacy', title: '个人信息处理授权书', version: '1.1', effectiveDate: '2026-11-01', summary: '读取哪些账户数据、用途、委托处理与你的权利', body: body('privacy.md') },
  { id: 'risk', title: '风险提示书', version: '1.0', effectiveDate: '2026-10-22', summary: 'AI回答可能有误、理财不保证收益、渠道使用风险', body: body('risk.md') },
]);
