import { createHash } from 'node:crypto';
export class BusinessError extends Error {
  constructor(message, status = 400, code = 'VALIDATION_ERROR') { super(message); this.status = status; this.code = code; }
}
export const fail = (message, status, code) => { throw new BusinessError(message, status, code); };
export const requireThat = (test, message, status, code) => { if (!test) fail(message, status, code); };
export const hash = value => createHash('sha256').update(value).digest('hex');
export const textField = (v, label, min = 1, max = 80) => { requireThat(typeof v === 'string' && v.trim().length >= min && v.trim().length <= max, `请正确填写${label}`); return v.trim(); };
export function cents(v) {
  const s = String(v ?? '');
  requireThat(/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(s), '金额须为正数，最多保留两位小数');
  const [whole, fraction = ''] = s.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  requireThat(result > 0 && result <= 1000000000, '金额须大于0且不超过1,000万元');
  return result;
}
