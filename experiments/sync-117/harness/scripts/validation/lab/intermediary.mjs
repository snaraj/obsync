// Optional lab-only fault boundary. Stream ciphertext; never record headers/bodies.
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const [listen, upstream, control] = process.argv.slice(2);
if (![listen, upstream].every(p => /^\d+$/.test(p) && +p > 1024 && +p < 65536)) throw Error('invalid loopback ports');
function faults() {
  const value = JSON.parse(readFileSync(control, 'utf8'));
  if (!Number.isInteger(value.walkCuts) || value.walkCuts < 0 || value.walkCuts > 1000 ||
      (value.offline !== undefined && typeof value.offline !== 'boolean') ||
      !Number.isInteger(value.chunkDelayMs) || value.chunkDelayMs < 0 || value.chunkDelayMs > 30000) throw Error('invalid fault budget');
  return value;
}
http.createServer((req, res) => {
  let policy;
  try { policy = faults(); } catch { res.writeHead(503); res.end(); return; }
  if (policy.offline === true) { req.socket.destroy(); return; }
  const url = new URL(req.url, 'http://lab.invalid');
  if (req.method === 'GET' && url.pathname === '/v1/changes' && url.searchParams.get('wait') === '0' && url.searchParams.get('limit') === '1000' && policy.walkCuts > 0) {
    policy.walkCuts--; writeFileSync(control, JSON.stringify(policy), { mode: 0o600 });
    console.log(JSON.stringify({ event: 'walk_cut', remaining: policy.walkCuts }));
    req.socket.destroy(); return;
  }
  const forward = () => {
    const out = http.request({ host: '127.0.0.1', port: +upstream, method: req.method, path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${upstream}` } }, up => {
      res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res);
      res.on('close', () => up.destroy());
    });
    out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => out.destroy()); req.pipe(out);
  };
  if (req.method === 'GET' && /^\/v1\/chunks\/[a-f0-9]+$/.test(url.pathname) && policy.chunkDelayMs) setTimeout(forward, policy.chunkDelayMs);
  else forward();
}).listen(+listen, '127.0.0.1');
