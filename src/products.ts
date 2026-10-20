import type { Product, ProductMeta } from './types';

export const CATEGORIES = [{ id: 'all', label: '全部' }, { id: 'money', label: '货币' }, { id: 'bond', label: '债券' }, { id: 'mixed', label: '混合' }, { id: 'equity', label: '股票' }, { id: 'index', label: '指数' }, { id: 'qdii', label: 'QDII' }];
export const RISK_TYPE: Record<number, string> = { 1: '保守型', 2: '稳健型', 3: '平衡型', 4: '成长型', 5: '进取型' };
export const riskTag = (level: number) => level ? `R${level} ${RISK_TYPE[level]}` : '未测评';
export const minText = (p: Product) => { const y = p.minimum / 100; return `${y >= 10000 ? `${y / 10000}万` : y.toLocaleString('zh-CN')}元起${p.type === 'deposit' ? '存' : '购'}`; };
export const pct = (v?: number | null) => v === null || v === undefined ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
// "限大额(单日投资上限500万元)" reads better as "限大额".
export const statusText = (p: Product) => p.purchaseStatus?.replace(/\(.*\)$/, '') ?? '';
export const sourceLine = (meta?: ProductMeta) => meta ? `数据来源：${meta.source} · 更新于 ${new Date(meta.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}` : '';
// Featured slots favour R1–R2 products people can actually buy, not the volatile top performer.
export const featuredFund = (products: Product[]) => products.filter(p => p.type === 'wealth' && p.purchasable && (p.riskLevel ?? 0) <= 2 && p.rate !== null).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
