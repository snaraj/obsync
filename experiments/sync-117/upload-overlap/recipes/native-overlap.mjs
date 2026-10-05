// Owned two-window comparison: no protocol/protection changes and no timing delays.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [run, harness] = process.argv.slice(2);
const { connect, manifest, sleep } = await import(pathToFileURL(join(resolve(harness), 'cdp.mjs')).href);
const state = manifest(run), clients = [];
const output = { result: 'RUNNING', samples: [], artifacts: state.artifacts,
  limits: ['Common-host native macOS windows over loopback HTTP and mock keychains; TLS/phone NOT_RUN.',
    'Request wrappers count only categories, byte lengths and timestamps; all authentication, encryption and durable writes remain unchanged.',
    'No synthetic network delay. Three alternating fresh-account pairs; no best-run filtering.'] };
const save = () => writeFileSync(join(run, 'evidence/overlap.json'), JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
const largeSize = (64 << 20) + 1;
function noise(size) { const b = Buffer.alloc(size); let x = 1; for (let i = 0; i < size; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; b[i] = x >>> 24; } return b; }
const expected = new Map(Array.from({ length: 128 }, (_, i) => ['pipe-' + String(i).padStart(3, '0') + '.md', Buffer.from('UPLOAD PIPE SENTINEL ' + i + '\n' + 'a'.repeat(8192))]));
try {
  clients.push(await connect(state, 'A')); clients.push(await connect(state, 'B'));
  for (const c of clients) await c.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];
    await wait(()=>p.currentStatus()?.kind==='idle','initial idle');
    if(Object.keys(p.state.data.files).length)throw Error('fresh empty vault required');
    const host=p.engine.context.host, options=p.engine.context.transport.options;
    const m=window.__uploadOverlap={active:false,counts:{},pending:0,lastAck:0,lastCommit:0,restore:[]};
    const request=options.request;
    options.request=async function(q){
      const path=new URL(q.url).pathname;
      const label=q.method==='PUT'&&path.startsWith('/v1/chunks/')?'chunkPut':
        q.method==='POST'&&path==='/v1/chunks/exists'?'exists':
        q.method==='POST'&&path.startsWith('/v1/files/')&&path.endsWith('/versions')?'versionPost':
        path.startsWith('/v1/chunks/')?'chunkRead':null;
      const active=m.active&&label!==null, at=Date.now();
      if(active){m.pending++;const r=m.counts[label]??={requests:0,bytes:0,ms:0,errors:0};r.requests++;
        r.bytes+=q.body instanceof ArrayBuffer?q.body.byteLength:typeof q.body==='string'?new TextEncoder().encode(q.body).length:0;}
      try{const answer=await request.apply(this,arguments);if(active&&label==='versionPost'&&answer.status>=200&&answer.status<300)m.lastAck=Date.now();return answer;}
      catch(e){if(active)m.counts[label].errors++;throw e;}
      finally{if(active){m.counts[label].ms+=Date.now()-at;m.pending--;}}
    };
    m.restore.push(()=>{options.request=request;});
    const writer=host.writer;
    host.writer=async function(...args){const w=await writer.apply(this,args),commit=w.commit;
      w.commit=async function(...args){const result=await commit.apply(this,args);if(m.active)m.lastCommit=Date.now();return result;};return w;};
    m.restore.push(()=>{host.writer=writer;});return true;`);
  for (const scenario of ['small-notes', 'large-file']) {
    for (const c of clients) await c.evaluate(`const m=window.__uploadOverlap;m.counts={};m.pending=0;m.lastAck=0;m.lastCommit=0;m.active=true;return true;`);
    const started = await clients[0].evaluate(`const started=Date.now();
      if(P.scenario==='small-notes'){for(let i=0;i<128;i++)await app.vault.create('pipe-'+String(i).padStart(3,'0')+'.md','UPLOAD PIPE SENTINEL '+i+'\\n'+'a'.repeat(8192));}
      else{const b=new Uint8Array(P.size);let x=1;for(let i=0;i<b.length;i++){x=(Math.imul(x,1664525)+1013904223)>>>0;b[i]=x>>>24;}await app.vault.createBinary('pipe-large.bin',b.buffer);}
      return started;`, { scenario, size: largeSize });
    const count = scenario === 'small-notes' ? 128 : 129;
    let statuses;
    for (const end = Date.now() + 120000; Date.now() < end; await sleep(20)) {
      statuses = await Promise.all(clients.map(c => c.evaluate(`const p=app.plugins.plugins['obsync-private-sync'],m=window.__uploadOverlap;
        return {ready:p.currentStatus()?.kind==='idle'&&Object.keys(p.state.data.files).length===P.count&&
          Object.values(p.state.data.files).every(f=>/^[a-f0-9]{64}$/.test(f.versionId))&&m.pending===0,
          lastAck:m.lastAck,lastCommit:m.lastCommit,counts:m.counts};`, { count })));
      if (statuses.every(s => s.ready)) break;
    }
    if (!statuses?.every(s => s.ready)) throw Error('native convergence deadline: ' + scenario);
    const observedEnd = Date.now();
    for (const c of clients) await c.evaluate(`window.__uploadOverlap.active=false;await app.plugins.plugins['obsync-private-sync'].state.save();return true;`);
    if (scenario === 'large-file') expected.set('pipe-large.bin', noise(largeSize));
    const states = {};
    for (const name of ['A', 'B']) {
      const vault = state.devices[name].vault;
      const names = readdirSync(vault).filter(n => n.startsWith('pipe-')).sort();
      if (JSON.stringify(names) !== JSON.stringify([...expected.keys()].sort())) throw Error('extra/missing fixture path');
      for (const [name, bytes] of expected) if (!readFileSync(join(vault, name)).equals(bytes)) throw Error('native disk bytes differ');
      states[name] = JSON.parse(readFileSync(join(vault, '.obsidian/plugins/obsync-private-sync/data.json')));
    }
    for (const name of expected.keys()) {
      const a = states.A.files[name], b = states.B.files[name];
      if (!a?.versionId || a.versionId !== b?.versionId || !a.fileId || a.fileId !== b?.fileId) throw Error('persisted identity/version differs');
    }
    if (statuses[0].lastAck < started || statuses[1].lastCommit < started) throw Error('missing event timing');
    output.samples.push({ scenario, senderAckMs: statuses[0].lastAck - started, peerCommitMs: statuses[1].lastCommit - started,
      observedSettledMs: observedEnd - started, requests: { A: statuses[0].counts, B: statuses[1].counts },
      exactFilesEach: expected.size, exactBytesEach: [...expected.values()].reduce((n,b)=>n+b.length,0),
      ...(scenario === 'large-file' ? { largeSha256: createHash('sha256').update(expected.get('pipe-large.bin')).digest('hex') } : {}),
      persistedIdentitiesAgree: true }); save();
  }
  for (let i = 0; i < clients.length; i++) {
    await clients[i].evaluate(`const file=app.vault.getAbstractFileByPath('pipe-127.md');await app.workspace.getLeaf(false).openFile(file);return true;`);
    await clients[i].screenshot('overlap-peer-' + ['A','B'][i]);
  }
  const forbidden = ['UPLOAD PIPE SENTINEL ', 'pipe-000.md', 'pipe-127.md', 'pipe-large.bin'].map(s=>Buffer.from(s));
  let scannedFiles=0,scannedBytes=0;
  function inspect(directory) {
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      if(entry.isSymbolicLink())throw Error('unexpected server symlink');
      if(entry.isDirectory())inspect(path);
      else if(entry.isFile()) {
        const bytes=readFileSync(path);scannedFiles++;scannedBytes+=bytes.length;
        if(forbidden.some(value=>bytes.includes(value)))throw Error('synthetic plaintext sentinel in server storage');
      }
    }
  }
  inspect(join(run,'runtime/server'));
  output.serverStorageSentinelScan={passed:true,scannedFiles,scannedBytes,limit:'Known synthetic note/path sentinels only; not a general confidentiality proof.'};
  output.result = 'SCENARIO_PASS';
} catch (error) { output.result='FAIL';output.reason=error.message;throw error; }
finally {
  const cleanup=await Promise.allSettled(clients.map(c=>c.evaluate(`const m=window.__uploadOverlap;if(m){m.active=false;for(const restore of m.restore)restore();delete window.__uploadOverlap;}return true;`)));
  output.hooksRemoved=cleanup.every(r=>r.status==='fulfilled');
  if(!output.hooksRemoved)output.result='FAIL';save();for(const c of clients)c.close();
}
if(output.result!=='SCENARIO_PASS')throw Error('scenario/observer cleanup failed');
console.log(JSON.stringify({result:output.result,samples:output.samples.length,hooksRemoved:output.hooksRemoved}));
