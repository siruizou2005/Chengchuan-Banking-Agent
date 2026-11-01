export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}
export async function api<T = any>(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error?.message || '请求未完成，请稍后重试', res.status, data.error?.code || 'UNKNOWN');
  return data;
}
export const yuan = (cents: number) => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function transferAmountMinor(text: string) {
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(text)) throw new Error('请填写正确金额，最多两位小数');
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export const date = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export const tail = (number: string) => number.slice(-4);
export const formValues = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); return Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>; };
export const statusLabel: Record<string, string> = { pending: '待确认', completed: '交易成功', failed: '交易失败', cancelled: '已取消', expired: '已过期' };
