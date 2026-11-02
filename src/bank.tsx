import { createContext, useContext, type ReactNode } from 'react';
import type { Snapshot, Transaction } from './types';

export type BankContextValue = {
  data: Snapshot; busy: boolean; route: string; hidden: boolean;
  formError: { message: string; code: string } | null; clearFormError: () => void;
  navigate: (route: string) => void; navigatePage: (route: string) => void; toggleHidden: () => void;
  // Never rejects: the caller's own work is done, so a failed reload must not read as a failed operation.
  refresh: () => Promise<void>;
  askAgent: (text: string) => void;
  begin: (body: Record<string, unknown>) => Promise<void>;
  mutate: (path: string, body: unknown, success: string, method?: string) => Promise<boolean>;
  openModal: (title: string, content: ReactNode) => void; closeModal: () => void;
  showTransaction: (tx: Transaction) => void;
  toast: (message: string, error?: boolean) => void; logout: () => void;
};
export const BankContext = createContext<BankContextValue | null>(null);
export const useBank = () => useContext(BankContext)!;

export function WorkspaceBank({ route, children }: { route: string; children: ReactNode }) {
  const bank = useBank();
  return <BankContext.Provider value={{ ...bank, route }}>{children}</BankContext.Provider>;
}
