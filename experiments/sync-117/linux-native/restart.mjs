import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const harness=process.env.OBSYNC_LINUX_HARNESS;
const {connect,manifest,sleep,targets}=await import(pathToFileURL(join(harness,'cdp.mjs')));
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const run=process.argv[2],state=manifest(run),rows=[];
for(const name of ['A','B']) {
  const started=Date.now();
  for (const target of await targets(state,name)) {
  let c;
  try {c=await connect(state,name,false,target.id);}
  catch(e){if(e.cause?.code==='ECONNREFUSED')break;throw e;}
  try {
    const supported=await c.evaluate(`return typeof window.electronWindow?.close==='function';`,{},false);
    if(!supported)throw Error('native window close absent');
    try {await c.evaluate(`window.electronWindow.close(); return true;`,{},false);}
    catch(e){if(e.message!=='CDP disconnected')throw e;}
  } finally{c.close();}
  }
  const end=Date.now()+15000;let absent=false;
  while(Date.now()<end) {
    try{execFileSync('ps',['-p',String(state.processes[name].pid),'-o','pid='],{stdio:'ignore'});}
    catch{absent=true;break;}
    await sleep(100);
  }
  if(!absent)throw Error('native quit did not exit owned session');
  execFileSync('python3',['-B',join(harness,'lab.py'),'restart','--run',run,'--device',name],{stdio:'ignore'});
  Object.assign(state,manifest(run));
  let chooser; const readyBy=Date.now()+30000;
  while(Date.now()<readyBy) {
    try {chooser=await connect(state,name,true);break;}
    catch(e){if(e.cause?.code!=='ECONNREFUSED' && e.message!=='lab window not ready')throw e;}
    await sleep(100);
  }
  if(!chooser)throw Error('native app readiness deadline');
  try {await chooser.evaluate(`require('electron').ipcRenderer.sendSync('vault-open', P.vault, false); return true;`,{},false);}
  catch(e){if(e.message!=='CDP disconnected')throw e;}
  finally{chooser.close();}
  const deadline=Date.now()+60000;let ready=false;
  while(Date.now()<deadline) {
    let page;
    try {page=await connect(state,name);ready=await page.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];return p?.state.paired&&p.currentStatus().kind==='idle';`);}
    catch{}
    finally{page?.close();}
    if(ready)break;
    await sleep(200);
  }
  rows.push({device:name,nativeWindowClose:true,sessionExitedBeforeRestart:absent,pairedIdle:ready,elapsedMs:Date.now()-started});
  writeFileSync(run+'/evidence/graceful-restart.json',JSON.stringify(rows,null,2)+'\n');
  if(!ready)throw Error('paired idle after native quit deadline');
}
