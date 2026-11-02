import { readFileSync } from 'node:fs';

const fixtures = JSON.parse(readFileSync(new URL('./seed/fixture-statements.json', import.meta.url), 'utf8'));
const demoPhones = new Set(['13800138000', '13900139000', ...fixtures.users.map(user => user.phone)]);
// Demo phone numbers are random and may belong to someone, so no real SMS or email may ever go to them.
export const isDemoUser = user => demoPhones.has(user.phone);
// Demo addresses use the reserved example.com domain, so their codes are shown on the page.
export const DEMO_EMAILS = Object.freeze({ '13800138000': 'linzhixia@example.com', '13900139000': 'chenyu@example.com', '18662995523': 'zourui@example.com', '13500135000': 'wanjin@example.com', '15040147842': 'wanqi@example.com' });
