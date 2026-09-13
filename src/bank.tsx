import { createContext, useContext, type ReactNode } from 'react';
import type { Snapshot, Transaction } from './types';

export type BankContextValue = {
  data: Snapshot; busy: boolean; route: string; hidden: boolean;
  formError: { message: string; code: string } | null; clearFormError: () => void;
  navigate: (route: string) => void; refresh: () => Promise<void>; toggleHidden: () => void;
  begin: (body: Record<string, unknown>) => Promise<void>;
  mutate: (path: string, body: unknown, success: string, method?: string) => Promise<boolean>;
  openModal: (title: string, content: ReactNode) => void; closeModal: () => void;
  showTransaction: (tx: Transaction) => void;
  toast: (message: string, error?: boolean) => void; logout: () => void;
};
export const BankContext = createContext<BankContextValue | null>(null);
export const useBank = () => useContext(BankContext)!;
