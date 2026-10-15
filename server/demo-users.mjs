import { readFileSync } from 'node:fs';

const imported = JSON.parse(readFileSync(new URL('./seed/imported-statements.json', import.meta.url), 'utf8'));
const demoPhones = new Set(['13800138000', '13900139000', ...imported.users.map(user => user.phone)]);
export const isDemoUser = user => demoPhones.has(user.phone);
