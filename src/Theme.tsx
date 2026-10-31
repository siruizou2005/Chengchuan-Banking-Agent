import { createContext, useContext, type ReactNode } from 'react';

export type Theme = 'home' | 'wealth' | 'assistant' | 'life' | 'profile';
const ThemeContext = createContext<Theme>('home');
export const useTheme = () => useContext(ThemeContext);

// Explicit ownership also covers direct links, restored sessions and nested requests.
export function themeForPage(page: string): Theme {
  if (['wealth', 'deposit', 'funds', 'risk', 'advice', 'loan', 'credit', 'earnings', 'asset-proof'].includes(page)) return 'wealth';
  if (['assistant', 'tasks', 'feishu-requests', 'wechat-requests'].includes(page) || page.startsWith('pay-request/')) return 'assistant';
  if (['life', 'appointments', 'support'].includes(page)) return 'life';
  if (['profile', 'accounts', 'security', 'messages', 'agent', 'transactions', 'payees', 'personalization', 'channels', 'face-return'].includes(page)) return 'profile';
  return 'home';
}

export function BankTheme({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}><div className={`bank-theme theme-${theme}`} data-theme={theme}>{children}</div></ThemeContext.Provider>;
}
