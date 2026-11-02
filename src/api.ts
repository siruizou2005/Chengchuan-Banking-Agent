export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}
export async function api<T = any>(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>): Promise<T> {
  let res: Response;
  try { res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw new ApiError('网络连接失败，请重试', 0, 'NETWORK_ERROR'); }
  // A gateway in front of the server answers with an HTML page, not the JSON envelope.
  const data = await res.json().catch(() => undefined);
  if (!res.ok || data === undefined) throw new ApiError(data?.error?.message || '请求未完成，请稍后重试', res.status, data?.error?.code || 'UNKNOWN');
  return data;
}
// Submits each proof until the server accepts the PIN. The server checks the PIN before it consumes the
// verification token, so a wrong one can be retyped without verifying again. Anything else, including the rate limit, is thrown.
export async function retryWrongPin<P, T>(ask: () => Promise<P | null>, submit: (proof: P) => Promise<T>, onWrongPin: (error: ApiError) => void): Promise<{ result: T } | null> {
  for (let proof = await ask(); proof; proof = await ask()) {
    try { return { result: await submit(proof) }; }
    catch (e) { if (!(e instanceof ApiError && e.code === 'INVALID_PIN')) throw e; onWrongPin(e); }
  }
  return null;
}
// `|| 0` turns -0, which an empty negative sum produces, into 0: it would print as "-0.00".
export const yuan = (cents: number) => (cents / 100 || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const masked = (hidden: boolean, text: string) => hidden ? '****' : text;
export function transferAmountMinor(text: string) {
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(text)) throw new Error('请填写正确金额，最多两位小数');
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export const date = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export const tail = (number: string) => number.slice(-4);
export const formValues = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); return Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>; };
export const statusLabel: Record<string, string> = { pending: '待确认', completed: '交易成功', failed: '交易失败', cancelled: '已取消', expired: '已过期' };
