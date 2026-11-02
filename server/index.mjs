import { createApp } from './app.mjs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { redactIdentity } from './privacy.mjs';
import { createResendProvider } from './email.mjs';

const production = process.argv.includes('--production');
const { app, bank, maintenance, channels, services } = createApp(process.env.BANK_DB || resolve('data/bank.sqlite'), {
  accounts: 'demo',
  trustProxy: process.env.TRUST_PROXY === 'true',
  secureCookies: process.env.SESSION_SECURE === 'true',
  publicOrigin: process.env.PUBLIC_ORIGIN || '',
  // Fund data is fetched on demand when a page or the assistant needs it; there is no polling timer.
  // Email codes go out through Resend only when a key is configured; otherwise they stay simulated.
  sms: { email: process.env.RESEND_API_KEY ? createResendProvider({ apiKey: process.env.RESEND_API_KEY, from: process.env.OTP_EMAIL_FROM || undefined }) : undefined },
  products: { remote: process.env.PRODUCT_DATA_REMOTE !== 'false', ttlMs: Number(process.env.PRODUCT_CACHE_MINUTES || 360) * 60000 },
});
const server = createServer(app);
if(process.env.NODE_ENV !== 'test') await channels.start();
// Never allow the development file server to serve local credentials.
app.use((req, res, next) => {
  let path;
  try { path = decodeURIComponent(req.path).replaceAll('\\', '/'); } catch { return res.sendStatus(400); }
  if (/(^|\/)(api\.txt|\.env[^/]*)(\/|$)/i.test(path)) return res.sendStatus(404);
  next();
});
let vite;
if (production) {
  const { default: express } = await import('express');
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  // Load vite.config.ts in memory; the default bundler writes a temp file that makes `node --watch` restart in a loop.
  vite = await createViteServer({ configLoader: 'runner', server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || (production ? 3000 : 5173));
const maintenanceTimer = setInterval(() => { try { maintenance(); } catch (error) { console.error('Bank maintenance error:', redactIdentity(error.message)); } }, 30000);
maintenanceTimer.unref();
server.listen(port, '127.0.0.1', () => console.log(`澄川银行已启动：http://127.0.0.1:${port}`));
async function shutdown() { clearInterval(maintenanceTimer); services.merchantCategories.stop(); await channels.stop(); await vite?.close(); server.close(() => { bank.db.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
