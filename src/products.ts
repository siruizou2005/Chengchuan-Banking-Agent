import type { Product, ProductMeta } from './types';

export const CATEGORIES = [{ id: 'all', label: '全部' }, { id: 'money', label: '货币' }, { id: 'bond', label: '债券' }, { id: 'mixed', label: '混合' }, { id: 'equity', label: '股票' }, { id: 'index', label: '指数' }, { id: 'qdii', label: 'QDII' }];
export const RISK_TYPE: Record<number, string> = { 1: '保守型', 2: '稳健型', 3: '平衡型', 4: '成长型', 5: '进取型' };
export const riskTag = (level: number) => level ? `R${level} ${RISK_TYPE[level]}` : '未测评';
// 每题按选项顺序计1–4分，服务端 riskLevelFor 换算为 R1–R5。
export const RISK_QUESTIONS = [
  { key: 'a', title: '您的投资经验', options: ['没有投资经验', '只买过存款或货币基金', '买过债券基金或银行理财', '买过股票或偏股基金三年以上'] },
  { key: 'b', title: '您能接受的最大本金亏损', options: ['不能接受亏损', '5%以内', '5%至20%', '20%以上'] },
  { key: 'c', title: '这笔资金的计划投资期限', options: ['3个月以内', '3个月至1年', '1至3年', '3年以上'] },
  { key: 'd', title: '投资资产占家庭总资产的比例', options: ['50%以上', '30%至50%', '10%至30%', '10%以下'] },
  { key: 'e', title: '您的主要投资目标', options: ['保本保息', '略高于存款的稳定收益', '收益与风险兼顾', '追求较高收益，可承受较大波动'] },
];
export const minText = (p: Product) => { const y = p.minimum / 100; return `${y >= 10000 ? `${y / 10000}万` : y.toLocaleString('zh-CN')}元起${p.type === 'deposit' ? '存' : '购'}`; };
export const pct = (v?: number | null) => v === null || v === undefined ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
// "限大额(单日投资上限500万元)" reads better as "限大额".
export const statusText = (p: Product) => p.purchaseStatus?.replace(/\(.*\)$/, '') ?? '';
export const sourceLine = (meta?: ProductMeta) => meta ? `数据来源：${meta.source} · 更新于 ${new Date(meta.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}` : '';
// Featured slots favour R1–R2 products people can actually buy, not the volatile top performer.
export const featuredFund = (products: Product[]) => products.filter(p => p.type === 'wealth' && p.purchasable && (p.riskLevel ?? 0) <= 2 && p.rate !== null).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
// Home slots summarise a whole fund group by its median, so a single outlier never sets the headline figure.
export function categoryMedian(products: Product[], match: (p: Product) => boolean, metric: (p: Product) => number | null | undefined) {
  const group = products.filter(p => p.type === 'wealth' && match(p));
  const values = group.map(metric).filter((v): v is number => v != null).sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = values.length >> 1, levels = group.map(p => p.riskLevel ?? 0).filter(Boolean);
  return { value: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2, count: values.length, minRisk: Math.min(...levels), maxRisk: Math.max(...levels) };
}
