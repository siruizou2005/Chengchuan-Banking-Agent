import { readFileSync } from 'node:fs';

const fixtures = JSON.parse(readFileSync(new URL('./seed/fixture-statements.json', import.meta.url), 'utf8'));
// The running system's accounts. Their numbers are random and may belong to someone, so no real SMS or email may ever go to them.
const DEMO_PHONES = ['18662995523', '15040147842'];
// Fixture numbers only mean something where they were seeded; in the running system anyone may register them like any other number.
const FIXTURE_PHONES = ['13800138000', '13900139000', ...fixtures.users.map(user => user.phone)];
// Their credentials are printed on the login page. Locking or changing them would only let one visitor shut out the rest, and there is no secret to protect.
export const hasPublicCredentials = user => DEMO_PHONES.includes(user.phone);
export function demoUserCheck(accounts) {
  const phones = new Set(accounts === 'demo' ? DEMO_PHONES : [...DEMO_PHONES, ...FIXTURE_PHONES]);
  return user => phones.has(user.phone);
}
// Demo addresses use the reserved example.com domain, so their codes are shown on the page.
export const DEMO_EMAILS = Object.freeze({ '13800138000': 'linzhixia@example.com', '13900139000': 'chenyu@example.com', '18662995523': 'zourui@example.com', '13500135000': 'wanjin@example.com', '15040147842': 'wanqi@example.com' });
