import { createApp } from './app.mjs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

const production = process.argv.includes('--production');
const { app, bank, maintenance } = createApp(process.env.BANK_DB || resolve('data/bank.sqlite'), {
  trustProxy: process.env.TRUST_PROXY === 'true',
  secureCookies: process.env.SESSION_SECURE === 'true',
  publicOrigin: process.env.PUBLIC_ORIGIN || '',
});
const server = createServer(app);
let vite;
if (production) {
  const { default: express } = await import('express');
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 3000);
const maintenanceTimer = setInterval(() => { try { maintenance(); } catch (error) { console.error('Bank maintenance error:', error.message); } }, 30000);
maintenanceTimer.unref();
server.listen(port, '127.0.0.1', () => console.log(`澄川银行已启动：http://127.0.0.1:${port}`));
async function shutdown() { clearInterval(maintenanceTimer); await vite?.close(); server.close(() => { bank.db.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
