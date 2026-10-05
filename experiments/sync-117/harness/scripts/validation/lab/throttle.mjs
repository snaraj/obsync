// Real native lifecycle check, with a bounded interruption of only the owned server.
import{readFileSync,writeFileSync,readdirSync}from'node:fs';
import{join}from'node:path';
import{connect,manifest,sleep}from'./cdp.mjs';
const[run]=process.argv.slice(2),s=manifest(run),c=await connect(s,'A'),b=await connect(s,'B');
if(!s.processes.intermediary)throw Error('owned fault boundary required');
const faults=join(run,'private/faults.json');
const offline=value=>writeFileSync(faults,JSON.stringify({walkCuts:0,chunkDelayMs:0,offline:value}),{mode:0o600});
const result={result:'RUNNING',cases:[],limits:['Two native macOS test windows; phone NOT_RUN.','Cancellation invokes the running engine stop; unload uses Obsidian plugin disable.','Network failure drops requests only at this run’s owned loopback intermediary; authentication and encrypted payloads stay unchanged.']};
const save=()=>writeFileSync(join(run,'evidence/throttle.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
async function until(test,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await test())return;await sleep(50);}throw Error(label+' deadline');}
async function read(){return c.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];return {throttled:window.electronWindow.webContents.getBackgroundThrottling(),minimized:window.electronWindow.isMinimized(),hidden:document.hidden,status:p?.currentStatus()?.kind,draining:p?.engine?.draining,host:window.__throttleProof.lines};`);}
async function restored(label,reason){await until(async()=>{const x=await read();return x.throttled&&x.host.some(v=>v.includes('decision=throttle_restored reason='+reason));},label+' restore');const x=await read();if(!x.minimized||!x.hidden)throw Error('window left minimized state');result.cases.push({label,result:'PASS',...x});save();}
async function begin(label,count){await c.evaluate(`window.__throttleProof.lines=[];window.__throttleProof.create=(async()=>{for(let i=0;i<P.count;i++)await app.vault.create('throttle-'+P.label+'-'+i+'.md','THROTTLE SENTINEL '+P.label+' '+i+'\\n');})();return true;`,{label,count});await until(async()=>{const x=await read();return !x.throttled&&x.host.some(v=>v.includes('decision=throttle_lifted reason=work'));},label+' active');}
async function setupObserver(){await c.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];const log=p.log;window.__throttleProof={lines:[]};p.log=function(line){if(/^host decision=throttle_/.test(line))window.__throttleProof.lines.push(line);return log.call(this,line);};window.electronWindow.minimize();return true;`);}
try{
 await setupObserver();await until(async()=>(await read()).throttled,'initial calm');
 await begin('idle',1);await c.evaluate('await window.__throttleProof.create;return true;');await restored('idle','calm');
 await begin('cancel',64);await c.evaluate(`app.plugins.plugins['obsync-private-sync'].engine.stop();await window.__throttleProof.create;return true;`);await restored('cancel','stop');
 await c.evaluate(`await app.plugins.plugins['obsync-private-sync'].startEngine();return true;`);await until(async()=>{const x=await read();return x.throttled&&x.status==='idle';},'restart drain');
 await begin('unload',64);await c.evaluate(`await app.plugins.disablePlugin('obsync-private-sync');await window.__throttleProof.create;return true;`);await restored('unload','stop');
 await c.evaluate(`await app.plugins.enablePlugin('obsync-private-sync');await wait(()=>app.plugins.plugins['obsync-private-sync']?.engine?.started,'reload');return true;`);await setupObserver();await until(async()=>{const x=await read();return x.throttled&&x.status==='idle';},'reload calm');
 await begin('network-error',128);
 offline(true);
 await c.evaluate('await window.__throttleProof.create;return true;');await until(async()=>['error','offline'].includes((await read()).status),'visible network error');await restored('network-error','unanswered');
 if(!(await read()).draining)throw Error('outage did not retain a draining queue');
 offline(false);
 await until(async()=>{const x=await read();return !x.throttled&&x.host.filter(v=>v.includes('decision=throttle_lifted reason=work')).length>=2;},'answer lifts throttle',60000);
 await until(async()=>{for(const name of ['A','B']){for(const label of ['idle','cancel','unload','network-error']){for(let i=0;i<(label==='idle'?1:label==='network-error'?128:64);i++){try{if(readFileSync(join(s.devices[name].vault,'throttle-'+label+'-'+i+'.md'),'utf8')!==`THROTTLE SENTINEL ${label} ${i}\n`)return false;}catch{return false;}}}}return true;},'both vaults exact bytes',120000);
 await restored('network-recovery','calm');
 if(readdirSync(s.devices.B.vault).filter(x=>x.startsWith('throttle-')&&x.endsWith('.md')).length!==257)throw Error('peer fixture count');
 result.peerFilesPreserved=257;
 const files=readdirSync(s.devices.A.vault).filter(x=>x.startsWith('throttle-')&&x.endsWith('.md'));if(files.length!==257)throw Error('local fixture count');
 for(const path of files){const m=/^throttle-(idle|cancel|unload|network-error)-(\d+)\.md$/.exec(path);if(!m||readFileSync(join(s.devices.A.vault,path),'utf8')!==`THROTTLE SENTINEL ${m[1]} ${m[2]}\n`)throw Error('local sentinel changed');}
 result.localFilesPreserved=files.length;result.result='SCENARIO_PASS';save();
 await c.evaluate(`window.electronWindow.restore();window.electronWindow.show();app.commands.executeCommandById('obsync-private-sync:status');return true;`);await c.screenshot('throttle-recovered-status');
 await b.evaluate(`const f=app.vault.getAbstractFileByPath('throttle-network-error-127.md');await app.workspace.getLeaf(false).openFile(f);return true;`);await b.screenshot('throttle-peer-note');
}catch(error){result.result='FAIL';result.reason=error.message;save();throw error;}finally{offline(false);c.close();b.close();}
console.log(JSON.stringify({result:result.result,cases:result.cases.length}));
