// First-run setup on the exact disposable native desktop. No secret-store writes.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {connect,targets,sleep} from './cdp.mjs';
import {boundManifest} from './desktop-guard.mjs';
import {click,fillSetting,fillPlaceholder,settingsShow,confirmPhrase,LABELS} from '../../ci/obsidian-drive.mjs';
const [run,source]=process.argv.slice(2);
const state=boundManifest(run,source);
let phase='open-owned-vault';
async function main(body,params={}){const c=await connect(state,'A');try{return await c.evaluate(body,params);}finally{c.close();}}
async function any(fn,...args){
  for(const target of await targets(state,'A')){
    const c=await connect(state,'A',false,target.id);
    try{const result=await c.evaluate(`return (${fn.toString()})(...P.args);`,{args},false);if(result)return result;}
    finally{c.close();}
  }
  return false;
}
async function until(read,budget=30000){const end=Date.now()+budget;while(Date.now()<end){if(await read())return;await sleep(100);}throw Error('stage deadline');}
const start=Date.now();
try{
  const chooser=await connect(state,'A',true);
  try{await chooser.evaluate("require('electron').ipcRenderer.sendSync('vault-open',P.vault,false);return true;",{},false);}
  catch(error){if(error.message!=='CDP disconnected')throw error;}
  finally{chooser.close();}
  await until(async()=>{try{return await main('return !!app.workspace?.layoutReady;');}catch{return false;}});
  phase='native-author-trust';await until(()=>any(click,LABELS.trust));
  phase='candidate-plugin-loaded';await until(()=>main("return !!app.plugins.plugins['obsync-private-sync']?.state;"));
  await main("app.setting.open();app.setting.openTabById('obsync-private-sync');return true;");
  phase='server-settings';await until(()=>any(settingsShow,LABELS.serverUrl));
  await until(()=>any(fillSetting,'settings',LABELS.serverUrl,state.url));
  await until(()=>main("return app.plugins.plugins['obsync-private-sync'].state.data.serverUrl===P.url;"));
  phase='initial-enrollment';
  const token=readFileSync(join(run,'runtime/server/journal/v1/setup-token'),'utf8').trim();
  await until(()=>any(fillPlaceholder,LABELS.setupToken,token));
  await until(()=>any(click,LABELS.setupButton));
  phase='native-backup-confirmation';await until(()=>any(confirmPhrase,LABELS.phraseDone));
  await until(()=>main("const s=app.plugins.plugins['obsync-private-sync'].state;return s.paired&&s.data.recoveryPhrase==='confirmed'&&s.custody2()?.phase==='active'&&s.custody2()?.suite===2;"));
  await main('app.setting.close();return true;');
  writeFileSync(join(run,'evidence/desktop-setup.json'),JSON.stringify({result:'PASS',sourceHead:state.source_head,phase:'complete',nativeStoreUnmodified:true,ordinaryEnrollmentControls:true,elapsedMs:Date.now()-start})+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({result:'PASS',phase:'desktop-setup'}));
}catch(error){
  writeFileSync(join(run,'evidence/desktop-setup.json'),JSON.stringify({result:'FAIL',sourceHead:state.source_head,phase,exceptionType:error.name,elapsedMs:Date.now()-start})+'\n',{flag:'wx',mode:0o600});
  process.exitCode=1;
}
