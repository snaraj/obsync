#!/usr/bin/env node
// Measurement-only native Obsidian run. All data is synthetic and stays in this run.
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { connect, manifest, sleep } from './cdp.mjs';

const [run] = process.argv.slice(2), state = manifest(run), c = await connect(state, 'A');
const output = [];
try {
  await c.evaluate(`const p = app.plugins.plugins['obsync-private-sync'];
    if (!p.state.paired || !p.engine?.context || Object.keys(p.state.data.files).length) throw Error('fresh paired empty vault required');
    const m = globalThis.__obsyncStages = { cutMs: 0, cuts: 0, stages: {}, active: false };
    const record = (name, at, bytes = 0) => {
      const row = m.stages[name] ??= { count: 0, ms: 0, bytes: 0 };
      row.count++; row.ms += performance.now() - at; row.bytes += bytes;
    };
    const wrap = (object, name, label, bytes = () => 0) => {
      const original = object[name];
      object[name] = async function(...args) {
        const active = m.active, at = performance.now();
        try { return await original.apply(this, args); }
        finally { if (active) record(typeof label === 'function' ? label(args) : label, at, bytes(args)); }
      };
    };
    for (const name of ['digest', 'sign', 'deriveBits', 'encrypt', 'decrypt', 'importKey'])
      wrap(crypto.subtle, name, 'crypto_' + name, a => (name === 'digest' ? a[1]?.byteLength : a[2]?.byteLength) ?? 0);
    const host = p.engine.context.host;
    wrap(host, 'read', 'read_file');
    const source = host.source;
    host.source = function(...args) { const value = source.apply(this, args); wrap(value, 'read', 'read_window'); return value; };
    wrap(p.engine.context.transport.options, 'request', a => {
      const u = new URL(a[0].url), method = a[0].method;
      return /^\\/v1\\/changes/.test(u.pathname) ? 'request_poll' :
        method === 'PUT' && /^\\/v1\\/chunks\\//.test(u.pathname) ? 'request_chunk_put' :
        method === 'POST' && /^\\/v1\\/files\\//.test(u.pathname) ? 'request_version_post' : 'request_other';
    });
    return true;`);
  for (const scenario of ['small-notes', 'large-file', 'unchanged-sync-now']) {
    const started = Date.now();
    const serverLog = join(state.run, 'private', 'server.log');
    const serverFrom = readFileSync(serverLog).length;
    await c.evaluate(`const p = app.plugins.plugins['obsync-private-sync'], m = globalThis.__obsyncStages;
      m.stages = {}; m.cutMs = 0; m.cuts = 0; m.active = true; m.started = performance.now();
      if (P.scenario === 'small-notes') {
        for (let i = 0; i < 128; i++) await app.vault.create('stage-' + String(i).padStart(3, '0') + '.md',
          'STAGE PROFILE SENTINEL ' + i + '\\n' + 'a'.repeat(8192));
      } else if (P.scenario === 'large-file') {
        const bytes = new Uint8Array((32 << 20) + 1);
        let value = 1;
        for (let i = 0; i < bytes.length; i++) { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; bytes[i] = value >>> 24; }
        await app.vault.createBinary('stage-large.bin', bytes.buffer);
      } else {
        m.drained = false; const log = p.log;
        p.log = function(line) { if (/^sync_now decision=drained /.test(line)) m.drained = true; return log.call(this, line); };
        app.commands.executeCommandById('obsync-private-sync:sync-now');
      }
      return true;`, { scenario });
    let result;
    for (const deadline = Date.now() + 120000; Date.now() < deadline; await sleep(200)) {
      result = await c.evaluate(`const p = app.plugins.plugins['obsync-private-sync'], m = globalThis.__obsyncStages;
        const expected = P.scenario === 'small-notes' ? 128 : 129;
        return { settled: Object.keys(p.state.data.files).length === expected &&
          Object.values(p.state.data.files).every(f => /^[a-f0-9]{64}$/.test(f.versionId)) && p.currentStatus().kind === 'idle' &&
          (P.scenario !== 'unchanged-sync-now' || m.drained), elapsedMs: performance.now() - m.started,
          cutMs: m.cutMs, cuts: m.cuts, stages: m.stages };`, { scenario });
      if (result.settled) break;
    }
    if (!result?.settled) throw Error('stage deadline: ' + scenario);
    await c.evaluate('globalThis.__obsyncStages.active = false; return true;');
    const server = {};
    for (const line of readFileSync(serverLog).subarray(serverFrom).toString().split('\n')) {
      const match = /LAB_STAGE (\w+) (.*)/.exec(line);
      if (!match) continue;
      const entry = server[match[1]] ??= { count: 0 }; entry.count++;
      for (const field of match[2].matchAll(/(\w+)=(\d+)/g)) entry[field[1]] = (entry[field[1]] ?? 0) + Number(field[2]);
    }
    output.push({ scenario, wallMs: Date.now() - started, ...result, server });
    writeFileSync(join(state.run, 'evidence', 'stages.json'), JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  }
  const data = JSON.parse(readFileSync(join(state.devices.A.vault, '.obsidian/plugins/obsync-private-sync/data.json')));
  const large = readFileSync(join(state.devices.A.vault, 'stage-large.bin'));
  if (large.length !== (32 << 20) + 1 || Object.keys(data.files).length !== 129 ||
      !Object.values(data.files).every(f => /^[a-f0-9]{64}$/.test(f.versionId))) throw Error('independent persisted state mismatch');
  const blind = { files: 0, bytes: 0, contentOrPathMatches: 0 };
  const sentinels = ['STAGE PROFILE SENTINEL', 'stage-000.md', 'stage-large.bin'].map(s => Buffer.from(s));
  function scan(directory) {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw Error('unexpected server fixture symlink');
      if (stat.isDirectory()) scan(path);
      else if (stat.isFile()) {
        blind.files++; blind.bytes += stat.size;
        if (stat.size > 64 << 20 || blind.bytes > 1 << 30) throw Error('server scan byte bound');
        const bytes = readFileSync(path);
        for (const sentinel of sentinels) if (bytes.includes(sentinel)) blind.contentOrPathMatches++;
      }
    }
  }
  scan(join(state.run, 'runtime', 'server'));
  if (blind.files < 129 || blind.bytes < large.length || blind.contentOrPathMatches) throw Error('server plaintext sentinel check failed');
  writeFileSync(join(state.run, 'evidence', 'stage-readback.json'), JSON.stringify({ files: Object.keys(data.files).length,
    largeBytes: large.length, largeSha256: createHash('sha256').update(large).digest('hex'), blind }) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ scenarios: output.length, independentReadback: true }));
} finally { await c.close(); }
