import { readFileSync } from 'node:fs';

const imported = JSON.parse(readFileSync(new URL('./seed/imported-statements.json', import.meta.url), 'utf8'));
const demoPhones = new Set(['13800138000', '13900139000', ...imported.users.map(user => user.phone)]);
export const isDemoUser = user => demoPhones.has(user.phone);
// Demo addresses use the reserved example.com domain, so their codes are shown on the page.
// 邹瑞 is the project owner's own account and receives real email codes.
// The owner's own account (邹瑞) is not a public demo login: its password lives here only as a scrypt
// hash, and its real address is exempt from the daily email caps.
export const OWNER_PHONE = '19900000000';
export const OWNER_PASSWORD_HASH = 'REDACTED:REDACTED';
export const UNLIMITED_EMAILS = new Set(['owner@example.com']);
export const DEMO_EMAILS = Object.freeze({ '13800138000': 'linzhixia@example.com', '13900139000': 'chenyu@example.com', '19900000000': 'owner@example.com', '13500135000': 'wanjin@example.com', '13300133000': 'wanqi@example.com' });
