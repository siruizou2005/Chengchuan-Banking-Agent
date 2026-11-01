import { yuan } from '../api';

export type BillPoint = { key: string; consumption: number };
export type BillEntry = { id: number; transaction_id: string; title: string; merchant: string | null; tag: string; kind: string; amount: number; bj_time: string };
type Totals = { consumption: number; consumptionGross: number; consumptionCount: number; income: number; count: number };
type Category = { name: string; share: number; amount: number; count: number };
type Bucket = { key: string; amount: number; count: number };
export type Topic = 'hidden_consumption' | 'personalized_bill';
export type BillData = {
  from: string; to: string; totals: Totals; categories: Category[]; daily: BillPoint[]; monthly: BillPoint[]; entries: BillEntry[];
  previous: { totals: Totals; categories: Category[]; hidden: number } | null;
  hidden: { total: number; groups: { name: string; rule: string; ids: number[]; amount: number }[] };
  personalized: boolean; labels: Partial<Record<Topic, string>>; weekdays: Bucket[]; hours: Bucket[];
};
export const money = (value: number, masked: boolean) => masked ? '••••' : '¥' + yuan(value);
export const percent = (share: number) => (share * 100).toFixed(1) + '%';
export const change = (value: number, prior?: number) => {
  if (prior == null || prior <= 0) return '暂无可比基数';
  const ratio = (value - prior) / prior;
  return (ratio > 0 ? '+' : '') + percent(ratio);
};
