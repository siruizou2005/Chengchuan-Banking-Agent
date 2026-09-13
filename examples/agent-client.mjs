// Creates and cancels a virtual transfer; does not finalize any transfer.
import { randomUUID } from 'node:crypto';
const base = process.env.BANK_URL || 'http://127.0.0.1:3000';
const credentials = { phone: process.env.BANK_PHONE || '13800138000', password: process.env.BANK_PASSWORD || 'Bank123456' };
let token;
async function request(path, body, key) {
  const response = await fetch(base + '/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'API request failed');
  return result;
}
token = (await request('/auth/login', credentials)).token;
try {
  const accounts = await request('/accounts');
  console.log('账户可用余额（分）:', accounts[0].available);
  const transaction = await request('/transactions', { type: 'transfer', amount: '1.00', recipientName: '陈屿', recipientAccount: '6218808888000088096', bank: '澄川银行', note: 'Agent接入演示' }, randomUUID());
  console.log('已创建:', transaction.id, transaction.status);
  const cancelled = await request(`/transactions/${transaction.id}/cancel`, {});
  console.log('已取消:', cancelled.status);
} finally { await request('/auth/logout', {}); }
