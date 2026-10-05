import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [tooling,run,command]=process.argv.slice(2);
const {manifest,connect,sleep}=await import(pathToFileURL(resolve(tooling,'scripts/validation/lab/cdp.mjs')));
const state=manifest(run),c=await connect(state,'A');
const path='phone-live-roundtrip.md',text='Desktop control 42\n';
try {
 if(command==='create') {
  await c.evaluate(`if(document.querySelector('.modal-container')||app.vault.getAbstractFileByPath(P.path))throw Error('new native note precondition');const f=await app.vault.create(P.path,'');const leaf=app.workspace.getLeaf(false);await leaf.openFile(f,{state:{mode:'source'}});await wait(()=>!!leaf.view.editor,'native editor');leaf.view.editor.focus();leaf.view.editor.setCursor({line:0,ch:0});window.labPhoneInput={trusted:0,untrusted:0};window.labPhoneListener=e=>{window.labPhoneInput[e.isTrusted?'trusted':'untrusted']++;};document.addEventListener('beforeinput',window.labPhoneListener,true);return true;`,{path});
  let nativeInput;
  try{await c.insertText(text);}
  finally{nativeInput=await c.evaluate(`document.removeEventListener('beforeinput',window.labPhoneListener,true);const result=window.labPhoneInput;delete window.labPhoneInput;delete window.labPhoneListener;return result;`);}
  writeFileSync(join(run,'evidence','phone-peer-note-input.json'),JSON.stringify({path,nativeInput,at:new Date().toISOString()},null,2)+'\n',{mode:0o600});
  if(!nativeInput.trusted||nativeInput.untrusted)throw Error('trusted native input not proved');
  const native=await c.evaluate(`await wait(()=>app.workspace.getMostRecentLeaf()?.view?.file?.path===P.path&&app.workspace.getMostRecentLeaf().view.editor.getValue()===P.text,'native buffer');const identity=await wait(()=>app.plugins.plugins['obsync-private-sync'].state.fileByPath(P.path)?.fileId,'synced note identity',60000);return {editorMatches:true,nonemptyFileId:/^[a-f0-9]{32}$/.test(identity)};`,{path,text});
  const until=Date.now()+30000;let disk;
  while(Date.now()<until){disk=readFileSync(join(state.devices.A.vault,path),'utf8');if(disk===text)break;await sleep(100);}
  if(disk!==text||!native.nonemptyFileId)throw Error('independent disk or identity mismatch');
  const result={at:new Date().toISOString(),result:'PASS',path,text,bytes:Buffer.byteLength(disk),sha256:createHash('sha256').update(disk).digest('hex'),nativeInput,...native,independentDesktopDiskMatches:true,physicalPhoneReadback:'PENDING'};
  writeFileSync(join(run,'evidence','phone-peer-note-created.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
 } else if(command==='read') {
  const disk=readFileSync(join(state.devices.A.vault,path),'utf8');
  const native=await c.evaluate(`const view=app.workspace.getLeavesOfType('markdown').map(l=>l.view).find(v=>v.file?.path===P.path);return {editor:view?.editor?.getValue()??null,nonemptyFileId:/^[a-f0-9]{32}$/.test(app.plugins.plugins['obsync-private-sync'].state.fileByPath(P.path)?.fileId??'')};`,{path});
  console.log(JSON.stringify({path,text:disk,editorMatchesDisk:native.editor===disk,nonemptyFileId:native.nonemptyFileId,sha256:createHash('sha256').update(disk).digest('hex')}));
 } else throw Error('unknown command');
} catch {console.log(JSON.stringify({result:'FAIL',reason:'native note proof refused or timed out'}));process.exitCode=1;}
finally{c.close();}
