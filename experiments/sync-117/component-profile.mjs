// Node-only counterpart of the native renderer measurement object.
globalThis.window = globalThis;
// Exact compiled plugin primitives over verified loopback TLS; no Obsidian API claims.
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { request, Agent } from 'node:https';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = process.argv[2];
if (!/^(?:\/private)?\/tmp\/obsync-pi-lab-[a-f0-9]{16}$/.test(root ?? '') || process.version !== 'v26.10.0')
  throw Error('Owned scratch and pinned runtime required');
const require = createRequire(import.meta.url);
const c = require(join(root, 'inputs/crypto.js'));
const { chunkStream } = require(join(root, 'inputs/chunker.js'));
const config = JSON.parse(await readFile(join(root, 'private/client.json'), 'utf8'));
const ca = await readFile(join(root, 'inputs/tls.crt'));
const agent = new Agent({ keepAlive: true, maxSockets: 1, ca });
const encode = value => Buffer.from(JSON.stringify(value));
let stages = {}, active = false, credential;
const record = (name, at, bytes = 0) => {
  const row = stages[name] ??= { count: 0, ms: 0, bytes: 0 };
  row.count++; row.ms += performance.now() - at; row.bytes += bytes;
};
for (const name of ['digest', 'sign', 'deriveBits', 'encrypt', 'decrypt', 'importKey']) {
  const original = crypto.subtle[name];
  crypto.subtle[name] = async function(...args) {
    const at = performance.now(), enabled = active;
    try { return await original.apply(this, args); }
    finally { if (enabled) record('crypto_' + name, at, (name === 'digest' ? args[1]?.byteLength : args[2]?.byteLength) ?? 0); }
  };
}
const measure = async (name, operation, bytes = 0) => {
  const at = performance.now();
  try { return await operation(); } finally { record(name, at, bytes); }
};
async function call(method, path, body = Buffer.alloc(0), sid) {
  const headers = { Host: `obsync-bench.invalid:${config.port}`, 'Content-Length': body.length,
    'Content-Type': sid ? 'application/octet-stream' : 'application/json' };
  if (credential) {
    const ts = Math.floor(Date.now() / 1000), nonce = c.hex(c.randomBytes(16));
    Object.assign(headers, { 'X-Obsync-Device': credential.device_id, 'X-Obsync-Ts': String(ts),
      'X-Obsync-Nonce': nonce, 'X-Obsync-Sig': await c.signRequest(c.unhex(credential.device_secret),
        method, path, ts, nonce, sid ?? await c.bodyHash(body)) });
  }
  const at = performance.now();
  try {
    return await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: config.port, servername: 'obsync-bench.invalid',
        method, path, headers, agent, rejectUnauthorized: true, timeout: 15000 }, response => {
        let length = 0; const parts = [];
        response.on('data', part => {
          length += part.length;
          if (length > (16 << 20)) response.destroy(Error('Response budget'));
          else parts.push(part);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(parts) }));
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(Error('Request deadline'))); req.end(body);
    });
  } finally {
    if (active) record(method === 'PUT' ? 'request_chunk_put' : method === 'POST' ? 'request_version_post' : 'request_chunk_get', at, body.length);
  }
}
const expect = (answer, statuses) => {
  if (!statuses.includes(answer.status)) throw Error('Unexpected protocol status ' + answer.status);
  return answer.body;
};
const base = join(root, 'runtime', config.pass), fixtures = join(base, 'fixtures'), applied = join(base, 'applied');
const serverLog = join(root, 'private', config.pass + '-server.log');
const output = [];
try {
  await mkdir(fixtures, { mode: 0o700 }); await mkdir(applied, { mode: 0o700 });
  const small = [];
  for (let i = 0; i < 128; i++) {
    const name = 'stage-' + String(i).padStart(3, '0') + '.md'; small.push(name);
    await writeFile(join(fixtures, name), `STAGE PROFILE SENTINEL ${i}\n${'a'.repeat(8192)}`, { mode: 0o600 });
  }
  const bytes = new Uint8Array((32 << 20) + 1); let value = 1;
  for (let i = 0; i < bytes.length; i++) { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; bytes[i] = value >>> 24; }
  await writeFile(join(fixtures, 'stage-large.bin'), bytes, { mode: 0o600 });
  credential = JSON.parse(expect(await call('POST', '/v1/setup', encode({ setup_token: config.setupToken,
    account_name: 'synthetic stage lab', device: { name: 'component probe', platform: process.platform === 'darwin' ? 'macos' : 'linux', app_version: 'lab' } })), [201]));
  const domainId = c.hex(c.randomBytes(16));
  const domain = await c.deriveDomainKey(c.randomBytes(32), domainId), manifestKey = await c.deriveManifestKey(domain, domainId);
  const state = [];
  for (const [scenario, names] of [['small-notes', small], ['large-file', ['stage-large.bin']], ['unchanged-verify', [...small, 'stage-large.bin']]]) {
    const offset = (await readFile(serverLog)).length;
    stages = {}; globalThis.__obsyncStages = { cutMs: 0, cuts: 0 }; active = true;
    const at = performance.now();
    for (const name of names) {
      const file = await open(join(fixtures, name), 'r');
      try {
        const stat = await file.stat(), source = { size: stat.size, read: async (offset, length) => {
          return measure('read_window', async () => {
            const buffer = Buffer.alloc(length), result = await file.read(buffer, 0, length, offset);
            return buffer.subarray(0, result.bytesRead);
          }, length);
        } };
        if (scenario === 'unchanged-verify') {
          for await (const plain of chunkStream(source)) await c.sha256(plain);
          continue;
        }
        const fileId = c.hex(c.randomBytes(16)), chunks = [], plaintext = [];
        for await (const plain of chunkStream(source)) {
          const chunk = await measure('encrypt_inclusive', () => c.encryptChunk(domain, plain), plain.length);
          chunks.push({ cid: c.hex(chunk.cid), sid: chunk.sid, len: plain.length }); plaintext.push(Buffer.from(plain));
          expect(await call('PUT', `/v1/chunks/${chunk.sid}`, Buffer.from(chunk.ciphertext), chunk.sid), [200, 201]);
        }
        const sids = chunks.map(x => x.sid), binder = await c.contentVersionId(fileId, [], sids);
        const manifest = await c.encryptManifest(manifestKey, fileId, binder, JSON.stringify({ path: name, chunks }));
        const version = await c.versionId(fileId, [], manifest.ciphertext, sids);
        expect(await call('POST', `/v1/files/${fileId}/versions`, encode({ version_id: version, parents: [], sids,
          bytes: stat.size, domain_id: domainId, manifest_ct: c.base64(manifest.ciphertext), manifest_nonce: c.hex(manifest.nonce), deleted: false })), [201]);
        const received = [];
        for (const chunk of chunks) {
          const encrypted = expect(await call('GET', `/v1/chunks/${chunk.sid}`), [200]);
          if (c.hex(await c.sha256(encrypted)) !== chunk.sid) throw Error('Ciphertext integrity mismatch');
          received.push(Buffer.from(await c.decryptChunk(domain, c.unhex(chunk.cid), encrypted)));
        }
        const original = Buffer.concat(plaintext), opened = Buffer.concat(received);
        if (!original.equals(opened)) throw Error('Decrypted bytes differ');
        await measure('standalone_apply', async () => {
          const target = await open(join(applied, name), 'wx', 0o600);
          try { await target.writeFile(opened); await target.sync(); } finally { await target.close(); }
        }, opened.length);
        if (!(await readFile(join(applied, name))).equals(original)) throw Error('Independent disk bytes differ');
        state.push({ fileId, version });
      } finally { await file.close(); }
    }
    const wallMs = performance.now() - at; active = false;
    const server = {};
    for (const line of (await readFile(serverLog)).subarray(offset).toString().split('\n')) {
      const match = /LAB_STAGE (\w+) (.*)/.exec(line); if (!match) continue;
      const row = server[match[1]] ??= { count: 0 }; row.count++;
      for (const field of match[2].matchAll(/(\w+)=(\d+)/g)) row[field[1]] = (row[field[1]] ?? 0) + Number(field[2]);
    }
    output.push({ scenario, files: names.length, wallMs, ...globalThis.__obsyncStages, stages, server });
  }
  if (state.length !== 129) throw Error('Independent note count differs');
  await writeFile(join(root, 'evidence', `${config.pass}.json`), JSON.stringify({ result: 'PASS',
    boundary: 'Compiled plugin primitives under Node; verified TLS; synthetic filesystem; native Obsidian NOT_RUN',
    stageTiming: 'Nested operations overlap; do not sum them', maxRssKiB: process.resourceUsage().maxRSS, output }, null, 2) + '\n', { mode: 0o600 });
} finally { agent.destroy(); }
