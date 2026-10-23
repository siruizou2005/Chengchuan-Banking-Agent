// GitHub push webhook. systemd socket activation starts it per delivery and it exits when idle, so nothing stays
// resident. It only verifies the signature and writes the deploy request file; the deploy runs in its own unit.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const secret = process.env.GITHUB_WEBHOOK_SECRET, requestFile = process.env.DEPLOY_REQUEST_FILE, branch = process.env.DEPLOY_BRANCH || 'master';
if (!secret || !requestFile) { console.error('缺少 GITHUB_WEBHOOK_SECRET 或 DEPLOY_REQUEST_FILE'); process.exit(1); }

function validSignature(body, header, key = secret) {
  const expected = Buffer.from('sha256=' + createHmac('sha256', key).update(body).digest('hex')), given = Buffer.from(String(header || ''));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const server = createServer((req, res) => {
  const chunks = []; let size = 0;
  req.on('data', chunk => { size += chunk.length; if (size > 1048576) { res.writeHead(413).end(); req.destroy(); } else chunks.push(chunk); });
  req.on('end', () => {
    if (res.writableEnded) return;
    if (req.method !== 'POST' || req.url !== '/_deploy/github') return res.writeHead(404).end();
    const body = Buffer.concat(chunks);
    if (!validSignature(body, req.headers['x-hub-signature-256'])) return res.writeHead(401).end();
    const event = req.headers['x-github-event'];
    if (event === 'ping') return res.writeHead(200).end('pong');
    let payload; try { payload = JSON.parse(body); } catch { return res.writeHead(400).end(); }
    if (event !== 'push' || payload.ref !== `refs/heads/${branch}` || payload.deleted) return res.writeHead(202).end('ignored');
    writeFileSync(requestFile, `${payload.after}\n`);
    console.log(`push ${String(payload.after).slice(0, 7)}：已请求部署`);
    res.writeHead(202).end('queued');
  });
});

let idle;
function arm() { clearTimeout(idle); idle = setTimeout(() => server.close(() => process.exit(0)), 30000); }
server.on('request', arm);
// fd 3 is the listening socket handed over by systemd; it stays open while this process is gone.
server.listen({ fd: 3 }, arm);
