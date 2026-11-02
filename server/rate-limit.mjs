import { requireThat } from './errors.mjs';

const LIMIT = 8, WINDOW_MS = 900000;
// One key per account, so these cannot outgrow the user count and a live counter is never given up.
const PER_ACCOUNT = new Set(['pin', 'verify', 'login-phone']);

// In-process failure counters, one table per key family (the text before the first colon), so a flood of keys can only
// displace its own kind. A table stays in first-failure order, which is also expiry order because a window never moves.
export function createRateLimiter({ capacity = 10000 } = {}) {
  const families = new Map();
  const familyOf = key => key.split(':', 1)[0];
  function tableFor(key) {
    const family = familyOf(key);
    if (!families.has(family)) families.set(family, new Map());
    return families.get(family);
  }
  function checkRate(key) {
    const table = tableFor(key), entry = table.get(key);
    if (entry && entry.until < Date.now()) table.delete(key);
    requireThat(!table.get(key) || table.get(key).count < LIMIT, '尝试次数过多，请15分钟后再试', 429, 'RATE_LIMITED');
  }
  function badAttempt(key) {
    const table = tableFor(key), time = Date.now();
    for (const [other, entry] of table) { if (entry.until >= time) break; table.delete(other); }
    const old = table.get(key);
    if (!old && table.size >= capacity && !PER_ACCOUNT.has(familyOf(key))) table.delete(table.keys().next().value);
    table.set(key, { count: (old?.count || 0) + 1, until: old?.until || time + WINDOW_MS });
  }
  const clearRate = key => { tableFor(key).delete(key); };
  return { checkRate, badAttempt, clearRate };
}
