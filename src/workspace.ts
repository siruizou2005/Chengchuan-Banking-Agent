// Route ownership is shared by the home grid and embedded navigation. Deep links
// still resolve through App's original page registry.
export const featureGroups = {
  accounts: ['accounts', 'receive', 'scan', 'payees'],
  wealth: ['wealth', 'deposit', 'funds', 'risk', 'advice'],
  transfer: ['transfer', 'transactions'],
  credit: ['credit'],
  loan: ['loan'],
  life: ['life', 'appointments', 'support'],
  ledger: ['ledger'],
  services: ['services', 'search', 'security', 'messages', 'agent', 'personalization', 'tasks', 'channels', 'feishu-requests', 'wechat-requests'],
} as const;
export type Feature = keyof typeof featureGroups;
export function routePage(route: string) { return route.split(/[?/]/)[0]; }
export function featureForRoute(route: string): Feature | undefined {
  const page = routePage(route);
  return (Object.entries(featureGroups).find(([, pages]) => (pages as readonly string[]).includes(page))?.[0]) as Feature | undefined;
}
