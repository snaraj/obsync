// Slot-aware extension for fresh B/C. A is never aliased to a recovery process.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export function activeRecovery(value) {
  return value.paired===true && value.enrolling===false && value.phase==='active' && value.suite===2 && value.recoveryNotice===true;
}
export function validateExpectations(expected, sourceHead) {
  if(expected?.schema!==1 || expected.sourceHead!==sourceHead || !/^[a-f0-9]{64}$/.test(expected.generationHash) ||
      !Array.isArray(expected.notes) || expected.notes.length<2 || expected.notes.length>32) throw Error('explicit independent recovery expectations required');
  const paths=new Set(),hashes=new Set(),labels=new Set();
  for(const note of expected.notes) {
    if(!/^[A-Za-z0-9][A-Za-z0-9 -]{0,100}\.md$/.test(note.path) || !['retained','current'].includes(note.generation) ||
        !/^[a-f0-9]{64}$/.test(note.sha256) || paths.has(note.path) || hashes.has(note.sha256)) throw Error('distinct synthetic recovery witnesses required');
    paths.add(note.path);hashes.add(note.sha256);labels.add(note.generation);
  }
  if(labels.size!==2) throw Error('retained and current witnesses both required');
}

export function slotShape(state, run, slot) {
  const device=state.devices?.[slot], app=state.processes?.[slot];
  if (!['B','C','D'].includes(slot) || state.format!==1 || state.run!==run || state.stopped || state.source_dirty!==false ||
      !/^[a-f0-9]{40}$/.test(state.source_head) || !(Date.now()/1000<state.expiresAtEpoch) ||
      device?.android || device?.vault!==join(run,`runtime/${slot}/Lab-${slot}`) || device?.userdata!==join(run,`runtime/${slot}/userdata`) ||
      !Number.isInteger(device?.port) || device.port<1024 || device.port>65535 || app?.argv?.length!==4 ||
      !app.argv[0].endsWith('/Obsidian.app/Contents/MacOS/Obsidian') ||
      app.argv[1]!==`--user-data-dir=${device.userdata}` || app.argv[2]!==`--remote-debugging-port=${device.port}` ||
      app.argv[3]!=='--remote-debugging-address=127.0.0.1') throw Error('fresh recovery slot binding refused');
  return device;
}

export async function recoveryManifest(run, source, slot) {
  const {owned,privateRead,digest}=await import('./desktop-guard.mjs');
  run=resolve(run);source=resolve(source);owned(run,true);
  for (const name of ['private','runtime','evidence']) owned(join(run,name),true);
  const state=JSON.parse(privateRead(join(run,'lab.json'))),device=slotShape(state,run,slot);
  const git=args=>execFileSync('git',['-C',source,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if (state.source!==undefined && state.source!==source || git(['rev-parse','HEAD'])!==state.source_head || git(['status','--porcelain'])) throw Error('exact clean recovery candidate required');
  const binding=JSON.parse(privateRead(join(run,`private/recovery-${slot}-binding.json`)));
  if (binding.schema!==1 || binding.slot!==slot || binding.source!==source || binding.sourceHead!==state.source_head || binding.serverPid!==state.processes?.server?.pid) throw Error('fresh recovery provisioning proof absent');
  const server=state.processes.server,app=state.processes[slot],transport=JSON.parse(privateRead(join(run,'private/tls-binding.json')));
  if (JSON.stringify(server.argv)!==JSON.stringify([join(run,'runtime/build/obsyncd'),'serve']) || transport.schema!==1 ||
      transport.bind!=='127.0.0.1' || transport.upstreamPort!==state.server_port || transport.argv?.length!==6 ||
      transport.argv[2]!==run || transport.argv[3]!==join(source,'scripts/ci/observer.mjs') ||
      transport.argv[4]!==String(state.server_port) || transport.argv[5]!==String(transport.tlsPort) ||
      !transport.argv[1].endsWith('/scripts/validation/mobile-tls.mjs')) throw Error('same owned server/transport required');
  const url=new URL(state.url);
  if (url.protocol!=='http:' || url.hostname!=='127.0.0.1' || +url.port!==transport.recorderPort || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw Error('owned recorder endpoint required');
  for (const record of [state.holder,server,app,transport]) {
    if (!Number.isInteger(record?.pid) || record.pid<=1 || typeof record.identity!=='string') throw Error('owned process required');
    const actual=execFileSync('ps',['-p',String(record.pid),'-o','lstart=,command='],{encoding:'utf8'}).trim();
    if (actual!==record.identity || record.argv && !actual.endsWith(record.argv.join(' '))) throw Error('owned process identity changed');
  }
  if (digest(Buffer.from(server.identity))!==binding.serverIdentitySha256) throw Error('original server changed');
  for (const name of ['A','B','C','D'].filter(name=>name!==slot)) if (state.processes[name]) throw Error('prior desktop must be settled by holder');
  for (const port of [device.port,transport.recorderPort,transport.tlsPort]) {
    if (!Number.isInteger(port) || port<1024 || port>65535) throw Error('bounded loopback port required');
    const pid=port===device.port?app.pid:transport.pid;
    const listeners=execFileSync('lsof',['-nP','-a','-p',String(pid),'-iTCP:'+port,'-sTCP:LISTEN','-Fn'],{encoding:'utf8'}).split('\n').filter(s=>s.startsWith('n'));
    if (listeners.length!==1 || listeners[0]!==`n127.0.0.1:${port}`) throw Error('loopback listener changed');
  }
  owned(device.vault,true,false);owned(device.userdata,true,false);
  for (const [path,hash] of [[app.argv[0],binding.obsidianSha256],[join(app.argv[0],'../../Resources/app.asar'),binding.obsidianAsarSha256],[transport.argv[1],transport.scriptSha256]]) {
    const actual=resolve(path);owned(actual,false,false);if (digest(readFileSync(actual))!==hash) throw Error('pinned official app or transport changed');
  }
  for (const name of ['obsyncd','plugin/main.js','plugin/manifest.json','plugin/styles.css']) {
    const hash=state.artifacts?.[name],paths=[join(run,'runtime/build',name)];
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('candidate hash required');
    if (name.startsWith('plugin/')) paths.push(join(source,'plugin/dist',name.slice(7)),join(device.vault,'.obsidian/plugins/obsync-private-sync',name.slice(7)));
    for (const path of paths) {owned(path,false,false);if(digest(readFileSync(path))!==hash) throw Error('candidate artifact changed');}
  }
  return {...state,pluginVersion:JSON.parse(readFileSync(join(run,'runtime/build/plugin/manifest.json'))).version};
}
