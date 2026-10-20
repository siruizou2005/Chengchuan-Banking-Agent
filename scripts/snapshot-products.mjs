// Refreshes the bundled fallback catalog served when Eastmoney is unreachable: npm run snapshot:products
import { writeFileSync } from 'node:fs';
import { fetchCatalog, FUND_CODES, FUND_SOURCE } from '../server/products.mjs';

const result = await fetchCatalog(undefined, { codes: FUND_CODES, timeoutMs: 8000, concurrency: 4 });
if (result.failed.length) console.warn(`未获取：${result.failed.join(',')}`);
if (result.funds.length < FUND_CODES.length * 0.8) { console.error(`仅获取 ${result.funds.length}/${FUND_CODES.length} 只基金，未写入快照`); process.exit(1); }
const file = new URL('../server/fund-snapshot.json', import.meta.url);
writeFileSync(file, JSON.stringify({ capturedAt: result.fetchedAt, source: FUND_SOURCE, funds: result.funds, market: result.market || [] }, null, 1) + '\n');
console.log(`已写入 ${result.funds.length} 只基金与 ${result.market?.length || 0} 个指数：${file.pathname}`);
