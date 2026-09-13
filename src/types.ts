export type User = { id: string; name: string; phone: string; dailyLimit: number; riskLevel: number; createdAt: string };
export type Account = { id: string; number: string; name: string; balance: number; held: number; available: number; status: string };
export type Product = { id: string; type: string; name: string; subtitle: string; rate: number; days: number; minimum: number; risk: string; tags: string[]; description: string };
export type Holding = { id: string; product_id: string; principal: number; created_at: string; unlock_at: string; product: Product };
export type Loan = { id: string; principal: number; outstanding: number; months: number; status: string; created_at: string };
export type Transaction = { id: string; type: string; amount: number; title: string; status: string; payload: Record<string, any>; account_id: string; created_at: string; updated_at: string; expires_at: string; error?: string };
export type Ledger = { id: number; transaction_id: string; amount: number; balance_after: number; title: string; category: string; created_at: string; number: string };
export type Snapshot = {
  user: User; accounts: Account[]; holdings: Holding[]; loans: Loan[]; products: Product[];
  ledger: Ledger[]; transactions: Transaction[];
  creditCard: { id: string; number: string; credit_limit: number; used: number; status: string };
  payees: { id: string; name: string; number: string; bank: string }[];
  notifications: { id: string; title: string; body: string; is_read: number; created_at: string }[];
  tickets: { id: string; subject: string; content: string; status: string; created_at: string }[];
  appointments: { id: string; branch: string; service: string; date: string; status: string }[];
};
