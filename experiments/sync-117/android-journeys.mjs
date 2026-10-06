// Disposable Android emulator rehearsal; never physical-phone acceptance.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [toolingRoot, run, androidRun, command, androidVault] = process.argv.slice(2);
if (!/^\/storage\/emulated\/0\/Documents\/Obsync-[A-Za-z0-9-]+$/.test(androidVault ?? '')) throw Error('explicit synthetic Android vault required');
const driverSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const { manifest, connect, sleep, targets } = await import(pathToFileURL(resolve(toolingRoot, 'scripts/validation/lab/cdp.mjs')));
const state = manifest(run), android = manifest(androidRun);
const ready=JSON.parse(readFileSync(join(androidRun,'evidence/android-ready.json')));
if(Date.now()/1000 >= ready.expiresAtEpoch)throw Error('Android session expired');
for(const p of Object.values(android.processes))if(execFileSync('ps',['-p',String(p.pid),'-o','lstart=,command='],{encoding:'utf8'}).trim()!==p.identity)throw Error('owned process identity changed');
const emulator = android.processes.emulator;
const serial = `emulator-${emulator.argv[emulator.argv.indexOf('-port') + 1]}`;
const adb = join(android.sdk, 'platform-tools/adb');
const adbPort = +(android.processes.adb.argv[android.processes.adb.argv.indexOf('-L') + 1].split(':').at(-1));
process.env.ADB_SERVER_SOCKET = `tcp:127.0.0.1:${adbPort}`;
process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
function shell(...args) { return execFileSync(adb, ['-P', String(adbPort), '-s', serial, ...args], { encoding: 'utf8', timeout: 15000 }).trim(); }
let forward;
const clients = [];
function record(label, value) {
  const result = { ...value, driverSha256, platform: 'Android emulator', physicalPhone: 'NOT_RUN' };
  writeFileSync(join(state.run, 'evidence', `${label}-${Date.now()}.json`), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
}
async function mobile() {
  const appPid = +shell('shell', 'pidof', 'md.obsidian');
  if (!Number.isInteger(appPid) || appPid <= 1) throw Error('owned Android app absent');
  forward = +shell('forward', 'tcp:0', `localabstract:webview_devtools_remote_${appPid}`);
  state.devices.M = { android: true, adb, adbPort, serial, appPid, port: forward,
    vault: androidVault };
  state.processes.M = emulator;
}
async function client(name) { const c = await connect(state, name); clients.push(c); return c; }
async function read(name, body, params = {}) { const c = await client(name); try { return await c.evaluate(body, params); } finally { c.close(); } }
async function until(fn, stage, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(250); }
  throw Error(`${stage} deadline`);
}
async function progress(name) {
  return await read(name, `const p = app.plugins.plugins['obsync-private-sync'], status = p.currentStatus(); return { paired: p.state.paired, files: Object.keys(p.state.data.files).length, notes: Object.keys(p.state.data.files).filter(p => p.endsWith('.md')).length, status: status.kind, pending: status.pending, checking: status.checking, lastSeq: p.state.data.lastSeq, dropped: Object.keys(p.state.data.dropped).length };`);
}
async function bytes(name, path, expected) {
  if (name === 'A') { try { return readFileSync(join(state.devices.A.vault, path), 'utf8') === expected; } catch { return false; } }
  try { return execFileSync(adb, ['-P', String(adbPort), '-s', serial, 'exec-out', 'cat', `${state.devices.M.vault}/${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) === expected; } catch { return false; }
}
async function verify(path, expected) {
  for (const name of ['A', 'M']) await until(() => bytes(name, path, expected), `${name} independent disk bytes`, 180000);
  const ids = [];
  for (const name of ['A', 'M']) ids.push(await read(name, `const f = await wait(() => app.vault.getAbstractFileByPath(P.path), 'file index', 60000); const leaf = app.workspace.getLeaf(false); await leaf.openFile(f); await wait(() => leaf.view.editor?.getValue() === P.text, 'editor bytes', 60000); return (await wait(() => app.plugins.plugins['obsync-private-sync'].state.fileByPath(P.path), 'identity')).fileId;`, { path, text: expected }));
  if (!/^[a-f0-9]{32}$/.test(ids[0]) || ids[0] !== ids[1]) throw Error('peer file identity mismatch');
  return { peerDisk: true, peerEditor: true, sameNonemptyFileId: true };
}


async function typedTransfer(from, label) {
  const path=`Android-${label}-${Date.now()}.md`, text=`# Native ${label}\n\nTyped on ${from === 'A' ? 'desktop' : 'Android'}.\n`;
  const c=await client(from);
  await c.evaluate(`const f=await app.vault.create(P.path,''); await app.workspace.getLeaf(false).openFile(f,{state:{mode:'source'}}); await wait(()=>!!app.workspace.getMostRecentLeaf()?.view?.editor,'editor'); const e=app.workspace.getMostRecentLeaf().view.editor; e.focus(); e.setCursor({line:0,ch:0}); window.androidTrusted=null; document.addEventListener('beforeinput',e=>window.androidTrusted=e.isTrusted,{capture:true,once:true}); return true;`,{path});
  const start=Date.now(); await c.insertText(text);
  const input=await c.evaluate(`return {trusted:window.androidTrusted, buffer:app.workspace.getMostRecentLeaf().view.editor.getValue()===P.text};`,{text});
  if(!input.trusted || !input.buffer)throw Error('native typing not proved');
  const proof=await verify(path,text);
  const elapsedMs=Date.now()-start;
  for(const name of ['A','M'])await (await client(name)).screenshot(label+'-'+name);
  record(label,{result:'PASS',from,path,elapsedMs,input,...proof,visualInspection:'PENDING'});
}
async function uiRead(name, body, params={}) { return await read(name,body,params); }
try {
  await mobile();
  if(command==='preflight') {
    record('android-preflight',await read('M',`const p=app.plugins.plugins['obsync-private-sync'];return {ownedVault:app.vault.adapter.basePath===P.vault,pluginLoaded:!!p,version:p?.manifest?.version??null,paired:p?.state?.paired??null,notes:app.vault.getMarkdownFiles().length};`));
    await (await client('M')).screenshot('android-preflight');
  } else if(command==='pair') {
    await read('M',`app.setting.open();app.setting.openTabById('obsync-private-sync'); await wait(()=>row('Server URL')?.querySelector('input'),'server setting');fill(row('Server URL').querySelector('input'),P.url);await wait(()=>app.plugins.plugins['obsync-private-sync'].state.data.serverUrl===P.url,'saved URL');button('Pair this device').click();await wait(()=>row('Pairing code')?.querySelector('input'),'pair dialog');return true;`);
    const a=await client('A'), m=await client('M');
    const code=await a.evaluate(`app.setting.close();window.labPairing=[];const p=app.plugins.plugins['obsync-private-sync'];if(window.labPairingTap!==p){window.labPairingTap=p;const old=p.log.bind(p);p.log=line=>{if(/^pairing role=creator decision=/.test(line))window.labPairing.push({at:Date.now(),decision:/decision=([^ ]+)/.exec(line)?.[1]});return old(line);};}app.commands.executeCommandById('obsync-private-sync:pair-device');return await wait(()=>document.querySelector('.modal pre.obsync-code')?.textContent.trim(),'pair code');`);
    if(!/^[A-Z2-7]{128}$/.test(code))throw Error('pairing code shape');
    await m.evaluate(`const input=row('Pairing code').querySelector('input');input.focus();return true;`);
    await m.insertText(code);
    await m.evaluate(`if(row('Pairing code').querySelector('input').value!==P.code)throw Error('pairing input mismatch');button('Pair').click();return true;`,{code});
    const matchBody=`return await wait(()=>/the code ([0-9]{3} [0-9]{3})/.exec([...document.querySelectorAll('.modal:not(.mod-settings)')].map(m=>m.textContent).join(' '))?.[1],'independent visible match');`;
    const [ours,theirs]=await Promise.all([a.evaluate(matchBody),m.evaluate(matchBody)]);
    if(ours!==theirs)throw Error('native match codes differ');
    await a.evaluate(`const modal=[...document.querySelectorAll('.modal:not(.mod-settings)')].find(m=>m.textContent.includes(P.match));const b=[...modal?.querySelectorAll('button')??[]].find(b=>b.textContent.trim()==='Approve');if(!b||b.disabled)throw Error('comparison approval absent');b.click();return true;`,{match:theirs});
    await until(async()=>{
      const observed=await m.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];const modal=[...document.querySelectorAll('.modal')].find(m=>m.querySelector('.modal-title')?.textContent==="Add this vault's notes to the server's vault?");return {paired:p.state.paired,importPending:!!modal};`);
      if(observed.importPending)await m.evaluate(`const modal=[...document.querySelectorAll('.modal')].find(m=>m.querySelector('.modal-title')?.textContent==="Add this vault's notes to the server's vault?");const b=[...modal.querySelectorAll('button')].find(b=>b.textContent.trim()==='Pair and upload');if(!b||b.disabled)throw Error('synthetic import control absent');b.click();return true;`);
      return observed.paired;
    },'Android key kept',60000);
    await until(()=>a.evaluate(`return (window.labPairing??[]).some(e=>e.decision==='paired');`),'creator key-kept acknowledgement',60000);
    for(const c of [a,m])await c.evaluate(`app.setting.close();return true;`);
    record('android-pair',{result:'PASS',independentRendererComparisonsMatched:true,creatorConfirmedKeyKept:true,A:await progress('A'),M:await progress('M'),desktopMockKeychain:true});
  } else if(command==='both-directions') {
    await typedTransfer('A','desktop-to-android'); await typedTransfer('M','android-to-desktop');
  } else if (command === 'cotype-observe') {
    const receipt=readdirSync(join(state.run,'evidence')).filter(n=>/^Lab-CoTyping-[0-9]+-input\.json$/.test(n)).sort().at(-1);
    if(!receipt)throw Error('co-typing receipt missing');
    const source=JSON.parse(readFileSync(join(state.run,'evidence',receipt),'utf8')),path=source.path,stem=path.slice(0,-3);
    const disk={A:readFileSync(join(state.devices.A.vault,path),'utf8'),M:execFileSync(adb,['-P',String(adbPort),'-s',serial,'exec-out','cat',`${androidVault}/${path}`],{encoding:'utf8'})};
    const editors={},identities={};
    for(const name of ['A','M']) {const observed=await read(name,`const p=app.plugins.plugins['obsync-private-sync'];return {text:app.workspace.getLeavesOfType('markdown').map(l=>l.view).find(v=>v.file?.path===P.path)?.editor?.getValue()??null,id:p.state.fileByPath(P.path)?.fileId??null};`,{path});editors[name]=observed.text;identities[name]=observed.id;}
    const files={A:readdirSync(state.devices.A.vault).filter(n=>n.startsWith(stem)),M:shell('shell',`find '${androidVault}' -maxdepth 1 -type f -name '${stem}*'`).split('\n').filter(Boolean).map(p=>p.split('/').at(-1))};
    const streams=Object.fromEntries(['A','M'].map(name=>[name,' '+source.timeline[name].map(r=>r.token).join(' ')]));
    let prefix=0;while(prefix<Math.min(streams.A.length,streams.M.length)&&streams.A[prefix]===streams.M[prefix])prefix++;
    const expected=source.initial.replace('# Both','# Both'+streams.A.slice(0,prefix)+[streams.A.slice(prefix),streams.M.slice(prefix)].sort().join(''));
    const tokens=disk.A.match(/[AM][0-9]{3}/g)??[],all=Object.values(source.timeline).flat().map(r=>r.token);
    const proof={sameIndependentDiskBytes:disk.A===disk.M,bothNativeEditorsMatchDisk:editors.A===disk.A&&editors.M===disk.A,sameNonemptyFileId:/^[a-f0-9]{32}$/.test(identities.A??'')&&identities.A===identities.M,oneFileEach:Object.values(files).every(v=>v.length===1&&v[0]===path),allTokensExactlyOnce:tokens.length===all.length&&new Set(tokens).size===all.length&&all.every(t=>tokens.includes(t)),perDeviceOrder:['A','M'].every(name=>JSON.stringify(tokens.filter(t=>t.startsWith(name)))===JSON.stringify(source.timeline[name].map(r=>r.token))),matchesDocumentedSharedPrefixRule:disk.A===expected};
    const result={result:Object.values(proof).every(Boolean)?'OBSERVED':'FAIL',originalStrictSeparatorTest:'FAIL retained',path,typingTokens:Object.fromEntries(['A','M'].map(name=>[name,source.timeline[name].length])),typedTotalBytes:Buffer.byteLength(source.initial)+Buffer.byteLength(streams.A)+Buffer.byteLength(streams.M),actualBytes:Buffer.byteLength(disk.A),deduplicatedCommonPrefixBytes:prefix,hashes:Object.fromEntries(['A','M'].map(name=>[name,createHash('sha256').update(disk[name]).digest('hex')])),...proof,meaning:'One shared note converged under documented common-prefix semantics; the strict word-separator expectation failed.'};
    writeFileSync(join(state.run,'evidence','android-cotype-converged.txt'),disk.A,{mode:0o600});
    record('android-cotype-observation',result);
    for(const name of ['A','M'])await (await client(name)).screenshot('android-cotype-'+name);
  } else if (command === 'cotype') {
    const stem=`Lab-CoTyping-${Date.now()}`, path=stem+'.md';
    const initial='# Both\nthe line nobody edits\nthe last fixed line\n';
    await read('A', `const f=await app.vault.create(P.path,P.text); await app.workspace.getLeaf(false).openFile(f,{state:{mode:'source'}}); return true;`,{path,text:initial});
    await verify(path,initial);
    const actors=await Promise.all(['A','M'].map(name=>client(name)));
    for(const c of actors) await c.evaluate(`if(document.querySelector('.modal-container')) throw Error('dialog owns native editor'); await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(P.path),{state:{mode:'source'}}); window.labCotype={trusted:0,untrusted:0}; window.labCotypeListener=e=>{if(e.isTrusted)window.labCotype.trusted++;else window.labCotype.untrusted++;}; document.addEventListener('beforeinput',window.labCotypeListener,true); return true;`,{path});
    const timeline={A:[],M:[]}, started=Date.now(), duration=60000, interval=400;
    const saveProgress=result=>writeFileSync(join(state.run,'evidence',stem+'-input.json'),JSON.stringify({result,path,initial,position:{line:0,ch:'current line end'},durationMs:duration,intervalMs:interval,startedAt:started,timeline},null,2)+'\n',{mode:0o600});
    let stopped, inputProof;
    try {
      await Promise.all(actors.map(async(c,index)=>{
        const name=index===0?'A':'M';
        while(Date.now()-started<duration) {
          const tick=Date.now(), token=name+String(timeline[name].length+1).padStart(3,'0');
          await c.evaluate(`if(document.querySelector('.modal-container')) throw Error('dialog owns native editor'); const leaf=app.workspace.getMostRecentLeaf(); if(leaf?.view?.file?.path!==P.path||!leaf.view.editor)throw Error('expected native editor'); const e=leaf.view.editor;e.focus();e.setCursor({line:0,ch:e.getLine(0).length});return true;`,{path});
          const sentAt=Date.now();await c.insertText(' '+token);const acknowledgedAt=Date.now();
          const inBuffer=await c.evaluate(`return app.workspace.getMostRecentLeaf().view.editor.getLine(0).includes(P.token);`,{token});
          timeline[name].push({token,sentAt,acknowledgedAt,inBuffer});
          if(!inBuffer)throw Error('typed token absent from native buffer');
          if(timeline[name].length%10===0)saveProgress('RUNNING');
          await sleep(Math.max(0,interval-(Date.now()-tick)));
        }
      }));
      stopped=Date.now();saveProgress('INPUT_COMPLETE');
    } finally {
      inputProof=await Promise.all(actors.map(c=>c.evaluate(`document.removeEventListener('beforeinput',window.labCotypeListener,true);const result=window.labCotype;delete window.labCotypeListener;delete window.labCotype;return result;`)));
    }
    writeFileSync(join(state.run,'evidence',stem+'-input-proof.json'),JSON.stringify({path,recordedAt:Date.now(),trustedInput:inputProof,expectedCounts:{A:timeline.A.length,M:timeline.M.length}},null,2)+'\n',{mode:0o600});
    if(inputProof.some((r,i)=>r.trusted!==timeline[i===0?'A':'M'].length||r.untrusted))throw Error('trusted input event count mismatch');
    const expectedTokens={A:timeline.A.map(r=>r.token),M:timeline.M.map(r=>r.token)};
    let convergedText;
    await until(async()=>{
      const texts=[];
      for(const name of ['A','M'])texts.push(await read(name,`return app.workspace.getLeavesOfType('markdown').map(l=>l.view).find(v=>v.file?.path===P.path)?.editor?.getValue()??null;`,{path}));
      if(typeof texts[0]!=='string'||texts[0]!==texts[1])return false;
      const lines=texts[0].split('\n');if(lines.length!==4||lines[1]!=='the line nobody edits'||lines[2]!=='the last fixed line'||lines[3]!==''||!lines[0].startsWith('# Both '))return false;
      const tokens=lines[0].slice('# Both '.length).split(' ');
      if(tokens.length!==expectedTokens.A.length+expectedTokens.M.length||new Set(tokens).size!==tokens.length)return false;
      for(const name of ['A','M'])if(JSON.stringify(tokens.filter(t=>t.startsWith(name)))!==JSON.stringify(expectedTokens[name]))return false;
      if(!await bytes('A',path,texts[0])||!await bytes('M',path,texts[0]))return false;
      convergedText=texts[0];return true;
    },'one note retains every native token once in order',120000);
    const peerCopies={A:readdirSync(state.devices.A.vault).filter(n=>n.startsWith(stem)),M:shell('shell',`find '${androidVault}' -maxdepth 1 -type f -name '${stem}*'`).split('\n').filter(Boolean).map(p=>p.split('/').at(-1))};
    if(Object.values(peerCopies).some(names=>names.length!==1||names[0]!==path))throw Error('co-typing left extra peer files');
    const proof=await verify(path,convergedText);saveProgress('PASS');
    record('android-cotype',{result:'PASS',path,typedTokens:{A:expectedTokens.A.length,M:expectedTokens.M.length},trustedInput:inputProof,typingMs:stopped-started,settledAfterTypingMs:Date.now()-stopped,oneFileOnEachPeer:true,everyTokenExactlyOnce:true,perDeviceTokenOrderPreserved:true,fixedLinesIntact:true,sha256:createHash('sha256').update(convergedText).digest('hex'),...proof,physicalKeyboard:'NOT_CLAIMED',input:'CDP Input.insertText trusted native beforeinput'});

  } else if(command==='background' || command==='restart') {
    for(const c of clients)c.close();
    shell('forward','--remove',`tcp:${forward}`); forward=undefined;
    if(command==='restart')shell('shell','am','force-stop','md.obsidian');
    else shell('shell','input','keyevent','3');
    await sleep(2500);
    shell('shell','am','start','-n','md.obsidian/.MainActivity');
    await until(async()=>{try{await mobile();return await read('M',`return !!app.plugins.plugins['obsync-private-sync']?.state?.paired;`);}catch{if(forward)shell('forward','--remove',`tcp:${forward}`);forward=undefined;return false;}},'Android returns without pairing',60000);
    record('android-'+command,{result:'PASS',pairedWithoutSetup:true,appProcessRestart:command==='restart',M:await progress('M')});
    await typedTransfer('A',command+'-desktop-to-android');
    await typedTransfer('M',command+'-android-to-desktop');
  } else if(command==='offline') {
    const probe=`try{const r=await app.plugins.plugins['obsync-private-sync'].transport.devices({interactive:true});return Array.isArray(r.devices);}catch{return false;}`;
    if(!await read('M',probe))throw Error('online network calibration failed');
    const path='Android-offline-'+Date.now()+'.md',text='# Offline edit\n\nTyped offline on Android, retained after reconnection.\n';
    let down=false,proof;
    try {
      shell('shell','svc','wifi','disable');shell('shell','svc','data','disable');down=true;
      await sleep(1500);
      if(await read('M',probe))throw Error('offline injection not proved');
      const c=await client('M');
      await c.evaluate(`const f=await app.vault.create(P.path,'');await app.workspace.getLeaf(false).openFile(f,{state:{mode:'source'}});const e=app.workspace.getMostRecentLeaf().view.editor;e.focus();e.setCursor({line:0,ch:0});window.offlineTrusted=null;document.addEventListener('beforeinput',e=>window.offlineTrusted=e.isTrusted,{once:true,capture:true});return true;`,{path});
      await c.insertText(text);
      await until(()=>bytes('M',path,text),'local offline save',15000);
      const observed=await c.evaluate(`return {trusted:window.offlineTrusted,buffer:app.workspace.getMostRecentLeaf().view.editor.getValue()===P.text,status:app.plugins.plugins['obsync-private-sync'].currentStatus().kind};`,{text});
      if(!observed.trusted||!observed.buffer||await bytes('A',path,text))throw Error('offline edit isolation failed');
      await c.screenshot('android-offline');proof=observed;
    } finally {if(down){shell('shell','svc','wifi','enable');shell('shell','svc','data','enable');}}
    const resumed=Date.now();const final=await verify(path,text);
    for(const name of ['A','M'])await (await client(name)).screenshot('reconnected-'+name);
    record('android-reconnection',{result:'PASS',offlineTransportProved:true,offlineEdit:proof,localBytesSaved:true,automaticResumeMs:Date.now()-resumed,...final,visualInspection:'PENDING'});
  } else if(command==='leave') {
    const m=await client('M'),a=await client('A');
    const id=await m.evaluate(`return app.plugins.plugins['obsync-private-sync'].state.data.deviceId;`);
    if(!/^[a-f0-9]{32}$/.test(id))throw Error('expected paired device identity');
    const paths=await m.evaluate(`return app.vault.getMarkdownFiles().map(f=>f.path);`);
    const digest=path=>createHash('sha256').update(execFileSync(adb,['-P',String(adbPort),'-s',serial,'exec-out','cat',androidVault+'/'+path],{timeout:15000})).digest('hex');
    const snapshots=paths.map(path=>[path,digest(path)]);
    await m.evaluate(`app.setting.close();app.commands.executeCommandById('obsync-private-sync:leave-server');await wait(()=>button('Leave')&&!button('Leave').disabled,'synced leave confirmation');return true;`);
    const start=Date.now();await m.evaluate(`button('Leave').click();return true;`);
    await until(()=>m.evaluate(`return !app.plugins.plugins['obsync-private-sync'].state.paired && app.plugins.plugins['obsync-private-sync'].state.data.deviceId===null;`),'enrollment forgotten',60000);
    const revoked=await a.evaluate(`return (await app.plugins.plugins['obsync-private-sync'].transport.devices({interactive:true})).devices.find(d=>d.device_id===P.id)?.state==='revoked';`,{id});
    if(!revoked)throw Error('server revocation not confirmed');
    if(snapshots.some(([path,text])=>digest(path)!==text))throw Error('Leave changed local notes');
    const cleared=await m.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];app.setting.open();app.setting.openTabById('obsync-private-sync');return {deviceIdNull:p.state.data.deviceId===null,serverForgotten:p.state.data.serverUrl==='',fileRecords:Object.keys(p.state.data.files).length};`);
    if(!cleared.serverForgotten||cleared.fileRecords!==0)throw Error('Leave retained enrollment metadata');
    await m.screenshot('android-after-leave');
    record('android-leave',{result:'PASS',serverRevoked:true,localNotesUnchanged:paths.length,cleared,elapsedMs:Date.now()-start,visualInspection:'PENDING'});
  } else if(command==='status') {
    record('android-status',{A:await progress('A'),M:await progress('M')});
  } else throw Error('unknown Android journey');
} catch(error) {
  record('android-journey-failure',{result:'FAIL',stage:command,reason:error.message});process.exitCode=1;
} finally {
  for(const c of clients)c.close();
  if(forward)shell('forward','--remove',`tcp:${forward}`);
}
